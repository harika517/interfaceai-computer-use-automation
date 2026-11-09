// Load a discovery run folder and decide whether it may be recorded (D-024,
// D-044, D-051): only a SUCCESS run whose every result check passed, with
// no human handoff, and a complete log that agrees with result.json. Output
// values in result.json are never read into the recording; only their names.

import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";

export class RecordingRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RecordingRefused";
  }
}

const LoggedTarget = z.object({
  role: z.string(),
  name: z.string().optional(),
  text: z.string().optional(),
  label: z.string().optional(),
  heading: z.string().optional(),
});
export type LoggedTarget = z.infer<typeof LoggedTarget>;

const LoggedStep = z.object({
  type: z.literal("step"),
  step: z.number().int(),
  kind: z.string(),
  page: z.string(),
  target: LoggedTarget.optional(),
  value: z.record(z.string(), z.string()).optional(),
  output: z.string().optional(),
  waitFor: z.object({ text: z.string(), state: z.enum(["visible", "hidden"]) }).optional(),
  path: z.string().optional(),
  safety: z.string().optional(),
  outcome: z.string(),
});
export type LoggedStep = z.infer<typeof LoggedStep>;

const RunStarted = z.object({
  type: z.literal("run_started"),
  runId: z.string(),
  goal: z.string(),
  inputs: z.record(z.string(), z.string()),
  outputs: z.record(z.string(), z.enum(["currency", "text"])),
});

const Verification = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({ check: z.string(), passed: z.boolean(), detail: z.string().optional() })),
});

const RunFinished = z.object({
  type: z.literal("run_finished"),
  status: z.string(),
  verification: Verification.optional(),
  model: z.object({ actual: z.array(z.string()) }).optional(),
});

const ResultFile = z.object({
  runId: z.string(),
  status: z.string(),
  stopReason: z.string().optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  verification: Verification.optional(),
});

export interface DiscoveryRun {
  runId: string;
  goal: string;
  inputs: string[];
  outputs: Record<string, "currency" | "text">;
  steps: LoggedStep[];
  models: string[];
}

export function readRun(runDir: string): DiscoveryRun {
  const folder = path.resolve(runDir);
  const logFile = path.join(folder, "run.jsonl");
  const resultFile = path.join(folder, "result.json");
  if (!existsSync(folder)) throw new RecordingRefused(`Run folder ${runDir} does not exist.`);
  if (!existsSync(logFile) || !existsSync(resultFile)) {
    throw new RecordingRefused("The run folder is incomplete: it needs run.jsonl and result.json.");
  }

  let result: z.infer<typeof ResultFile>;
  try {
    result = ResultFile.parse(JSON.parse(readFileSync(resultFile, "utf8")));
  } catch {
    throw new RecordingRefused("result.json is not a valid discovery result.");
  }
  if (result.status !== "SUCCESS") {
    const why = result.stopReason ? ` (${result.stopReason})` : "";
    throw new RecordingRefused(`The run ended ${result.status}${why}. Only verified SUCCESS runs can be recorded.`);
  }
  if (!result.verification || result.verification.checks.length === 0) {
    throw new RecordingRefused("The run has no result checks, so it is unverified.");
  }
  const failed = result.verification.checks.filter((c) => !c.passed).map((c) => c.check);
  if (!result.verification.passed || failed.length > 0) {
    throw new RecordingRefused(`The run's result checks did not all pass: ${failed.join("; ") || "verification failed"}.`);
  }

  const entries: Record<string, unknown>[] = [];
  const lines = readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim());
  for (const [i, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      throw new RecordingRefused(`run.jsonl line ${i + 1} is not valid JSON; the log may be truncated or edited.`);
    }
  }
  const started = RunStarted.safeParse(entries[0]);
  if (!started.success) throw new RecordingRefused("run.jsonl does not start with a run_started entry.");
  const finished = RunFinished.safeParse(entries.at(-1));
  if (!finished.success) throw new RecordingRefused("run.jsonl does not end with a run_finished entry; the log is incomplete.");

  // A person's actions are not UI steps the workflow could replay, so a run
  // a person helped with is not a verified automated sequence (D-051).
  if (entries.some((e) => e.type === "handoff_requested")) {
    throw new RecordingRefused("A person took control during this run, so its automated steps alone do not reproduce it. Record a run that succeeded without help.");
  }

  const steps: LoggedStep[] = [];
  for (const entry of entries) {
    if (entry.type !== "step") continue;
    const parsed = LoggedStep.safeParse(entry);
    if (!parsed.success) throw new RecordingRefused(`A step entry in run.jsonl is malformed (step ${String(entry.step)}).`);
    steps.push(parsed.data);
  }

  const runId = started.data.runId;
  if (result.runId !== runId || path.basename(folder) !== runId) {
    throw new RecordingRefused("The run folder, run.jsonl and result.json name different runs.");
  }
  if (finished.data.status !== result.status || !isDeepStrictEqual(finished.data.verification, result.verification)) {
    throw new RecordingRefused("run.jsonl and result.json disagree about the run's result.");
  }
  const declared = Object.keys(started.data.outputs).sort();
  if (!isDeepStrictEqual(Object.keys(result.outputs ?? {}).sort(), declared)) {
    throw new RecordingRefused("result.json does not hold exactly the declared outputs.");
  }

  return {
    runId,
    goal: started.data.goal,
    inputs: Object.keys(started.data.inputs),
    outputs: started.data.outputs,
    steps,
    models: finished.data.model?.actual ?? [],
  };
}
