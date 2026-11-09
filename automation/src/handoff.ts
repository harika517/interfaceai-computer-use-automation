// Human handoff (Module 5, D-051). When a run cannot safely continue, a
// person takes over the same live browser window: automation hands over
// control, records what the person does (redacted, never typed values),
// waits for the person to say "done" or "cancel" (or for the timeout or a
// closed window), and only then takes control back. Replay and discovery
// use this same piece; what happens after a handoff is up to them.

import { createInterface } from "node:readline";
import type { BrowserSession, HumanEvent } from "./browser.js";
import type { HandoffSettings } from "./config.js";
import type { ControlState } from "./control.js";
import type { Redactor } from "./redact.js";
import type { RunLog } from "./run-log.js";

// What the person is told, also saved as handoff-N.json (all text redacted).
export interface InterventionRequest {
  handoff: number;
  maxHandoffs: number;
  source: "replay" | "discovery";
  workflow?: { name: string; version: string };
  step?: string;
  stopReason?: string;
  reason: string;
  expected?: string;
  observed?: string;
  path: string;
  sessionId: string;
  timeoutSeconds: number;
  snapshot: string;
  screenshot?: string; // file name in the run folder
}

export type HumanAnswer = "done" | "cancel";

// How the person says they are finished. The terminal is the real one;
// tests use a scripted person acting on the same live page.
export interface HumanChannel {
  // Must stop waiting (and release anything it holds) when `signal` aborts.
  waitForPerson(request: InterventionRequest, session: BrowserSession, signal: AbortSignal): Promise<HumanAnswer>;
}

export type HandoffEnd = "done" | "cancelled" | "timeout" | "session_lost";

export interface HandoffRecord {
  handoff: number;
  step?: string;
  stopReason?: string;
  reason: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  end: HandoffEnd;
  humanActions: number; // recorded actions; evidence only, never proof of a step
  sessionId: string;
  stepsPassed: string[]; // filled in by replay: steps whose checkpoint already held on resume
}

export interface HandoffProblem {
  step?: string;
  stopReason?: string;
  reason?: string;
  expected?: string;
  observed?: string;
}

export class Handoffs {
  readonly records: HandoffRecord[] = [];

  constructor(
    private readonly options: {
      browser: BrowserSession;
      control: ControlState;
      log: RunLog;
      redactor: Redactor;
      channel: HumanChannel;
      settings: HandoffSettings;
      source: "replay" | "discovery";
      workflow?: { name: string; version: string };
      screenshot?: () => Promise<Buffer | undefined>; // masked; only when that setting is on
    },
  ) {}

  canHandOff(): boolean {
    return this.records.length < this.options.settings.maxHandoffs;
  }

  // Hand the live browser to a person and wait. Control returns to
  // automation only when the person says "done" and the window is still open.
  async handOff(problem: HandoffProblem): Promise<HandoffRecord> {
    const { browser, control, log, redactor, channel, settings } = this.options;
    const number = this.records.length + 1;
    const started = Date.now();
    const view = await browser.view().catch(() => undefined);
    const safe = (text?: string) => (text === undefined ? undefined : redactor.forLog(text));
    const request: InterventionRequest = {
      handoff: number,
      maxHandoffs: settings.maxHandoffs,
      source: this.options.source,
      workflow: this.options.workflow,
      step: problem.step,
      stopReason: problem.stopReason,
      reason: safe(problem.reason) ?? "Automation cannot continue safely.",
      expected: safe(problem.expected),
      observed: safe(problem.observed),
      path: view?.path ?? "(unknown)",
      sessionId: browser.sessionId,
      timeoutSeconds: settings.timeoutSeconds,
      snapshot: view ? redactor.pageForLog(view) : "(page could not be read)",
    };
    const png = await this.options.screenshot?.().catch(() => undefined);
    if (png) request.screenshot = log.saveFile(`handoff-${number}.png`, png);
    const file = log.saveFile(`handoff-${number}.json`, `${JSON.stringify(request, null, 2)}\n`);
    log.write("handoff_requested", {
      handoff: number,
      sessionId: browser.sessionId,
      step: request.step,
      stopReason: request.stopReason,
      reason: request.reason,
      path: request.path,
      file,
    });

    let actions = 0;
    let typingIn: string | undefined; // one entry per stretch of typing in a field
    const stopWatching = await browser.watchHuman((event) => {
      if (control.owner !== "human") return; // only a person's turn is recorded
      const field = event.kind === "input" ? `${event.role}|${event.name}` : undefined;
      if (field && field === typingIn) return;
      typingIn = field;
      actions++;
      log.write("human_action", { handoff: number, source: "human", controlEpoch: control.epoch, ...redactEvent(event, redactor) });
    });
    control.transfer("human", `handoff ${number}: ${request.stopReason ?? request.reason}`);

    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let stopLost: (() => void) | undefined;
    let end: HandoffEnd;
    try {
      end = await new Promise<HandoffEnd>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), settings.timeoutSeconds * 1000);
        stopLost = browser.onLost(() => resolve("session_lost"));
        channel.waitForPerson(request, browser, abort.signal).then(
          (answer) => resolve(answer === "done" ? "done" : "cancelled"),
          () => resolve("cancelled"), // the operator's input went away: nobody can hand back
        );
      });
    } finally {
      clearTimeout(timer);
      abort.abort();
      stopLost?.();
      stopWatching();
    }
    if (end === "done" && !browser.isOpen()) end = "session_lost";
    if (end === "done") control.transfer("automation", `handoff ${number}: the person finished`);

    const record: HandoffRecord = {
      handoff: number,
      step: request.step,
      stopReason: request.stopReason,
      reason: request.reason,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      end,
      humanActions: actions,
      sessionId: browser.sessionId,
      stepsPassed: [],
    };
    this.records.push(record);
    log.write("handoff_finished", {
      handoff: number,
      end,
      durationMs: record.durationMs,
      humanActions: actions,
      sessionId: browser.sessionId,
      sessionOpen: browser.isOpen(),
      controlWith: control.owner,
    });
    return record;
  }
}

// Saved form of a person's action: element role and redacted name, the page
// path, and never the value typed.
function redactEvent(event: HumanEvent, redactor: Redactor): Record<string, unknown> {
  return {
    kind: event.kind,
    path: redactor.forLog(event.path),
    element: event.role ? { role: event.role, name: event.name && redactor.forLog(event.name), secret: event.secret } : undefined,
    key: event.key,
    value: event.kind === "input" ? "hidden" : undefined,
  };
}

// The operator control (H4): the terminal. Enter hands control back,
// "cancel" stops the run.
export function terminalChannel(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): HumanChannel {
  return {
    async waitForPerson(request, _session, signal) {
      const lines = [
        "",
        `=== A PERSON IS NOW IN CONTROL OF THE BROWSER (handoff ${request.handoff} of at most ${request.maxHandoffs}) ===`,
        `Why: ${request.stopReason ? `${request.stopReason}: ` : ""}${request.reason}`,
        ...(request.step ? [`Stopped at: ${request.step}`] : []),
        ...(request.expected ? [`Expected: ${request.expected}`] : []),
        `Page: ${request.path}`,
        "Use the open browser window to fix this. Do not close the window.",
        `Then press Enter here to hand control back to automation, or type "cancel" and press Enter to stop the run.`,
        `(Times out after ${request.timeoutSeconds} s.)`,
      ];
      // Drop anything typed while automation was in control (e.g. an extra
      // Enter), so it cannot end this handoff before the person acts.
      const readable = input as NodeJS.ReadableStream & { read?: () => unknown };
      while (typeof readable.read === "function" && readable.read() !== null);
      output.write(`${lines.join("\n")}\n> `);
      // Every typed line is handled, even one typed before the prompt shows.
      return new Promise<HumanAnswer>((resolve, reject) => {
        const rl = createInterface({ input, terminal: false });
        let settled = false;
        const settle = (end: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          rl.close();
          end();
        };
        const onAbort = () => settle(() => reject(signal.reason));
        rl.on("line", (line) => {
          const answer = line.trim().toLowerCase();
          if (answer === "") settle(() => resolve("done"));
          else if (answer === "cancel") settle(() => resolve("cancel"));
          else output.write('Press Enter when you are finished, or type "cancel".\n> ');
        });
        rl.on("close", () => settle(() => reject(new Error("Operator input closed."))));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
