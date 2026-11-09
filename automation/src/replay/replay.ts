// Deterministic replay (Module 4, D-047). Runs a recorded workflow with new
// inputs and no LLM: every target is found by its recorded locator (exactly
// one match), every step goes through the shared step checkpoint (safety
// rules, "who is in control" check, log entry), and every checkpoint and
// success condition is verified, never assumed. Known interruptions and
// business outcomes are checked on every look at the page, so they are
// found before a checkpoint is reported as failed.
//
// With a human channel (Module 5, D-051), a stop a person can fix pauses the
// replay instead: the person works in the same live browser, then
// automation takes control back, looks at the page again and continues
// from the first step whose checkpoint does not already hold.

import { BrowserSession, type PageView } from "../browser.js";
import { StepCheckpoint } from "../checkpoint.js";
import type { ReplayConfig } from "../config.js";
import { ControlState, type ControlChange } from "../control.js";
import { Handoffs, type HandoffRecord, type HumanChannel } from "../handoff.js";
import { Redactor, SAVED_MASK_PATTERNS } from "../redact.js";
import { RunLog, type LogListener } from "../run-log.js";
import { bankSafetyRules, isApprovedPage } from "../safety.js";
import type { BusinessOutcomeRule, Condition, Target, Workflow, WorkflowStep } from "../workflow/schema.js";
import { allHold, describeCondition, describeLocator, holds, resolveTarget, type ConditionContext } from "./locate.js";

export type ReplayStatus = "SUCCESS" | "BUSINESS_OUTCOME" | "FAILED" | "NEEDS_HUMAN";
export type ReplayStopReason =
  | "TARGET_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "CHECKPOINT_FAILED"
  | "SUCCESS_CHECK_FAILED"
  | "BANK_ERROR"
  | "INTERRUPTION_LIMIT"
  | "INTERRUPTION_NOT_CLEARED"
  | "STEP_REFUSED"
  | "STEP_FAILED"
  | "UNEXPECTED_DIALOG"
  | "SAFETY_STOP"
  | "TIME_LIMIT"
  | "BROWSER_ERROR"
  | "UNEXPECTED_ERROR"
  | "HANDOFF_CANCELLED"
  | "HANDOFF_TIMEOUT"
  | "HANDOFF_SESSION_LOST"
  | "RESUME_FAILED";

// Stops a person may be able to fix in the live browser (H1). Bank errors,
// time limits, browser errors and a failed final success check are not.
const HANDOFF_STOPS: ReplayStopReason[] = [
  "UNEXPECTED_DIALOG",
  "SAFETY_STOP",
  "TARGET_NOT_FOUND",
  "AMBIGUOUS_TARGET",
  "CHECKPOINT_FAILED",
  "INTERRUPTION_NOT_CLEARED",
  "RESUME_FAILED",
];

export interface ReplayResult {
  runId: string;
  workflow: { name: string; version: string; status: "draft" | "reusable" };
  status: ReplayStatus;
  stopReason?: ReplayStopReason;
  reason?: string;
  outputs?: Record<string, string>; // fresh values read during this replay; SUCCESS only
  businessOutcome?: { code: string; message: string };
  failure?: { step: string; expected: string; observed: string };
  recovered: Array<{ id: string; description: string; times: number }>; // interruptions handled
  fallbacksUsed: Array<{ step: string; locator: string }>;
  checks: Array<{ check: string; passed: boolean }>; // final success conditions
  promotion?: { from: "draft"; to: "reusable" };
  handoffs?: HandoffRecord[]; // only when handoff is on
  control?: ControlChange[]; // who was in control, when; only when handoff is on
  metrics: { steps: number; llmCalls: 0; durationMs: number };
  runDir: string;
}

export class ReplayRefused extends Error {} // caller error: nothing was run

const POLL_MS = 250;
const SUCCESS_WAIT_MS = 5_000;

// Thrown inside the run to end it with a result.
class Stop {
  constructor(readonly result: Omit<ReplayResult, "runId" | "workflow" | "recovered" | "fallbacksUsed" | "checks" | "metrics" | "runDir"> & { checks?: ReplayResult["checks"] }) {}
}
class Restart {}

// Inputs must be exactly the declared ones (else the caller is refused) and
// match their declared format (else INVALID_INPUT, before any browser).
export function checkInputs(workflow: Workflow, inputs: Record<string, string>): { ok: true } | { ok: false; message: string } {
  const declared = Object.keys(workflow.inputs);
  const missing = declared.filter((name) => !(name in inputs));
  const extra = Object.keys(inputs).filter((name) => !declared.includes(name));
  if (missing.length > 0) throw new ReplayRefused(`Missing input(s): ${missing.join(", ")}. ${workflow.name} needs ${declared.join(", ")}.`);
  if (extra.length > 0) throw new ReplayRefused(`Unknown input(s): ${extra.join(", ")}. ${workflow.name} takes ${declared.join(", ")}.`);
  for (const [name, spec] of Object.entries(workflow.inputs)) {
    if (!new RegExp(spec.pattern).test(inputs[name]!)) {
      const rule = workflow.businessOutcomes.find((r) => r.code === "INVALID_INPUT");
      return { ok: false, message: rule?.message ?? `Invalid ${name}: ${spec.description}` };
    }
  }
  return { ok: true };
}

export async function replayWorkflow(
  workflow: Workflow,
  workflowStatus: "draft" | "reusable",
  inputs: Record<string, string>,
  config: ReplayConfig,
  options: {
    listener?: LogListener;
    promote?: () => { from: "draft"; to: "reusable" };
    openBrowser?: (headless: boolean) => Promise<BrowserSession>; // tests only: e.g. to delay a click
    handoff?: HumanChannel; // hand recoverable stops to a person in the same browser
  } = {},
): Promise<ReplayResult> {
  const inputCheck = checkInputs(workflow, inputs); // may throw ReplayRefused before a run folder exists
  const startedAt = Date.now();
  let deadline = startedAt + config.maxSeconds * 1000; // moved on by time a person was in control
  const log = RunLog.create(config.runsDir, options.listener);
  const control = new ControlState(log);
  let handoffs: Handoffs | undefined;
  const needsPerson = new Set<string>(); // steps the safety rules handed to a person
  const redactor = new Redactor(inputs, [config.username, config.password], config.sensitiveLabels);
  const recovered = new Map<string, { id: string; description: string; times: number }>();
  const fallbacksUsed: ReplayResult["fallbacksUsed"] = [];
  const outputs = new Map<string, { value: string; target: Target }>();
  let stepNumber = 0;
  let browser: BrowserSession | undefined;
  let lastView: PageView | undefined;

  log.write("replay_started", {
    runId: log.runId,
    workflow: { name: workflow.name, version: workflow.version, status: workflowStatus },
    inputs: Object.fromEntries(Object.keys(inputs).map((name) => [name, `<input:${name}>`])),
    settings: {
      bankUrl: config.bankUrl,
      maxSeconds: config.maxSeconds,
      headless: config.headless,
      saveFailureScreenshot: config.saveFailureScreenshot,
      riskyKeywords: config.riskyKeywords,
      sensitiveLabels: config.sensitiveLabels,
      handoff: options.handoff ? config.handoff : "off",
    },
  });

  const finish = async (stop: Stop): Promise<ReplayResult> => {
    const r = stop.result;
    const result: ReplayResult = {
      runId: log.runId,
      workflow: { name: workflow.name, version: workflow.version, status: workflowStatus },
      status: r.status,
      stopReason: r.stopReason,
      reason: r.reason === undefined ? undefined : redactor.forLog(r.reason),
      outputs: r.outputs,
      businessOutcome: r.businessOutcome,
      failure: r.failure && {
        step: r.failure.step,
        expected: redactor.forLog(r.failure.expected),
        observed: redactor.forLog(r.failure.observed),
      },
      recovered: [...recovered.values()],
      fallbacksUsed,
      checks: r.checks ?? [],
      handoffs: handoffs?.records,
      control: handoffs ? control.history : undefined,
      metrics: { steps: stepNumber, llmCalls: 0, durationMs: Date.now() - startedAt },
      runDir: log.dir,
    };
    if ((result.status === "FAILED" || result.status === "NEEDS_HUMAN") && browser) {
      const now = await browser.view().catch(() => undefined);
      if (now) lastView = now;
      if (config.saveFailureScreenshot && now) {
        const mask = browser.sensitiveRefs(config.sensitiveLabels, Object.values(inputs), SAVED_MASK_PATTERNS);
        await browser.screenshot(mask).then((png) => log.saveFailureScreenshot(png)).catch(() => {});
      }
      if (lastView) log.saveFailureSnapshot(redactor.pageForLog(lastView));
    }
    // Promotion (D-047 R2) only after a verified SUCCESS of this very
    // version that ran on its own: a person's help proves nothing about the
    // recorded steps (D-051 H6).
    if (result.status === "SUCCESS" && options.promote && result.handoffs?.length) {
      log.write("promotion_refused", { reason: "A person took control during this replay, so it does not show the workflow runs on its own." });
    } else if (result.status === "SUCCESS" && options.promote) {
      try {
        result.promotion = options.promote();
        result.workflow.status = "reusable";
        log.write("promoted", { workflow: workflow.name, version: workflow.version, ...result.promotion });
      } catch (error) {
        log.write("promotion_refused", { reason: errorText(error) });
      }
    }
    log.write("replay_finished", {
      status: result.status,
      stopReason: result.stopReason,
      reason: result.reason,
      outputs: result.outputs ? Object.keys(result.outputs) : undefined,
      businessOutcome: result.businessOutcome,
      failure: result.failure,
      recovered: result.recovered,
      fallbacksUsed: result.fallbacksUsed,
      checks: result.checks,
      promotion: result.promotion,
      handoffs: result.handoffs,
      control: result.control,
      metrics: result.metrics,
    });
    log.saveResult(result);
    return result;
  };

  if (!inputCheck.ok) {
    return finish(new Stop({ status: "BUSINESS_OUTCOME", businessOutcome: { code: "INVALID_INPUT", message: inputCheck.message } }));
  }

  try {
    browser = await (options.openBrowser ?? BrowserSession.open)(config.headless);
  } catch (error) {
    return finish(new Stop({ status: "FAILED", stopReason: "BROWSER_ERROR", reason: errorText(error) }));
  }
  const session = browser;
  const rules = bankSafetyRules({
    origin: config.bankUrl,
    riskyKeywords: config.riskyKeywords,
    sensitiveLabels: config.sensitiveLabels,
    allowLogout: false,
    declaredInputs: Object.keys(workflow.inputs),
    declaredOutputs: Object.keys(workflow.outputs),
  });
  const checkpoint = new StepCheckpoint({
    browser: session,
    rules,
    log,
    redactor,
    inputs,
    credentials: { username: config.username, password: config.password },
    source: "replay",
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
      source: "replay",
      workflow: { name: workflow.name, version: workflow.version },
      screenshot: config.saveFailureScreenshot
        ? () => session.screenshot(session.sensitiveRefs(config.sensitiveLabels, Object.values(inputs), SAVED_MASK_PATTERNS))
        : undefined,
    });
  }

  const handOff = (h: Handoffs, signal: Stop) =>
    handOffImpl(h, signal, (ms) => {
      deadline += ms;
      checkpoint.extendDeadline(ms);
    });

  const timeUp = (where: string) =>
    new Stop({ status: "FAILED", stopReason: "TIME_LIMIT", reason: `Replay time limit (${config.maxSeconds} s) reached ${where}.` });

  const context = async (): Promise<ConditionContext> => {
    const view = await session.view();
    lastView = view;
    return { path: view.path, elements: session.elements(), inputs, outputs };
  };

  const observed = (ctx: ConditionContext, conditions: Condition[] = []): string => {
    const headings = ctx.elements.filter((e) => e.info.role === "heading").map((e) => e.info.name ?? e.node.text);
    const failing = conditions
      .filter((c) => !holds(c, ctx))
      .map((c) => `not met: ${describeCondition(c)}`);
    return [`page ${ctx.path}`, `headings: ${headings.map((h) => JSON.stringify(h)).join(", ") || "none"}`, ...failing].join("; ");
  };

  // Run one UI step through the shared checkpoint and turn a problem into a result.
  const runStep = async (kind: "click" | "fill" | "read" | "navigate", args: Record<string, unknown>, stepId: string) => {
    // A step the safety rules handed to a person is never run by automation
    // afterwards (D-051 requirement 2), even if it is reached again.
    if (needsPerson.has(stepId)) throw personStepNotDone(stepId);
    stepNumber++;
    const { outcome } = await checkpoint.run(kind, { ...args, reason: `Replay step ${stepId}.` }, stepNumber);
    switch (outcome.status) {
      case "done":
        return;
      case "refused":
        throw new Stop({ status: "FAILED", stopReason: "STEP_REFUSED", reason: outcome.feedback, failure: { step: stepId, expected: "step allowed by the safety rules", observed: outcome.feedback } });
      case "failed":
        if (Date.now() >= deadline) throw timeUp("during a browser action");
        throw new Stop({ status: "FAILED", stopReason: "STEP_FAILED", reason: outcome.feedback, failure: { step: stepId, expected: "step runs in the browser", observed: outcome.feedback } });
      case "needs_human":
        needsPerson.add(stepId);
        throw new Stop({ status: "NEEDS_HUMAN", stopReason: "SAFETY_STOP", reason: outcome.reason, failure: { step: stepId, expected: "a person decides on this step", observed: outcome.reason } });
      default:
        throw new Stop({ status: "FAILED", stopReason: "UNEXPECTED_ERROR", reason: `Unexpected step outcome ${outcome.status}.` });
    }
  };

  // Look at the page: handle known interruptions (bounded by maxTimes),
  // stop on a business outcome, and hand back to a person on a dialog
  // nobody planned for. Returns the page once none of these apply.
  const look = async (phase: "login" | "main"): Promise<ConditionContext> => {
    for (;;) {
      if (Date.now() >= deadline) throw timeUp("while waiting for the page");
      const ctx = await context();
      const conditional = workflow.conditionalSteps.find(
        // While logging in, the session-expired notice on /login is expected.
        (c) => !(phase === "login" && c.action.kind === "login_and_restart") && allHold(c.when, ctx),
      );
      if (conditional) {
        const entry = recovered.get(conditional.id) ?? { id: conditional.id, description: conditional.description, times: 0 };
        if (entry.times >= conditional.maxTimes) {
          throw new Stop({ status: "FAILED", stopReason: "INTERRUPTION_LIMIT", reason: `"${conditional.id}" appeared more than ${conditional.maxTimes} time(s).`, failure: { step: conditional.id, expected: `at most ${conditional.maxTimes} time(s)`, observed: observed(ctx) } });
        }
        log.write("conditional_step", { id: conditional.id, action: conditional.action.kind, times: entry.times + 1 });
        const action = conditional.action;
        if (action.kind === "fail") {
          throw new Stop({ status: "FAILED", stopReason: "BANK_ERROR", reason: action.reason, failure: { step: conditional.id, expected: "no bank error", observed: observed(ctx) } });
        }
        entry.times++;
        recovered.set(conditional.id, entry);
        if (action.kind === "login_and_restart") throw new Restart();
        if (action.kind === "click") {
          const where = resolveTarget(ctx.elements, action.target);
          if (!where.ok) {
            throw new Stop({ status: "FAILED", stopReason: where.problem, failure: { step: conditional.id, expected: describeLocator(action.target.primary), observed: where.observed } });
          }
          await runStep("click", { ref: where.ref }, conditional.id);
        } else {
          const cleared = await poll(() => holdsNow(action.until), Math.min(action.timeoutSeconds * 1000, deadline - Date.now()));
          if (!cleared) {
            const now = await context();
            throw new Stop({ status: "FAILED", stopReason: "INTERRUPTION_NOT_CLEARED", failure: { step: conditional.id, expected: describeCondition(action.until), observed: observed(now, [action.until]) } });
          }
        }
        continue; // look again: the page has changed
      }
      const outcome = workflow.businessOutcomes.find((rule: BusinessOutcomeRule) => allHold(rule.when, ctx));
      if (outcome) throw new Stop({ status: "BUSINESS_OUTCOME", businessOutcome: { code: outcome.code, message: outcome.message } });
      if (ctx.elements.some((e) => e.info.role === "dialog")) {
        throw new Stop({ status: "NEEDS_HUMAN", stopReason: "UNEXPECTED_DIALOG", reason: "A dialog the workflow does not know about is open.", failure: { step: "(any)", expected: "no unknown dialog", observed: observed(ctx) } });
      }
      return ctx;
    }
  };

  const holdsNow = async (condition: Condition) => holds(condition, await context());

  // Repeat a check until it passes or time runs out.
  const poll = async (check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return true;
      if (Date.now() >= deadline) throw timeUp("while waiting for the page");
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  // Look at the page until `ready` gives an answer or the step's time is up.
  const waitFor = async <T>(phase: "login" | "main", timeoutSeconds: number, ready: (ctx: ConditionContext) => T | undefined) => {
    const until = Math.min(Date.now() + timeoutSeconds * 1000, deadline);
    for (;;) {
      const ctx = await look(phase);
      const answer = ready(ctx);
      if (answer !== undefined) return { answer, ctx };
      // Out of replay time is a time limit, not a missing target or checkpoint.
      if (Date.now() >= deadline) throw timeUp("while waiting for the page");
      if (Date.now() >= until) return { answer: undefined, ctx };
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  const runWorkflowStep = async (step: WorkflowStep, phase: "login" | "main") => {
    if (step.kind === "navigate") {
      await look(phase);
      await runStep("navigate", { path: step.path }, step.id);
    } else if (step.kind === "wait_for") {
      const { answer, ctx } = await waitFor(phase, step.timeoutSeconds, (c) => (holds(step.until, c) ? true : undefined));
      if (!answer) throw new Stop({ status: "FAILED", stopReason: "CHECKPOINT_FAILED", failure: { step: step.id, expected: describeCondition(step.until), observed: observed(ctx, [step.until]) } });
    } else {
      const { answer: where, ctx } = await waitFor(phase, step.timeoutSeconds, (c) => {
        const r = resolveTarget(c.elements, step.target);
        return r.ok || r.problem === "AMBIGUOUS_TARGET" ? r : undefined; // ambiguity never improves by waiting
      });
      if (!where || !where.ok) {
        const found = where ?? resolveTarget(ctx.elements, step.target);
        const problem = found.ok ? "TARGET_NOT_FOUND" : found.problem;
        throw new Stop({ status: "FAILED", stopReason: problem, failure: { step: step.id, expected: `exactly one ${describeLocator(step.target.primary)}`, observed: `${found.ok ? "" : found.observed}; ${observed(ctx)}` } });
      }
      if (where.used !== "primary") {
        fallbacksUsed.push({ step: step.id, locator: describeLocator(step.target.fallbacks[where.used.fallback - 1]!) });
        log.write("fallback_used", { step: step.id, fallback: where.used.fallback });
      }
      if (step.kind === "click") await runStep("click", { ref: where.ref }, step.id);
      if (step.kind === "fill") await runStep("fill", { ref: where.ref, value: step.value }, step.id);
      if (step.kind === "read") {
        await runStep("read", { ref: where.ref, output: step.output }, step.id);
        outputs.set(step.output, { value: checkpoint.captured.get(step.output)!.value, target: step.target });
      }
    }
    if (step.expect.length > 0) {
      const { answer, ctx } = await waitFor(phase, step.timeoutSeconds, (c) => (allHold(step.expect, c) ? true : undefined));
      if (!answer) {
        throw new Stop({ status: "FAILED", stopReason: "CHECKPOINT_FAILED", failure: { step: step.id, expected: step.expect.map(describeCondition).join(" and "), observed: observed(ctx, step.expect) } });
      }
    }
  };

  const plan = [
    ...workflow.login.map((step) => ({ step, phase: "login" as const })),
    ...workflow.steps.map((step) => ({ step, phase: "main" as const })),
  ];
  let position = 0; // index in plan of the step being run; plan.length = final checks

  const personStepNotDone = (stepId: string) =>
    new Stop({
      status: "FAILED",
      stopReason: "RESUME_FAILED",
      reason: `Step ${stepId} needs a person, and the page does not show it was completed; automation will not run it.`,
      failure: { step: stepId, expected: "the person completes this step (its checkpoint holds)", observed: "checkpoint not met, or the step has none to check" },
    });

  // After a handoff: check the page is still approved, look at it the usual
  // way (interruptions, business outcomes, unknown dialogs), then pass over
  // click steps whose checkpoint already holds. A holding checkpoint shows
  // the page is in the needed state, not that the person clicked anything;
  // their logged actions are separate evidence. Fill and read steps always
  // run again, so every output is read by automation itself.
  const resumeAt = async (from: number, record: HandoffRecord): Promise<number> => {
    const stepId = (i: number) => plan[i]?.step.id ?? "(success)";
    if (!isApprovedPage(rules, session.url())) {
      throw new Stop({ status: "FAILED", stopReason: "RESUME_FAILED", reason: "After the handoff the browser is on a page outside the approved area.", failure: { step: stepId(from), expected: "a page in the approved area", observed: `page ${new URL(session.url()).pathname}` } });
    }
    const ctx = await look(plan[from]?.phase ?? "main");
    let i = from;
    for (; i < plan.length; i++) {
      const step = plan[i]!.step;
      if ((step.kind !== "click" && step.kind !== "navigate") || step.expect.length === 0 || !allHold(step.expect, ctx)) break;
      record.stepsPassed.push(step.id);
    }
    log.write("resumed", { handoff: record.handoff, sessionId: session.sessionId, sessionOpen: session.isOpen(), from: stepId(i), stepsPassed: record.stepsPassed });
    if (i < plan.length && needsPerson.has(plan[i]!.step.id)) throw personStepNotDone(plan[i]!.step.id);
    return i;
  };

  const runAll = async (resume?: HandoffRecord): Promise<Stop> => {
    let i = 0;
    if (resume) i = await resumeAt(position, resume);
    else await session.goto(new URL(workflow.start.path, config.bankUrl).href);
    for (; i < plan.length; i++) {
      position = i;
      await runWorkflowStep(plan[i]!.step, plan[i]!.phase);
    }
    position = plan.length;
    // Success only when every final condition is verified on the page.
    let ctx = await look("main");
    const passed = await poll(async () => {
      ctx = await look("main");
      return allHold(workflow.success, ctx);
    }, SUCCESS_WAIT_MS);
    const checks = workflow.success.map((c) => ({ check: describeCondition(c), passed: holds(c, ctx) }));
    if (!passed) {
      return new Stop({ status: "FAILED", stopReason: "SUCCESS_CHECK_FAILED", checks, failure: { step: "(success)", expected: workflow.success.map(describeCondition).join(" and "), observed: observed(ctx, workflow.success) } });
    }
    return new Stop({ status: "SUCCESS", outputs: Object.fromEntries([...outputs].map(([name, o]) => [name, o.value])), checks });
  };

  try {
    let resume: HandoffRecord | undefined;
    for (;;) {
      try {
        return await finish(await runAll(resume));
      } catch (signal) {
        if (signal instanceof Stop && handoffs && HANDOFF_STOPS.includes(signal.result.stopReason!)) {
          resume = await handOff(handoffs, signal);
          continue;
        }
        if (!(signal instanceof Restart)) throw signal;
        resume = undefined;
        // Session expired: log in again and start the main steps over,
        // bounded by the conditional step's maxTimes (once). Values read
        // before the restart are discarded. Safe only because today's
        // workflows are read-only; a workflow with side effects must not
        // be restarted this way (D-047, lead engineer's clarification 2).
        outputs.clear();
        checkpoint.captured.clear();
      }
    }
  } catch (signal) {
    if (signal instanceof Stop) return await finish(signal);
    if (Date.now() >= deadline) return await finish(timeUp("during a browser action"));
    return await finish(new Stop({ status: "FAILED", stopReason: "BROWSER_ERROR", reason: errorText(signal) }));
  } finally {
    await session.close().catch(() => {});
  }
}

// Pass a stop to a person. Returns the handoff to resume from, or throws the
// Stop that ends the run (cancelled, timed out, window lost, limit reached).
async function handOffImpl(
  handoffs: Handoffs,
  signal: Stop,
  extend: (ms: number) => void,
): Promise<HandoffRecord> {
  const r = signal.result;
  if (!handoffs.canHandOff()) {
    throw new Stop({
      status: "FAILED",
      stopReason: "RESUME_FAILED",
      reason: `Handoff limit (${handoffs.records.length}) reached; the last problem was ${r.stopReason}${r.reason ? `: ${r.reason}` : ""}`,
      failure: r.failure,
    });
  }
  const record = await handoffs.handOff({ step: r.failure?.step, stopReason: r.stopReason, reason: r.reason ?? r.stopReason, expected: r.failure?.expected, observed: r.failure?.observed });
  extend(record.durationMs); // the replay time limit is paused while a person is in control
  switch (record.end) {
    case "done":
      return record;
    case "cancelled":
      throw new Stop({ status: "FAILED", stopReason: "HANDOFF_CANCELLED", reason: `The person cancelled the run during handoff ${record.handoff}.` });
    case "timeout":
      throw new Stop({ status: "NEEDS_HUMAN", stopReason: "HANDOFF_TIMEOUT", reason: `No answer from the person within the handoff time limit; a person is still in control.` });
    case "session_lost":
      throw new Stop({ status: "FAILED", stopReason: "HANDOFF_SESSION_LOST", reason: "The browser window was closed during the handoff." });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}
