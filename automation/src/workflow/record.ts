// Deterministic recording (Module 3, D-024, D-044): one verified discovery
// run → one recorded workflow, by fixed rules and with no LLM. If the run
// does not hold enough evidence to rebuild a step safely, recording is
// refused with the reason instead of guessing.
//
// Clean-up rules (the only ones):
//  1. Keep steps the safety rules allowed and that completed ("done").
//  2. A System Notice acknowledgement or a "Loading…" wait becomes a
//     conditional step (catalog), not an ordered step.
//  3. A read later repeated for the same output: keep the last one.
//  4. An identical fill repeated back to back: keep one.
//  5. Session expiry (a second login): accepted only if the steps before it
//     are an exact repeat of the start of the steps after it; then that
//     earlier copy is a proven duplicate. Otherwise refused.

import { isDeepStrictEqual } from "node:util";
import { businessOutcomes, conditionalSteps, INPUT_FORMATS, isLoadingWait, isNoticeAcknowledgement } from "./catalog.js";
import { RecordingRefused, readRun, type DiscoveryRun, type LoggedStep, type LoggedTarget } from "./read-run.js";
import {
  REDACTION_MARKERS,
  WORKFLOW_NAME,
  WORKFLOW_SCHEMA_VERSION,
  Workflow,
  workflowProblems,
  type Condition,
  type Locator,
  type Target,
  type WorkflowStep,
} from "./schema.js";
import { saveDraft } from "./store.js";

export const RECORDER = "deterministic-recorder/1";
const STEP_TIMEOUT_SECONDS = 10;
const RECORDED_KINDS = ["fill", "click", "read", "navigate", "wait_for"];

export type WorkflowDraft = Omit<Workflow, "version">;

export type RecordOutcome =
  | { ok: true; name: string; version: string; file: string; status: "draft" }
  | { ok: false; reason: string };

// Read the run, build the workflow and save it as the next draft version.
export function recordRun(runDir: string, name: string, capabilitiesDir: string): RecordOutcome {
  try {
    const workflow = buildWorkflow(readRun(runDir), name);
    const saved = saveDraft(capabilitiesDir, workflow);
    return { ok: true, name, version: saved.version, file: saved.file, status: "draft" };
  } catch (error) {
    if (error instanceof RecordingRefused) return { ok: false, reason: error.message };
    throw error;
  }
}

export function buildWorkflow(run: DiscoveryRun, name: string): WorkflowDraft {
  if (!WORKFLOW_NAME.test(name)) {
    throw new RecordingRefused(`Workflow name "${name}" must look like area.action, e.g. member.get_savings_balance.`);
  }

  // Rule 1: only allowed, completed UI steps.
  const kept = run.steps.filter((s) => s.safety === "allow" && s.outcome === "done" && s.kind !== "finish");
  for (const step of kept) {
    if (!RECORDED_KINDS.includes(step.kind)) throw new RecordingRefused(`Step ${step.step} (${step.kind}) cannot be recorded.`);
    if (step.kind === "fill" && step.value && "text" in step.value) {
      throw new RecordingRefused(`Step ${step.step} types free text; only declared inputs and credentials can be recorded.`);
    }
  }

  // Split into login blocks (steps on /login) and main segments.
  const blocks: { login: LoggedStep[]; main: LoggedStep[] }[] = [];
  for (const step of kept) {
    const onLogin = step.page === "/login";
    const last = blocks.at(-1);
    if (onLogin && (!last || last.main.length > 0)) blocks.push({ login: [step], main: [] });
    else if (onLogin) last!.login.push(step);
    else if (!last) throw new RecordingRefused(`The run does not start by logging in (step ${step.step} is on ${step.page}).`);
    else last.main.push(step);
  }
  if (blocks.length === 0) throw new RecordingRefused("The run has no completed steps.");

  // Rule 2: interruptions become conditional steps.
  const seen = { notice: false, loading: false, sessionExpired: blocks.length > 1 };
  const withoutInterruptions = (steps: LoggedStep[]) =>
    steps.filter((s) => {
      if (isNoticeAcknowledgement(s)) seen.notice = true;
      else if (isLoadingWait(s)) seen.loading = true;
      else return true;
      return false;
    });
  for (const block of blocks) block.main = cleanUp(withoutInterruptions(block.main));

  // Rule 5: every login must be the same, and each earlier segment must be
  // an exact repeat of the start of the next one.
  const login = blocks[0]!.login;
  for (const [i, block] of blocks.entries()) {
    if (!sameSteps(block.login, login)) {
      throw new RecordingRefused("The run logs in more than once, and the logins differ; record from a run without session expiry.");
    }
    const next = blocks[i + 1];
    if (next && !sameSteps(block.main, next.main.slice(0, block.main.length))) {
      throw new RecordingRefused(
        "The session expired mid-run and the steps before and after it differ; record from a run without session expiry.",
      );
    }
  }
  const main = blocks.at(-1)!.main;
  checkLogin(login);
  if (main.length === 0) throw new RecordingRefused("The run has no steps after logging in.");

  // Every declared input used, every declared output read exactly once.
  for (const input of run.inputs) {
    if (!main.some((s) => s.kind === "fill" && s.value?.input === input)) {
      throw new RecordingRefused(`Declared input ${input} is never typed by a recorded step.`);
    }
    if (!INPUT_FORMATS[input]) throw new RecordingRefused(`Input ${input} has no documented format in the catalog.`);
  }
  for (const output of Object.keys(run.outputs)) {
    const reads = main.filter((s) => s.kind === "read" && s.output === output);
    if (reads.length !== 1) throw new RecordingRefused(`Output ${output} is not read by exactly one recorded step.`);
  }

  const ids = new Set<string>();
  const loginSteps = login.map((s) => toStep(s, ids));
  const mainSteps = main.map((s) => toStep(s, ids));
  addCheckpoints([...login, ...main], [...loginSteps, ...mainSteps]);

  const outputs: WorkflowDraft["outputs"] = {};
  const readTargets: { section: string; label?: string }[] = [];
  for (const [output, type] of Object.entries(run.outputs)) {
    const read = main.find((s) => s.kind === "read" && s.output === output)!;
    const section = read.target!.heading!;
    const label = read.target!.label ?? read.target!.name;
    outputs[output] = { type, section, description: `${type === "currency" ? "Amount" : "Text"} shown as "${label}" in the "${section}" section.` };
    readTargets.push({ section, label });
  }

  const inputs: WorkflowDraft["inputs"] = {};
  for (const input of run.inputs) inputs[input] = { type: "string", ...INPUT_FORMATS[input]! };

  const success: Condition[] = [
    ...run.inputs.map((input) => ({ inputShown: input })),
    ...Object.keys(run.outputs).map((output) => ({ outputShown: output })),
    ...Object.entries(run.outputs)
      .filter(([, type]) => type === "currency")
      .map(([output]) => ({ outputFormat: { output, format: "currency" as const } })),
  ];

  const draft: WorkflowDraft = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name,
    description: run.goal.replace(/<input:([a-z0-9_]+)>/g, "{$1}"),
    inputs,
    outputs,
    start: { path: "/" },
    login: loginSteps,
    steps: mainSteps,
    conditionalSteps: conditionalSteps(readTargets.map((t) => t.section), seen),
    businessOutcomes: businessOutcomes(run.inputs, readTargets),
    success,
    provenance: { sourceRun: run.runId, recorder: RECORDER, discoveryModel: run.models },
  };

  const checked = Workflow.safeParse({ ...draft, version: "0.0.0" });
  if (!checked.success) throw new RecordingRefused(`The recorded workflow is not valid: ${workflowProblems(checked.error)}`);
  return draft;
}

// Rules 3 and 4.
function cleanUp(steps: LoggedStep[]): LoggedStep[] {
  const lastRead = new Map<string, number>();
  steps.forEach((s, i) => s.kind === "read" && s.output && lastRead.set(s.output, i));
  return steps.filter((s, i) => {
    if (s.kind === "read" && lastRead.get(s.output!) !== i) return false;
    const previous = steps[i - 1];
    return !(s.kind === "fill" && previous && signature(previous) === signature(s));
  });
}

function checkLogin(login: LoggedStep[]): void {
  const fills = login.filter((s) => s.kind === "fill").map((s) => s.value?.credential);
  if (!fills.includes("username") || !fills.includes("password") || !login.some((s) => s.kind === "click")) {
    throw new RecordingRefused("The login steps are incomplete: they need the username, the password and a sign-in click.");
  }
  if (login.some((s) => s.kind === "fill" && !s.value?.credential)) {
    throw new RecordingRefused("A login step types something other than a credential.");
  }
}

// What makes two logged steps the same: kind, element, value and output.
function signature(s: LoggedStep): string {
  return JSON.stringify([s.kind, s.page, s.target ?? null, s.value ?? null, s.output ?? null, s.path ?? null, s.waitFor ?? null]);
}

function sameSteps(a: LoggedStep[], b: LoggedStep[]): boolean {
  return isDeepStrictEqual(a.map(signature), b.map(signature));
}

function usable(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed && !REDACTION_MARKERS.test(trimmed) ? trimmed : undefined;
}

function toStep(s: LoggedStep, ids: Set<string>): WorkflowStep {
  const base = { timeoutSeconds: STEP_TIMEOUT_SECONDS, expect: [] as Condition[] };
  switch (s.kind) {
    case "fill": {
      const input = s.value?.input;
      const credential = s.value?.credential as "username" | "password";
      const value = input ? { input } : { credential };
      return { kind: "fill", id: idFor(`fill_${input ?? credential}`, ids), ...base, target: targetFor(s), value };
    }
    case "click": {
      const target = targetFor(s);
      return { kind: "click", id: idFor(`click_${target.primary.name}`, ids), ...base, target };
    }
    case "read":
      return { kind: "read", id: idFor(`read_${s.output}`, ids), ...base, target: targetFor(s), output: s.output! };
    case "navigate": {
      const path = usable(s.path);
      if (!path || !/^\/[a-z0-9/_-]*$/.test(path)) throw new RecordingRefused(`Step ${s.step} navigates to a path that cannot be recorded.`);
      return { kind: "navigate", id: idFor(`go_${path}`, ids), ...base, path };
    }
    case "wait_for": {
      const text = usable(s.waitFor?.text);
      if (!text) throw new RecordingRefused(`Step ${s.step} waits for text that is masked or missing.`);
      const until: Condition = s.waitFor!.state === "hidden" ? { gone: { text } } : { visible: { text } };
      return { kind: "wait_for", id: idFor(`wait_${text}`, ids), ...base, until };
    }
  }
  throw new RecordingRefused(`Step ${s.step} (${s.kind}) cannot be recorded.`);
}

// Locator from the logged element: role + name for controls, label for
// nameless text, both inside the section heading. Values are never used.
function targetFor(s: LoggedStep): Target {
  const t: LoggedTarget | undefined = s.target;
  if (!t) throw new RecordingRefused(`Step ${s.step} (${s.kind}) has no recorded element.`);
  const name = usable(t.name);
  const label = usable(t.label);
  const within = usable(t.heading);
  const scoped = (l: Locator): Target["fallbacks"] => (l.within ? [{ ...l, within: undefined }].map(dropUndefined) : []);

  if (s.kind === "read") {
    if (!within) throw new RecordingRefused(`Step ${s.step} reads ${s.output} but the run did not record its section heading.`);
    if (!name && !label) {
      throw new RecordingRefused(
        `Step ${s.step} reads ${s.output} from an element the run recorded only by ${t.text ? "its (masked) value" : `role "${t.role}"`}; no stable locator can be derived.`,
      );
    }
    const primary: Locator = name ? { role: t.role, name, within } : { label, within };
    const shown = name ? `${t.role} "${name}"` : `the label "${label}"`;
    return {
      primary,
      fallbacks: scoped(primary),
      why: `Found by ${shown} inside the "${within}" section. The value itself differs per member, so it is never used to find the element. Must match exactly one element; the fallback drops the section and must also match exactly one.`,
    };
  }

  if (!name) {
    throw new RecordingRefused(`Step ${s.step} (${s.kind}) acted on a ${t.role} the run recorded without a usable name; no stable locator can be derived.`);
  }
  const primary: Locator = dropUndefined({ role: t.role, name, within });
  return {
    primary,
    fallbacks: scoped(primary),
    why: within
      ? `Found by role and accessible name (${t.role} "${name}"), which is the same for every member, inside the "${within}" section so a same-named control elsewhere cannot match. Must match exactly one element; the fallback drops the section and must also match exactly one.`
      : `Found by role and accessible name (${t.role} "${name}"), which is the same for every member. Must match exactly one element.`,
  };
}

// Checkpoint after each step: the element the next step acts on is visible,
// and the page path when it changed. Both are grounded in the run: the next
// step really did act on that element, on that page.
function addCheckpoints(logged: LoggedStep[], steps: WorkflowStep[]): void {
  for (let i = 0; i < steps.length - 1; i++) {
    const next = steps[i + 1]!;
    if (logged[i + 1]!.page !== logged[i]!.page) steps[i]!.expect.push({ path: logged[i + 1]!.page });
    if ("target" in next) steps[i]!.expect.push({ visible: next.target.primary });
  }
}

function idFor(raw: string, ids: Set<string>): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "step";
  let id = /^[a-z]/.test(base) ? base : `step_${base}`;
  for (let n = 2; ids.has(id); n++) id = `${base}_${n}`;
  ids.add(id);
  return id;
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
