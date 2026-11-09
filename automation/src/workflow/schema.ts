// Recorded workflow shape (Module 3, D-044). Zod is the single source of
// truth (D-005): a workflow is checked against this when it is saved and
// again when it is loaded. Replay (Module 4) evaluates the conditions here;
// nothing in a workflow is free text that code has to interpret.

import { z } from "zod";
import { BUSINESS_OUTCOMES } from "../steps.js";

export const WORKFLOW_SCHEMA_VERSION = 1;

export const WORKFLOW_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const FIELD = /^[a-z][a-z0-9_]{0,39}$/;
const PAGE_PATH = /^\/[a-z0-9/_-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
// Text the redaction rules put in place of real values. None of it may ever
// end up in a workflow: it is never a stable way to find anything.
export const REDACTION_MARKERS = /\$\[amount\]|\*\*\*\d|\[redacted\]|\[hidden\]|<input:|\(value hidden\)/;

const text = z.string().trim().min(1).max(200);
const fieldName = z.string().regex(FIELD);

// How to find one element on the page. Replay resolves it against the same
// page view discovery used, and it must match exactly one element.
export const Locator = z
  .object({
    role: z.string().min(1).max(40).optional(),
    name: text.optional().describe("Accessible name, e.g. the button's label."),
    label: text.optional().describe("Text just before a nameless element, e.g. \"Balance\"."),
    text: text.optional().describe("The element's exact text. Only used for fixed app messages."),
    within: text.optional().describe("Heading of the section that contains the element."),
  })
  .strict()
  .refine((l) => l.name || l.label || l.text, "A locator needs a name, a label or a text.");
export type Locator = z.infer<typeof Locator>;

export const Target = z
  .object({
    primary: Locator,
    fallbacks: z.array(Locator).max(3).describe("Tried in order if the primary matches nothing; each must also match exactly one."),
    why: z.string().trim().min(1).max(500).describe("Why this identification is robust."),
  })
  .strict();
export type Target = z.infer<typeof Target>;

// Checkpoint conditions: a small closed set Module 4 can evaluate exactly.
export const Condition = z.union([
  z.object({ path: z.string().regex(PAGE_PATH) }).strict(),
  z.object({ visible: Locator }).strict(), // exactly one match
  z.object({ gone: Locator }).strict(), // no match
  z.object({ inputShown: fieldName }).strict(), // the input's value is shown as page text
  z.object({ outputShown: fieldName }).strict(), // the captured value is still shown where it was read
  z.object({ outputFormat: z.object({ output: fieldName, format: z.literal("currency") }).strict() }).strict(),
]);
export type Condition = z.infer<typeof Condition>;

const StepValue = z.union([
  z.object({ input: fieldName }).strict(),
  z.object({ credential: z.enum(["username", "password"]) }).strict(),
]);

const stepBase = {
  id: z.string().regex(/^[a-z][a-z0-9_]{0,60}$/),
  timeoutSeconds: z.number().int().min(1).max(30).describe("Longest wait for the target and for the checkpoint."),
  expect: z.array(Condition).max(5).describe("Checkpoint: all must hold after the step."),
};

export const WorkflowStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fill"), ...stepBase, target: Target, value: StepValue }).strict(),
  z.object({ kind: z.literal("click"), ...stepBase, target: Target }).strict(),
  z.object({ kind: z.literal("read"), ...stepBase, target: Target, output: fieldName }).strict(),
  z.object({ kind: z.literal("navigate"), ...stepBase, path: z.string().regex(PAGE_PATH) }).strict(),
  z.object({ kind: z.literal("wait_for"), ...stepBase, until: Condition }).strict(),
]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;

// Steps that run only when their condition shows up (popup, loading,
// session expiry, error), at any point in the workflow.
export const ConditionalStep = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,60}$/),
    description: text,
    when: z.array(Condition).min(1).describe("All must hold for this step to apply."),
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("click"), target: Target }).strict(),
      z.object({ kind: z.literal("wait_until"), until: Condition, timeoutSeconds: z.number().int().min(1).max(30) }).strict(),
      z.object({ kind: z.literal("login_and_restart") }).strict().describe("Run the login steps again, then the main steps from the start."),
      z.object({ kind: z.literal("fail"), reason: text }).strict(),
    ]),
    maxTimes: z.number().int().min(1).max(3),
    source: text,
    seenInSourceRun: z.boolean(),
  })
  .strict();
export type ConditionalStep = z.infer<typeof ConditionalStep>;

export const BusinessOutcomeRule = z
  .object({
    code: z.enum(BUSINESS_OUTCOMES),
    when: z.array(Condition).min(1),
    message: text,
    source: text,
  })
  .strict();
export type BusinessOutcomeRule = z.infer<typeof BusinessOutcomeRule>;

export const Workflow = z
  .object({
    schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
    name: z.string().regex(WORKFLOW_NAME),
    version: z.string().regex(SEMVER),
    description: z.string().trim().min(1).max(300),
    inputs: z.record(
      fieldName,
      z.object({ type: z.literal("string"), pattern: z.string().min(1), description: text, source: text }).strict(),
    ),
    outputs: z.record(
      fieldName,
      z.object({ type: z.enum(["currency", "text"]), section: text, description: text }).strict(),
    ),
    start: z.object({ path: z.string().regex(PAGE_PATH) }).strict(),
    login: z.array(WorkflowStep).min(1),
    steps: z.array(WorkflowStep).min(1),
    conditionalSteps: z.array(ConditionalStep),
    businessOutcomes: z.array(BusinessOutcomeRule),
    success: z.array(Condition).min(1),
    provenance: z
      .object({ sourceRun: z.string().regex(/^[0-9TZ]+-[0-9a-f]+$/), recorder: text, discoveryModel: z.array(text) })
      .strict(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const inputs = Object.keys(w.inputs);
    const outputs = Object.keys(w.outputs);
    if (outputs.length === 0) issue("A workflow must declare at least one output.");
    for (const [name, input] of Object.entries(w.inputs)) {
      try {
        new RegExp(input.pattern);
      } catch {
        issue(`Input ${name} has an invalid pattern.`);
      }
    }
    for (const step of w.login) {
      if (step.kind === "fill" && !("credential" in step.value)) issue(`Login step ${step.id} may only type credentials.`);
      if (step.kind === "read") issue(`Login step ${step.id} may not read outputs.`);
    }
    const reads = new Map<string, number>();
    const filled = new Set<string>();
    for (const step of w.steps) {
      if (step.kind === "fill" && "credential" in step.value) issue(`Step ${step.id} types a credential outside the login steps.`);
      if (step.kind === "fill" && "input" in step.value) {
        if (!inputs.includes(step.value.input)) issue(`Step ${step.id} uses undeclared input ${step.value.input}.`);
        filled.add(step.value.input);
      }
      if (step.kind === "read") {
        if (!outputs.includes(step.output)) issue(`Step ${step.id} reads undeclared output ${step.output}.`);
        reads.set(step.output, (reads.get(step.output) ?? 0) + 1);
      }
    }
    for (const name of outputs) if (reads.get(name) !== 1) issue(`Output ${name} must be read by exactly one step.`);
    for (const name of inputs) if (!filled.has(name)) issue(`Input ${name} is never used.`);
    const ids = [...w.login, ...w.steps, ...w.conditionalSteps].map((s) => s.id);
    if (new Set(ids).size !== ids.length) issue("Step ids must be unique.");
    if (REDACTION_MARKERS.test(JSON.stringify(w))) issue("The workflow contains redacted or masked text.");
  });
export type Workflow = z.infer<typeof Workflow>;

export function workflowProblems(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "workflow"}: ${i.message}`).join("; ");
}
