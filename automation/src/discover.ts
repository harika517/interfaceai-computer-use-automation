// LLM-driven discovery (Module 2). Loop: look at the page → the LLM picks
// one UI step → the shared checkpoint checks and runs it. Stops on finish,
// a request for a person, a risky step, or any limit (D-039). A claimed
// result is checked against the final page before it counts.
//
// With a human channel (Module 5, D-051), a stop that needs a person pauses
// the loop instead: the person works in the same live browser, hands
// control back, and the loop looks at the page again and carries on.

import { BrowserSession, type PageNode, type PageView } from "./browser.js";
import { StepCheckpoint, redactTarget, type CapturedOutput } from "./checkpoint.js";
import { describeConfig, type DiscoveryConfig } from "./config.js";
import { ControlState, type ControlChange } from "./control.js";
import { Handoffs, type HandoffRecord, type HumanChannel } from "./handoff.js";
import { LlmError, type LlmProvider } from "./llm/provider.js";
import { Redactor, SAVED_MASK_PATTERNS, pageKey } from "./redact.js";
import { RunLog, type LogListener } from "./run-log.js";
import { CONTROL_ROLES, bankSafetyRules } from "./safety.js";
import { CURRENCY, parseStep, stepTools, type Step } from "./steps.js";

export type OutputType = "currency" | "text";

export interface DiscoveryTask {
  goal: string;
  inputs: Record<string, string>;
  outputs: Record<string, OutputType>;
  allowLogout: boolean;
}

export type RunStatus = "SUCCESS" | "BUSINESS_OUTCOME" | "NEEDS_HUMAN" | "FAILED";
export type StopReason =
  | "STEP_LIMIT"
  | "TIME_LIMIT"
  | "LLM_CALL_LIMIT"
  | "REPEATED_STEP"
  | "CONSECUTIVE_FAILURES"
  | "LLM_ERROR"
  | "VERIFICATION_FAILED"
  | "BROWSER_ERROR"
  | "UNEXPECTED_ERROR"
  | "HANDOFF_CANCELLED"
  | "HANDOFF_TIMEOUT"
  | "HANDOFF_SESSION_LOST";

export interface Check {
  check: string;
  passed: boolean;
  detail?: string;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  stopReason?: StopReason;
  reason?: string;
  outputs?: Record<string, string>;
  businessOutcome?: { code: string; message: string };
  verification?: { passed: boolean; checks: Check[] };
  handoffs?: HandoffRecord[]; // only when handoff is on
  control?: ControlChange[]; // who was in control, when; only when handoff is on
  metrics: {
    steps: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
  };
  model: { provider: string; requested: string; actual: string[] };
  runDir: string;
}

const HISTORY_LINES = 10;

const SYSTEM_PROMPT = `You operate a web application for a back-office employee, one UI step at a time, to reach a goal.

Each turn you get the goal, the declared inputs and outputs, the steps so far with their results, and the current page as an accessibility snapshot. Elements you can act on have [ref=...]. Choose exactly one step by calling one tool.

Rules:
- Use only refs from the current page. Refs change when the page changes.
- Values shown as <input:name> are the declared inputs. Type them with fill value {"input": "name"}. Never type them as text.
- On a login page, use fill value {"credential": "username"} and {"credential": "password"}. You never see credentials.
- Capture every declared output with a read step on the element that shows it, then call finish with status "success".
- If the page shows a business message instead (invalid input, not found, no account on file, permission denied, closed account), call finish with status "business_outcome", the matching outcome_code and evidence_ref pointing at the message.
- If a loading message is shown, use wait_for until it is hidden. If a popup or notice blocks the page, deal with it first.
- If you are sent back to the login page, log in again and continue.
- Do not click features unrelated to the goal. Some actions need a person's approval and will stop the run.
- If you cannot make progress safely, call request_human with the reason.
- Never invent values. Only text captured by read counts as an output.`;

export async function discover(
  task: DiscoveryTask,
  config: DiscoveryConfig,
  provider: LlmProvider,
  listener?: LogListener,
  options: { handoff?: HumanChannel } = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  let deadline = startedAt + config.limits.maxSeconds * 1000; // moved on by time a person was in control
  const log = RunLog.create(config.runsDir, listener);
  const control = new ControlState(log);
  let handoffs: Handoffs | undefined;
  const redactor = new Redactor(task.inputs, [config.username, config.password, config.llm.apiKey], config.sensitiveLabels);
  const rules = bankSafetyRules({
    origin: config.bankUrl,
    riskyKeywords: config.riskyKeywords,
    sensitiveLabels: config.sensitiveLabels,
    allowLogout: task.allowLogout,
    declaredInputs: Object.keys(task.inputs),
    declaredOutputs: Object.keys(task.outputs),
  });
  const { limits } = config;
  const metrics = { steps: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, durationMs: 0 };
  const modelsUsed = new Set<string>();
  const inputValues = Object.values(task.inputs);

  log.write("run_started", {
    runId: log.runId,
    goal: redactor.forLog(task.goal),
    inputs: Object.fromEntries(Object.entries(task.inputs).map(([k, v]) => [k, redactor.forLog(v)])),
    outputs: task.outputs,
    allowLogout: task.allowLogout,
    settings: { ...describeConfig(config), handoff: options.handoff ? config.handoff : "off" },
  });

  let browser: BrowserSession | undefined;
  let lastView: PageView | undefined;
  let finishing = false;

  const finishRun = async (partial: Omit<RunResult, "runId" | "metrics" | "model" | "runDir">): Promise<RunResult> => {
    finishing = true;
    metrics.durationMs = Date.now() - startedAt;
    metrics.estimatedCostUsd = Number(
      (
        (metrics.inputTokens / 1e6) * config.llm.priceInputPerMTok +
        (metrics.outputTokens / 1e6) * config.llm.priceOutputPerMTok
      ).toFixed(6),
    );
    const result: RunResult = {
      runId: log.runId,
      ...partial,
      // Reasons can carry LLM-written text or element text: same rules as logs.
      reason: partial.reason === undefined ? undefined : redactor.forLog(partial.reason),
      handoffs: handoffs?.records,
      control: handoffs ? control.history : undefined,
      metrics,
      model: { provider: provider.name, requested: provider.model, actual: [...modelsUsed] },
      runDir: log.dir,
    };
    if ((result.status === "FAILED" || result.status === "NEEDS_HUMAN") && browser) {
      // Snapshot where the browser is now, not where it was before the last step.
      const now = await browser.view().catch(() => undefined);
      if (now) lastView = now;
      if (config.saveFailureScreenshot && now) {
        const mask = browser.sensitiveRefs(config.sensitiveLabels, inputValues, SAVED_MASK_PATTERNS);
        await browser.screenshot(mask).then((png) => log.saveFailureScreenshot(png)).catch(() => {});
      }
    }
    if ((result.status === "FAILED" || result.status === "NEEDS_HUMAN") && lastView) {
      log.saveFailureSnapshot(redactor.pageForLog(lastView));
    }
    log.write("run_finished", {
      status: result.status,
      stopReason: result.stopReason,
      reason: result.reason,
      outputs: result.outputs ? Object.keys(result.outputs) : undefined,
      businessOutcome: result.businessOutcome,
      verification: result.verification,
      handoffs: result.handoffs,
      control: result.control,
      metrics,
      model: result.model,
    });
    log.saveResult(result);
    return result;
  };

  const loop = async (): Promise<RunResult> => {
    try {
      browser = await BrowserSession.open(config.headless);
      await browser.goto(config.bankUrl);
    } catch (error) {
      return finishRun({ status: "FAILED", stopReason: "BROWSER_ERROR", reason: errorText(error) });
    }
    const session = browser;

    const checkpoint = new StepCheckpoint({
      browser: session,
      rules,
      log,
      redactor,
      inputs: task.inputs,
      credentials: { username: config.username, password: config.password },
      source: "discovery",
      deadline,
      control,
    });
    if (options.handoff) {
      handoffs = new Handoffs({
        browser: session,
        control,
        log,
        redactor,
        channel: options.handoff,
        settings: config.handoff,
        source: "discovery",
        screenshot: config.saveFailureScreenshot
          ? () => session.screenshot(session.sensitiveRefs(config.sensitiveLabels, inputValues, SAVED_MASK_PATTERNS))
          : undefined,
      });
    }
    const tools = stepTools();
    const goal = redactor.forLlm(task.goal);
    const history: string[] = [];
    let consecutiveFailures = 0;
    let previous: { signature: string; pageKey: string } | undefined;
    const timeUp = () => finishRun({ status: "FAILED", stopReason: "TIME_LIMIT" });

    while (true) {
      if (Date.now() >= deadline) return timeUp();
      if (metrics.steps >= limits.maxSteps) return finishRun({ status: "FAILED", stopReason: "STEP_LIMIT" });
      if (metrics.llmCalls >= limits.maxLlmCalls) return finishRun({ status: "FAILED", stopReason: "LLM_CALL_LIMIT" });

      let view: PageView;
      try {
        view = await session.view();
      } catch (error) {
        return finishRun({ status: "FAILED", stopReason: "BROWSER_ERROR", reason: errorText(error) });
      }
      lastView = view;

      const missing = Object.keys(task.outputs).filter((name) => !checkpoint.captured.has(name));
      const user = [
        `Goal: ${goal}`,
        ...(missing.length === 0
          ? ['Every declared output is captured. Call finish with status "success" now, unless the page shows a problem.']
          : []),
        `Declared inputs: ${Object.keys(task.inputs).map((name) => `<input:${name}>`).join(", ") || "none"}`,
        `Declared outputs: ${Object.entries(task.outputs).map(([name, type]) => `${name} (${type})`).join(", ") || "none"}`,
        `Captured so far: ${[...checkpoint.captured.keys()].join(", ") || "nothing"}`,
        `Budget left: ${limits.maxSteps - metrics.steps} steps, ${Math.round((deadline - Date.now()) / 1000)} seconds`,
        `Steps so far:\n${history.slice(-HISTORY_LINES).join("\n") || "(none)"}`,
        `Current page:\n${redactor.pageForLlm(view)}`,
      ].join("\n\n");

      const screenshotPng = config.screenshotsForLlm
        ? await session.screenshot(session.sensitiveRefs(config.sensitiveLabels, inputValues))
        : undefined;
      const timeLeftMs = deadline - Date.now();
      if (timeLeftMs <= 0) return timeUp();

      metrics.llmCalls++;
      let reply;
      try {
        reply = await provider.nextStep({
          system: SYSTEM_PROMPT,
          user,
          screenshotPng,
          // Once every output is captured, only finishing or asking a person
          // is offered, so the LLM cannot re-read the same value (live run 8).
          tools: missing.length === 0 ? tools.filter((t) => t.name === "finish" || t.name === "request_human") : tools,
          timeoutMs: Math.min(60_000, timeLeftMs),
        });
      } catch (error) {
        log.write("llm_call", { call: metrics.llmCalls, error: redactor.forLog(errorText(error)) });
        if (Date.now() >= deadline) return timeUp();
        return finishRun({
          status: "FAILED",
          stopReason: "LLM_ERROR",
          reason: error instanceof LlmError ? error.message : "LLM call failed.",
        });
      }
      modelsUsed.add(reply.model);
      metrics.inputTokens += reply.usage.inputTokens;
      metrics.outputTokens += reply.usage.outputTokens;
      log.write("llm_call", {
        call: metrics.llmCalls,
        model: reply.model,
        inputTokens: reply.usage.inputTokens,
        outputTokens: reply.usage.outputTokens,
        finishReason: reply.finishReason ?? null,
        tool: reply.toolName ?? null,
      });
      // The reply may arrive after the deadline: never act on it then.
      if (Date.now() >= deadline) return timeUp();

      const kind = reply.toolName ?? "(no step chosen)";
      const signature = stepSignature(kind, reply.args);
      const key = pageKey(view);
      if (previous && previous.signature === signature && previous.pageKey === key) {
        log.write("step_blocked", {
          step: metrics.steps + 1,
          kind,
          ...blockedStepDetails(kind, reply.args, session, redactor),
          reason: "Same step as before on an unchanged page.",
        });
        return finishRun({
          status: "FAILED",
          stopReason: "REPEATED_STEP",
          reason: `The LLM chose the same "${kind}" step again on an unchanged page.`,
        });
      }
      previous = { signature, pageKey: key };

      metrics.steps++;
      const { step, outcome } = await checkpoint.run(kind, reply.args, metrics.steps);

      switch (outcome.status) {
        case "done":
          consecutiveFailures = 0;
          history.push(`${metrics.steps}. ${describeStep(step!, session, redactor)} → ${outcome.feedback}`);
          break;
        case "invalid":
        case "refused":
        case "failed": {
          consecutiveFailures++;
          const what = step ? describeStep(step, session, redactor) : kind;
          history.push(`${metrics.steps}. ${what} → ${outcome.feedback}`);
          if (consecutiveFailures >= limits.maxFailures) {
            return finishRun({ status: "FAILED", stopReason: "CONSECUTIVE_FAILURES", reason: outcome.feedback });
          }
          break;
        }
        case "needs_human": {
          if (!handoffs) return finishRun({ status: "NEEDS_HUMAN", reason: outcome.reason });
          if (!handoffs.canHandOff()) {
            return finishRun({ status: "NEEDS_HUMAN", reason: `Handoff limit (${handoffs.records.length}) reached; ${outcome.reason}` });
          }
          // Pause the loop: no LLM call and no step while the person has control.
          const record = await handoffs.handOff({ step: step ? `step ${metrics.steps} (${step.kind})` : undefined, reason: outcome.reason });
          deadline += record.durationMs;
          checkpoint.extendDeadline(record.durationMs);
          if (record.end === "cancelled") return finishRun({ status: "FAILED", stopReason: "HANDOFF_CANCELLED", reason: `The person cancelled the run during handoff ${record.handoff}.` });
          if (record.end === "timeout") return finishRun({ status: "NEEDS_HUMAN", stopReason: "HANDOFF_TIMEOUT", reason: "No answer from the person within the handoff time limit; a person is still in control." });
          if (record.end === "session_lost") return finishRun({ status: "FAILED", stopReason: "HANDOFF_SESSION_LOST", reason: "The browser window was closed during the handoff." });
          // Back in control: the next turn looks at the page afresh. The LLM
          // is told a person helped, never what they typed or saw.
          history.push(
            `${metrics.steps}. ${step ? describeStep(step, session, redactor) : kind} → A person took control (${redactor.forLlm(outcome.reason)}) and has handed control back. Look at the current page again; do not repeat a step that needed a person.`,
          );
          previous = undefined;
          consecutiveFailures = 0;
          break;
        }
        case "finish": {
          const verification = verifyFinish(outcome.step, view, checkpoint.captured, task, redactor);
          if (!verification.passed) {
            return finishRun({ status: "FAILED", stopReason: "VERIFICATION_FAILED", verification });
          }
          if (outcome.step.status === "success") {
            return finishRun({
              status: "SUCCESS",
              outputs: Object.fromEntries([...checkpoint.captured].map(([name, c]) => [name, c.value])),
              verification,
            });
          }
          return finishRun({
            status: "BUSINESS_OUTCOME",
            businessOutcome: { code: outcome.step.outcome_code!, message: verification.message ?? "" },
            verification: { passed: verification.passed, checks: verification.checks },
          });
        }
      }
    }
  };

  try {
    return await loop();
  } catch (error) {
    // Anything unexpected still ends as a recorded FAILED run.
    if (finishing) throw error;
    return await finishRun({ status: "FAILED", stopReason: "UNEXPECTED_ERROR", reason: errorText(error) });
  } finally {
    await browser?.close().catch(() => {});
  }
}

// Check a claimed result against the page the LLM was looking at.
export function verifyFinish(
  step: Extract<Step, { kind: "finish" }>,
  view: PageView,
  captured: Map<string, CapturedOutput>,
  task: DiscoveryTask,
  redactor: Redactor,
): { passed: boolean; checks: Check[]; message?: string } {
  const checks: Check[] = [];

  if (step.status === "business_outcome") {
    // The evidence must be a plain text message on the page, not a control.
    const found = step.evidence_ref ? findByRef(view.nodes, step.evidence_ref) : undefined;
    const text = found?.node.text?.trim();
    const isMessage = Boolean(found && text && !CONTROL_ROLES.includes(found.node.role));
    checks.push({
      check: "business outcome message is shown on the page",
      passed: isMessage,
      detail: !found ? "evidence_ref missing or not on the page" : isMessage ? redactor.forLog(text!) : "evidence is not a text message",
    });
    return { passed: checks.every((c) => c.passed), checks, message: isMessage ? redactor.forLog(text!) : undefined };
  }

  for (const [name, value] of Object.entries(task.inputs)) {
    const shown = someNode(view.nodes, (n) => n.role !== "textbox" && n.text?.trim() === value.trim());
    checks.push({ check: `input ${name} is shown on the result page`, passed: shown });
  }

  for (const [name, type] of Object.entries(task.outputs)) {
    const capture = captured.get(name);
    if (!capture) {
      checks.push({ check: `output ${name} was captured by a read step`, passed: false });
      continue;
    }
    checks.push({ check: `output ${name} was captured by a read step`, passed: true });

    // A control's label (e.g. the "Edit Profile" button) is never an output value.
    checks.push({
      check: `output ${name} was read from page text, not a control`,
      passed: !CONTROL_ROLES.includes(capture.target.role),
      detail: capture.target.role,
    });

    // The element that was read must still show the same text in the same section.
    const same = findByRef(view.nodes, capture.ref);
    const stillShown =
      same?.node.text === capture.value ||
      allPaths(view.nodes).some((p) => p.node.text === capture.value && nearestHeading(p.ancestors) === capture.target.heading);
    checks.push({ check: `output ${name} is still shown on the page`, passed: stillShown });

    // Section rule (D-041): output names start with their section, and the
    // element that was read must sit under a heading naming it.
    const subject = name.split("_")[0]!.toLowerCase();
    const heading = capture.target.heading ?? "";
    checks.push({
      check: `output ${name} was read under a heading naming "${subject}"`,
      passed: heading.toLowerCase().includes(subject),
      detail: heading ? redactor.forLog(heading) : "no section heading",
    });

    if (type === "currency") {
      checks.push({ check: `output ${name} looks like an amount`, passed: CURRENCY.test(capture.value) });
    }
  }
  return { passed: checks.every((c) => c.passed), checks };
}

interface NodePath {
  node: PageNode;
  ancestors: PageNode[]; // closest first
}

function allPaths(nodes: PageNode[], ancestors: PageNode[] = []): NodePath[] {
  const out: NodePath[] = [];
  for (const node of nodes) {
    out.push({ node, ancestors });
    if (node.children) out.push(...allPaths(node.children, [node, ...ancestors]));
  }
  return out;
}

function findByRef(nodes: PageNode[], ref: string): NodePath | undefined {
  return allPaths(nodes).find((p) => p.node.ref === ref);
}

function someNode(nodes: PageNode[], test: (node: PageNode) => boolean): boolean {
  return allPaths(nodes).some((p) => test(p.node));
}

// The heading of the closest section that contains the element.
function nearestHeading(ancestors: PageNode[]): string | undefined {
  for (const ancestor of ancestors) {
    const heading = ancestor.children?.find((child) => child.role === "heading");
    if (heading) return heading.name ?? heading.text;
  }
  return undefined;
}

// What a blocked step would have acted on, redacted like a step log entry:
// the element, and for a fill only the input or credential name (free text redacted).
function blockedStepDetails(kind: string, args: unknown, browser: BrowserSession, redactor: Redactor): Record<string, unknown> {
  const parsed = parseStep(kind, args);
  if (!parsed.ok) return {};
  const step = parsed.step;
  const target = "ref" in step ? browser.describe(step.ref) : undefined;
  return {
    target: target && redactTarget(target, redactor),
    value: step.kind === "fill" ? ("text" in step.value ? { text: redactor.forLog(step.value.text) } : step.value) : undefined,
    output: step.kind === "read" ? step.output : undefined,
    path: step.kind === "navigate" ? redactor.forLog(step.path) : undefined,
  };
}

// What makes two steps "the same": kind, target element and values; the
// reason text is ignored. Only compared when the page is unchanged, and on
// an unchanged page element references are stable, so the reference itself
// identifies the element (many text elements share role "generic" and no name).
function stepSignature(kind: string, args: unknown): string {
  const { reason: _r, summary: _s, ...rest } = (typeof args === "object" && args ? args : {}) as Record<string, unknown>;
  return JSON.stringify({ kind, rest });
}

function describeStep(step: Step, browser: BrowserSession, redactor: Redactor): string {
  const target = "ref" in step ? browser.describe(step.ref) : undefined;
  const element = target
    ? ` ${target.role}${target.name ? ` "${target.name}"` : target.label ? ` (after "${target.label}")` : ""}`
    : "";
  switch (step.kind) {
    case "fill":
      return `fill${redactor.forLlm(element)} with ${JSON.stringify("text" in step.value ? { text: redactor.forLlm(step.value.text) } : step.value)}`;
    case "read":
      return redactor.forLlm(`read${element} as ${step.output}`);
    case "wait_for":
      return `wait_for ${JSON.stringify(redactor.forLlm(step.text))} ${step.state}`;
    case "navigate":
      return `navigate ${step.path}`;
    default:
      return `${step.kind}${element}`;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}
