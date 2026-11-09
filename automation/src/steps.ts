// UI steps the LLM may choose (D-039), as Zod shapes. Discovery validates
// every LLM reply against these; replay (Module 4) will reuse them.

import { z } from "zod";

const reason = z.string().trim().min(1).max(300).describe("Why this step moves toward the goal.");
const ref = z.string().trim().min(1).max(20).describe("Element reference from the latest page view, e.g. e12.");

export const FillValue = z.union([
  z.object({ input: z.string().min(1).describe("Name of a declared task input.") }).strict(),
  z.object({ credential: z.enum(["username", "password"]) }).strict(),
  z.object({ text: z.string().max(200).describe("Plain, non-sensitive text.") }).strict(),
]);
export type FillValue = z.infer<typeof FillValue>;

// What counts as an amount, for discovery's finish check and replay's
// outputFormat check alike.
export const CURRENCY = /^-?\$\d{1,3}(,\d{3})*\.\d{2}$/;

export const BUSINESS_OUTCOMES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "NO_ACCOUNT",
  "PERMISSION_DENIED",
  "ACCOUNT_CLOSED",
] as const;

const params = {
  click: z.object({ ref, reason }).strict(),
  fill: z.object({ ref, value: FillValue, reason }).strict(),
  read: z
    .object({ ref, output: z.string().min(1).describe("Name of the declared output this text fills."), reason })
    .strict(),
  wait_for: z
    .object({
      text: z.string().min(1).max(100).describe("Text to wait for."),
      state: z.enum(["visible", "hidden"]).describe("Wait until the text is visible, or until it is gone."),
      timeout_seconds: z.number().int().min(1).max(15),
      reason,
    })
    .strict(),
  navigate: z.object({ path: z.string().min(1).max(100).describe("Path on the app, e.g. /members."), reason }).strict(),
  request_human: z.object({ reason }).strict(),
  finish: z
    .object({
      status: z.enum(["success", "business_outcome"]),
      outcome_code: z.enum(BUSINESS_OUTCOMES).optional().describe("Required when status is business_outcome."),
      evidence_ref: ref.optional().describe("Element showing the business outcome message."),
      summary: z.string().trim().min(1).max(300),
    })
    .strict(),
};

export type StepKind = keyof typeof params;
export const STEP_KINDS = Object.keys(params) as StepKind[];

export const Step = z.discriminatedUnion("kind", [
  params.click.extend({ kind: z.literal("click") }),
  params.fill.extend({ kind: z.literal("fill") }),
  params.read.extend({ kind: z.literal("read") }),
  params.wait_for.extend({ kind: z.literal("wait_for") }),
  params.navigate.extend({ kind: z.literal("navigate") }),
  params.request_human.extend({ kind: z.literal("request_human") }),
  params.finish.extend({ kind: z.literal("finish") }),
]);
export type Step = z.infer<typeof Step>;

const descriptions: Record<StepKind, string> = {
  click: "Click a button or link.",
  fill: "Type into a text box. Use {input} for task inputs and {credential} for login; never type secrets as text.",
  read: "Capture the text of an element as a declared output.",
  wait_for: "Wait until some text appears or disappears, e.g. a loading message.",
  navigate: "Go to an approved page of the app by path.",
  request_human: "Stop and ask a person for help when you cannot safely continue.",
  finish: "End the task: success after reading every output, or a business outcome shown on the page.",
};

// Tool definitions handed to the LLM boundary: one tool per step kind.
export interface ToolSpec {
  name: StepKind;
  description: string;
  parameters: Record<string, unknown>;
}

export function stepTools(): ToolSpec[] {
  return STEP_KINDS.map((kind) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(params[kind]) as Record<string, unknown>;
    return { name: kind, description: descriptions[kind], parameters: schema };
  });
}

// Turn a tool call (name + arguments) into a validated step.
export function parseStep(name: string, args: unknown): { ok: true; step: Step } | { ok: false; error: string } {
  if (!STEP_KINDS.includes(name as StepKind)) return { ok: false, error: `Unknown step kind "${name}".` };
  const candidate = typeof args === "object" && args !== null ? { ...args, kind: name } : { kind: name };
  const parsed = Step.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "step"}: ${i.message}`).join("; ") };
  }
  if (parsed.data.kind === "finish" && parsed.data.status === "business_outcome" && !parsed.data.outcome_code) {
    return { ok: false, error: "finish: outcome_code is required when status is business_outcome." };
  }
  return { ok: true, step: parsed.data };
}
