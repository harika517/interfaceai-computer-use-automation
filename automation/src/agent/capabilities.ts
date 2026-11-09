// Agent-facing capability interface (optional stretch goal, D-053). Three
// operations over the existing workflow store and replay engine:
//   listCapabilities  - the reusable workflows an agent may call
//   getCapability     - one capability's contract: description, typed inputs
//                       (JSON Schema), outputs, outcomes and example requests
//   executeCapability - run it through deterministic replay, with no LLM
// Only versions marked reusable in status.json are listed, described or run;
// drafts stay with `npm run replay`. Nothing here records, promotes or falls
// back to discovery. Credentials come from settings, never from arguments.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ReplayConfig } from "../config.js";
import type { HumanChannel } from "../handoff.js";
import type { LogListener } from "../run-log.js";
import { readPhrases } from "../replay/lookup.js";
import { ReplayRefused, replayWorkflow, type ReplayResult } from "../replay/replay.js";
import { RecordingRefused } from "../workflow/read-run.js";
import { REDACTION_MARKERS, WORKFLOW_NAME, type Workflow } from "../workflow/schema.js";
import { loadWorkflow, readStatus, versionsOf } from "../workflow/store.js";

// Interface-only status: nothing was run (exit code 3, like "Not run").
export interface Refused {
  status: "REFUSED";
  reason: string;
}

export interface CapabilitySummary {
  name: string;
  version: string; // newest reusable version
  versions: string[]; // all reusable versions
  description: string;
}

export interface CapabilityList {
  capabilities: CapabilitySummary[];
  unavailable?: Array<{ name: string; reason: string }>; // reusable but unreadable files
}

export interface CapabilityDetail extends CapabilitySummary {
  inputSchema: {
    type: "object";
    properties: Record<string, { type: "string"; pattern: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
  outputs: Record<string, { type: "currency" | "text"; description: string }>;
  outcomes: {
    statuses: Array<ReplayResult["status"]>;
    businessOutcomeCodes: string[];
  };
  examples: string[]; // example requests from phrases.json, templates only
}

export interface ExecutionResult {
  capability: { name: string; version: string };
  status: ReplayResult["status"];
  stopReason?: ReplayResult["stopReason"];
  reason?: string;
  outputs?: Record<string, string>;
  businessOutcome?: ReplayResult["businessOutcome"];
  failure?: ReplayResult["failure"];
  handoffs?: ReplayResult["handoffs"];
  runId: string;
  runDir: string; // relative to the current directory, e.g. runs/<runId>
  metrics: ReplayResult["metrics"];
}

const STATUSES: Array<ReplayResult["status"]> = ["SUCCESS", "BUSINESS_OUTCOME", "FAILED", "NEEDS_HUMAN"];
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

const refused = (error: unknown): Refused => {
  if (error instanceof ReplayRefused || error instanceof RecordingRefused) return { status: "REFUSED", reason: error.message };
  throw error;
};

function reusableVersions(capabilitiesDir: string, name: string): string[] {
  const status = readStatus(capabilitiesDir, name);
  return versionsOf(capabilitiesDir, name).filter((v) => status[v] === "reusable"); // oldest first
}

// The reusable version to use: the one named, or the newest. A draft is
// refused even when named, and even when it is newer than every reusable one.
function reusableWorkflow(capabilitiesDir: string, name: string, version?: string): { workflow: Workflow; versions: string[] } {
  if (!WORKFLOW_NAME.test(name)) throw new ReplayRefused(`"${name}" is not a capability name.`);
  const versions = reusableVersions(capabilitiesDir, name);
  if (versions.length === 0) throw new ReplayRefused(`No reusable capability named ${name}.`);
  if (version !== undefined && !versions.includes(version)) {
    throw new ReplayRefused(`${name} ${version} is not a reusable version (reusable: ${versions.join(", ")}).`);
  }
  return { workflow: loadWorkflow(capabilitiesDir, name, version ?? versions.at(-1)!), versions };
}

export function listCapabilities(capabilitiesDir: string): CapabilityList | Refused {
  try {
    const names = existsSync(capabilitiesDir)
      ? readdirSync(capabilitiesDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && WORKFLOW_NAME.test(e.name))
          .map((e) => e.name)
          .sort()
      : [];
    const capabilities: CapabilitySummary[] = [];
    const unavailable: Array<{ name: string; reason: string }> = [];
    for (const name of names) {
      try {
        if (reusableVersions(capabilitiesDir, name).length === 0) continue; // drafts only
        const { workflow, versions } = reusableWorkflow(capabilitiesDir, name);
        capabilities.push({ name, version: workflow.version, versions, description: workflow.description });
      } catch (error) {
        unavailable.push({ name, reason: refused(error).reason });
      }
    }
    return unavailable.length ? { capabilities, unavailable } : { capabilities };
  } catch (error) {
    return refused(error);
  }
}

export function getCapability(capabilitiesDir: string, name: string, version?: string): CapabilityDetail | Refused {
  try {
    const { workflow, versions } = reusableWorkflow(capabilitiesDir, name, version);
    const properties = Object.fromEntries(
      Object.entries(workflow.inputs).map(([input, spec]) => [input, { type: "string" as const, pattern: spec.pattern, description: spec.description }]),
    );
    return {
      name,
      version: workflow.version,
      versions,
      description: workflow.description,
      inputSchema: { type: "object", properties, required: Object.keys(workflow.inputs), additionalProperties: false },
      outputs: Object.fromEntries(Object.entries(workflow.outputs).map(([output, spec]) => [output, { type: spec.type, description: spec.description }])),
      outcomes: { statuses: STATUSES, businessOutcomeCodes: [...new Set(workflow.businessOutcomes.map((r) => r.code))] },
      examples: examplesFor(capabilitiesDir, workflow),
    };
  } catch (error) {
    return refused(error);
  }
}

// Example requests are templates such as "get the savings balance for member
// {member_id}". One holding a digit or masked text, or a placeholder that is
// not a declared input, could carry real data and is left out.
function examplesFor(capabilitiesDir: string, workflow: Workflow): string[] {
  if (!existsSync(path.join(capabilitiesDir, "phrases.json"))) return [];
  let phrases: Record<string, string[]>;
  try {
    phrases = readPhrases(capabilitiesDir);
  } catch {
    return [];
  }
  const inputs = Object.keys(workflow.inputs);
  return (phrases[workflow.name] ?? []).filter(
    (phrase) => !/\d/.test(phrase) && !REDACTION_MARKERS.test(phrase) && [...phrase.matchAll(PLACEHOLDER)].every((m) => inputs.includes(m[1]!)),
  );
}

export async function executeCapability(
  capabilitiesDir: string,
  name: string,
  args: unknown,
  options: { config: ReplayConfig; version?: string; handoff?: HumanChannel; listener?: LogListener },
): Promise<ExecutionResult | Refused> {
  let workflow: Workflow;
  let inputs: Record<string, string>;
  try {
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ReplayRefused("Arguments must be a JSON object.");
    const wrong = Object.entries(args).filter(([, value]) => typeof value !== "string").map(([key]) => key);
    if (wrong.length > 0) throw new ReplayRefused(`Argument(s) must be strings: ${wrong.join(", ")}.`);
    inputs = args as Record<string, string>;
    ({ workflow } = reusableWorkflow(capabilitiesDir, name, options.version));
  } catch (error) {
    return refused(error);
  }

  let result: ReplayResult;
  try {
    // The same replay engine as `npm run replay`; never a promotion.
    result = await replayWorkflow(workflow, "reusable", inputs, options.config, { handoff: options.handoff, listener: options.listener });
  } catch (error) {
    return refused(error); // missing or unknown inputs: nothing was run
  }
  return {
    capability: { name: workflow.name, version: workflow.version },
    status: result.status,
    stopReason: result.stopReason,
    reason: result.reason,
    outputs: result.outputs,
    businessOutcome: result.businessOutcome,
    failure: result.failure,
    handoffs: result.handoffs,
    runId: result.runId,
    runDir: path.relative(process.cwd(), result.runDir),
    metrics: result.metrics,
  };
}

export function exitCodeOf(result: { status: string }): number {
  if (result.status === "REFUSED") return 3;
  if (result.status === "NEEDS_HUMAN") return 2;
  if (result.status === "FAILED") return 1;
  return 0;
}
