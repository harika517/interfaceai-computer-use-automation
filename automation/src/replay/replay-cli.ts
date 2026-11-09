// npm run replay -- --workflow member.get_savings_balance [--version 1.0.0] --input member_id=10048 [--promote]
// npm run replay -- --request "Get the savings balance for member 10048" [--version 1.0.0] [--promote]
// Add --handoff to let a person fix a recoverable stop in the same visible
// browser window and hand control back from this terminal (Module 5, D-051).
//
// Replays a recorded workflow with no LLM (Module 4, D-047). Needs only the
// bank settings and the automation's login from .env or the shell; no API key.
// Exit code: 0 SUCCESS or BUSINESS_OUTCOME, 1 FAILED, 2 NEEDS_HUMAN,
// 3 nothing was run (bad arguments, settings or workflow file).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, readReplayConfig } from "../config.js";
import { terminalChannel } from "../handoff.js";
import { RecordingRefused } from "../workflow/read-run.js";
import { loadWorkflow, promote, readStatus, selectVersion } from "../workflow/store.js";
import { lookup, readPhrases } from "./lookup.js";
import { ReplayRefused, replayWorkflow } from "./replay.js";

const USAGE =
  'Usage: npm run replay -- (--workflow <area.action> --input name=value ... | --request "<request>") [--version x.y.z] [--promote] [--handoff] [--capabilities <dir>]';

export interface ReplayArgs {
  workflow?: string;
  request?: string;
  inputs: Record<string, string>;
  version?: string;
  promote: boolean;
  handoff: boolean;
  capabilities: string;
}

export function parseReplayArgs(argv: string[], projectRoot: string): ReplayArgs {
  const args: ReplayArgs = { inputs: {}, promote: false, handoff: false, capabilities: path.join(projectRoot, "capabilities") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--help" || flag === "-h") throw new ReplayRefused(USAGE);
    if (flag === "--promote" || flag === "--handoff") {
      args[flag === "--promote" ? "promote" : "handoff"] = true;
      continue;
    }
    if (!["--workflow", "--request", "--input", "--version", "--capabilities"].includes(flag)) throw new ReplayRefused(`Unknown option ${flag}.`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new ReplayRefused(`${flag} needs a value.`);
    if (flag === "--input") {
      const eq = value.indexOf("=");
      const name = value.slice(0, eq);
      if (eq < 1 || !/^[a-z][a-z0-9_]*$/.test(name)) throw new ReplayRefused(`--input must look like name=value (got an input without a valid name).`);
      if (name in args.inputs) throw new ReplayRefused(`--input ${name} was given twice.`);
      args.inputs[name] = value.slice(eq + 1);
    } else if (flag === "--version") {
      if (!/^\d+\.\d+\.\d+$/.test(value)) throw new ReplayRefused("--version must look like 1.0.0.");
      args.version = value;
    } else if (flag === "--capabilities") {
      args.capabilities = path.resolve(value);
    } else {
      args[flag === "--workflow" ? "workflow" : "request"] = value;
    }
  }
  if (Boolean(args.workflow) === Boolean(args.request)) throw new ReplayRefused("Give either --workflow or --request, not both.");
  if (args.request && Object.keys(args.inputs).length > 0) throw new ReplayRefused("--input is not used with --request: the inputs come from the request.");
  return args;
}

async function main(): Promise<number> {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    process.loadEnvFile(path.join(projectRoot, ".env"));
  } catch {
    // No .env file: rely on variables already set in the environment.
  }

  let prepared;
  try {
    const args = parseReplayArgs(process.argv.slice(2), projectRoot);
    const config = readReplayConfig();
    // A person can only take over a browser window they can see.
    if (args.handoff && config.headless) throw new ReplayRefused("--handoff needs a visible browser: set BROWSER_HEADLESS=off.");
    const { name, inputs } = args.request ? lookup(args.request, readPhrases(args.capabilities)) : { name: args.workflow!, inputs: args.inputs };
    const version = selectVersion(args.capabilities, name, args.version);
    const status = readStatus(args.capabilities, name)[version] ?? "draft";
    if (args.promote && status !== "draft") throw new ReplayRefused(`${name} ${version} is already ${status}; nothing to promote.`);
    const workflow = loadWorkflow(args.capabilities, name, version);
    prepared = { args, config, workflow, status, inputs };
  } catch (error) {
    if (error instanceof ReplayRefused || error instanceof RecordingRefused || error instanceof ConfigError) {
      console.error(`Not run: ${error.message}`);
      if (error.message !== USAGE) console.error(`\n${USAGE}`);
      return 3;
    }
    throw error;
  }

  const { args, config, workflow, status, inputs } = prepared;
  console.log(`Replaying ${workflow.name} ${workflow.version} (${status}) with no LLM.`);
  if (args.handoff) {
    console.log("Human handoff is on. AUTOMATION IS IN CONTROL: do not touch the browser window until this terminal says a person is in control.");
  }
  let result;
  try {
    result = await replayWorkflow(workflow, status, inputs, config, {
      promote: args.promote ? () => promote(args.capabilities, workflow.name, workflow.version) : undefined,
      handoff: args.handoff ? terminalChannel() : undefined,
      listener: (entry) => {
        if (entry.type === "step") {
          const target = entry.target as { role: string; name?: string; label?: string } | undefined;
          const element = target ? ` ${target.role}${target.name ? ` "${target.name}"` : target.label ? ` (after "${target.label}")` : ""}` : "";
          const value = entry.value ? ` ${JSON.stringify(entry.value)}` : "";
          console.log(`  step ${entry.step}: ${entry.kind}${element}${value} → ${entry.outcome}${entry.detail ? ` (${entry.detail})` : ""}`);
        } else if (entry.type === "conditional_step") {
          console.log(`  interruption: ${entry.id} → ${entry.action}`);
        } else if (entry.type === "fallback_used") {
          console.log(`  fallback locator used for ${entry.step}`);
        } else if (entry.type === "control_changed") {
          const who = entry.to === "human" ? "A PERSON IS IN CONTROL" : "AUTOMATION IS IN CONTROL: do not touch the browser window";
          console.log(`  [control → ${entry.to}, epoch ${entry.epoch}] ${who}`);
        } else if (entry.type === "human_action") {
          const element = entry.element as { role: string; name?: string } | undefined;
          const what = element ? ` ${element.role}${element.name ? ` "${element.name}"` : ""}` : "";
          console.log(`  person: ${entry.kind}${what}${entry.value ? " (value hidden)" : ""} on ${entry.path}`);
        } else if (entry.type === "handoff_finished") {
          console.log(`  handoff ${entry.handoff} ended: ${entry.end} after ${(Number(entry.durationMs) / 1000).toFixed(1)}s, ${entry.humanActions} action(s) recorded`);
        } else if (entry.type === "resumed") {
          const passed = entry.stepsPassed as string[];
          console.log(`  resuming at ${entry.from}${passed.length ? ` (already done on the page: ${passed.join(", ")})` : ""}`);
        }
      },
    });
  } catch (error) {
    if (error instanceof ReplayRefused) {
      console.error(`Not run: ${error.message}`);
      return 3;
    }
    throw error;
  }

  console.log(`\nResult: ${result.status}${result.stopReason ? ` (${result.stopReason})` : ""}`);
  if (result.reason) console.log(`Reason: ${result.reason}`);
  if (result.outputs) for (const [name, value] of Object.entries(result.outputs)) console.log(`${name}: ${value}`);
  if (result.businessOutcome) console.log(`Business outcome: ${result.businessOutcome.code}: ${result.businessOutcome.message}`);
  if (result.failure) {
    console.log(`Failed at: ${result.failure.step}\n  expected: ${result.failure.expected}\n  observed: ${result.failure.observed}`);
  }
  for (const check of result.checks) console.log(`  ${check.passed ? "✓" : "✗"} ${check.check}`);
  for (const r of result.recovered) console.log(`  recovered: ${r.id} ×${r.times}`);
  for (const f of result.fallbacksUsed) console.log(`  fallback used: ${f.step} → ${f.locator}`);
  for (const h of result.handoffs ?? []) {
    console.log(`  handoff ${h.handoff}: ${h.stopReason ?? ""} at ${h.step ?? "?"} → ${h.end}, ${h.humanActions} action(s)${h.stepsPassed.length ? `, passed ${h.stepsPassed.join(", ")}` : ""}`);
  }
  if (result.promotion) console.log(`Promoted ${workflow.name} ${workflow.version}: ${result.promotion.from} → ${result.promotion.to}`);
  else if (args.promote && result.handoffs?.length) console.log(`Not promoted: a person helped during this replay.`);
  else if (args.promote) console.log(`Not promoted: only a SUCCESS replay promotes a draft.`);
  console.log(`Steps ${result.metrics.steps} · LLM calls 0 · ${(result.metrics.durationMs / 1000).toFixed(1)}s`);
  console.log(`Run folder: ${path.relative(process.cwd(), result.runDir)}`);
  return result.status === "SUCCESS" || result.status === "BUSINESS_OUTCOME" ? 0 : result.status === "NEEDS_HUMAN" ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
