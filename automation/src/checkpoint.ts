// Shared step checkpoint (D-027, D-039). Every automated UI step passes
// through here, in this order: check its shape → safety rules → "is
// automation in control?" → run it → write a log entry. Discovery and
// replay both use it; the control state is shared with the human handoff
// (Module 5), so no automated step runs while a person is in control.

import type { BrowserSession, ElementInfo } from "./browser.js";
import { ControlState, type Controller } from "./control.js";
import type { Redactor } from "./redact.js";
import type { RunLog } from "./run-log.js";
import { checkStep, isApprovedPage, type SafetyRules } from "./safety.js";
import { parseStep, type FillValue, type Step } from "./steps.js";

export type { Controller };

export interface CapturedOutput {
  value: string;
  ref: string;
  target: ElementInfo;
}

export type StepOutcome =
  | { status: "done"; feedback: string; logDetail?: string } // logDetail: saved form when it differs
  | { status: "invalid"; feedback: string } // reply did not match a UI step shape
  | { status: "refused"; feedback: string } // safety rules said no; nothing ran
  | { status: "failed"; feedback: string } // ran, but the browser reported an error
  | { status: "needs_human"; reason: string }
  | { status: "finish"; step: Extract<Step, { kind: "finish" }> };

export interface CheckpointOptions {
  browser: BrowserSession;
  rules: SafetyRules;
  log: RunLog;
  redactor: Redactor;
  inputs: Record<string, string>;
  credentials: { username: string; password: string };
  source: "discovery" | "replay";
  deadline: number; // epoch ms; no step may wait past it
  control?: ControlState; // shared with the handoff; a fresh one (automation) if not given
}

export class StepCheckpoint {
  private readonly control: ControlState;
  readonly captured = new Map<string, CapturedOutput>();

  constructor(private readonly options: CheckpointOptions) {
    this.control = options.control ?? new ControlState();
  }

  whoIsInControl(): Controller {
    return this.control.owner;
  }

  // Time a person spent in control does not count against the run's limit.
  extendDeadline(ms: number): void {
    this.options.deadline += ms;
  }

  async run(kind: string, args: unknown, stepNumber: number): Promise<{ step?: Step; outcome: StepOutcome }> {
    const { browser, rules, log, redactor } = this.options;
    const started = Date.now();
    const page = new URL(browser.url()).pathname;

    const parsed = parseStep(kind, args);
    if (!parsed.ok) {
      const outcome: StepOutcome = { status: "invalid", feedback: `Invalid step: ${parsed.error}` };
      log.write("step", {
        step: stepNumber,
        source: this.options.source,
        kind,
        page,
        outcome: outcome.status,
        detail: redactor.forLog(outcome.feedback),
      });
      return { outcome };
    }
    const step = parsed.step;
    const target = "ref" in step ? browser.describe(step.ref) : undefined;
    const verdict = checkStep(rules, step, {
      currentUrl: browser.url(),
      target,
      targetIsSecret: "ref" in step ? browser.isSecret(step.ref) : false,
    });

    let outcome: StepOutcome;
    if (verdict.verdict === "refuse") {
      outcome = { status: "refused", feedback: `Refused: ${verdict.reason}` };
    } else if (verdict.verdict === "needs_human") {
      outcome = { status: "needs_human", reason: verdict.reason };
    } else if (this.control.owner !== "automation") {
      outcome = { status: "needs_human", reason: "Automation is not in control of the browser." };
    } else {
      outcome = await this.execute(step, target);
    }

    log.write("step", {
      step: stepNumber,
      source: this.options.source,
      controlEpoch: this.control.epoch,
      kind: step.kind,
      page,
      target: target && redactTarget(target, redactor),
      value: step.kind === "fill" ? this.describeValue(step.value) : undefined,
      output: step.kind === "read" ? step.output : undefined,
      waitFor: step.kind === "wait_for" ? { text: redactor.forLog(step.text), state: step.state } : undefined,
      path: step.kind === "navigate" ? redactor.forLog(step.path) : undefined,
      reason: "reason" in step ? redactor.forLog(step.reason) : redactor.forLog(step.kind === "finish" ? step.summary : ""),
      safety: verdict.verdict,
      outcome: outcome.status,
      detail:
        outcome.status === "done" && outcome.logDetail
          ? outcome.logDetail
          : "feedback" in outcome
            ? redactor.forLog(outcome.feedback)
            : "reason" in outcome
              ? redactor.forLog(outcome.reason)
              : undefined,
      durationMs: Date.now() - started,
    });
    return { step, outcome };
  }

  private async execute(step: Step, target: ElementInfo | undefined): Promise<StepOutcome> {
    const { browser, rules, redactor } = this.options;
    try {
      switch (step.kind) {
        case "click":
          await browser.click(step.ref);
          break;
        case "fill":
          await browser.fill(step.ref, this.resolveValue(step.value));
          break;
        case "read": {
          const value = await browser.readText(step.ref);
          if (!value) return { status: "failed", feedback: "That element has no text to read." };
          this.captured.set(step.output, { value, ref: step.ref, target: target! });
          break;
        }
        case "wait_for": {
          const timeoutMs = Math.min(step.timeout_seconds * 1000, this.options.deadline - Date.now());
          if (timeoutMs <= 0) return { status: "failed", feedback: "No time left to wait." };
          await browser.waitForText(step.text, step.state, timeoutMs);
          break;
        }
        case "navigate":
          await browser.goto(new URL(step.path, rules.origin).href);
          break;
        case "request_human":
          return { status: "needs_human", reason: step.reason };
        case "finish":
          return { status: "finish", step };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      return { status: "failed", feedback: redactor.forLlm(`The step failed: ${message}`) };
    }
    if (!isApprovedPage(rules, browser.url())) {
      return { status: "needs_human", reason: "The step led to a page outside the approved area." };
    }
    if (step.kind === "read") {
      const value = this.captured.get(step.output)!.value;
      // Redact before quoting: escaped line breaks ("\n10042") would hide word boundaries.
      return {
        status: "done",
        feedback: `Captured output "${step.output}" = ${JSON.stringify(redactor.forLlm(value))}.`,
        logDetail: `Captured output "${step.output}" = ${JSON.stringify(redactor.forLog(value))}.`,
      };
    }
    return { status: "done", feedback: "Done." };
  }

  private resolveValue(value: FillValue): string {
    if ("input" in value) return this.options.inputs[value.input] ?? "";
    if ("credential" in value) return this.options.credentials[value.credential];
    return value.text;
  }

  // Saved form of a typed value: names, never the secret or input value itself.
  private describeValue(value: FillValue): Record<string, string> {
    if ("text" in value) return { text: this.options.redactor.forLog(value.text) };
    return value;
  }
}

// Saved form of a target element: role as is, every text field redacted.
export function redactTarget(target: ElementInfo, redactor: Redactor): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(target)) {
    if (value !== undefined) out[key] = key === "role" ? value : redactor.forLog(String(value));
  }
  return out;
}
