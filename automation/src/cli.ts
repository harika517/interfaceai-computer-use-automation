// npm run discover -- --goal "..." --input member_id=10042 --output savings_balance:currency [--allow logout] [--handoff]
//
// --handoff lets a person take over the same visible browser when the run
// needs one, and hand control back from this terminal (Module 5, D-051).
//
// Inputs and outputs must be declared up front (D-016). Settings come from
// .env or the shell (the shell wins); see .env.example.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, readConfig } from "./config.js";
import { discover, type DiscoveryTask, type OutputType } from "./discover.js";
import { terminalChannel } from "./handoff.js";
import { OpenAiProvider } from "./llm/openai.js";

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
// Output names start with the page section they come from (D-041), e.g.
// savings_balance → read under a "Savings…" heading.
const OUTPUT_NAME = /^[a-z][a-z0-9]*_[a-z0-9_]+$/;
const USAGE = 'Usage: npm run discover -- --goal "..." --input name=value --output section_name[:currency|text] [--allow logout] [--handoff]';

export function parseArgs(argv: string[]): DiscoveryTask & { handoff: boolean } {
  const task: DiscoveryTask & { handoff: boolean } = { goal: "", inputs: {}, outputs: {}, allowLogout: false, handoff: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    if (flag === "--handoff") {
      task.handoff = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    i++;
    switch (flag) {
      case "--goal":
        task.goal = value.trim();
        break;
      case "--input": {
        const eq = value.indexOf("=");
        const name = value.slice(0, eq);
        const inputValue = value.slice(eq + 1).trim();
        if (eq < 1 || !NAME.test(name)) throw new Error(`--input must look like name=value with a lower_case name (got "${value}").`);
        // eslint-disable-next-line no-control-regex
        if (!inputValue || inputValue.length > 64 || /[\u0000-\u001f]/.test(inputValue)) {
          throw new Error(`--input ${name} needs a value of 1-64 printable characters.`);
        }
        if (name in task.inputs) throw new Error(`--input ${name} was given twice.`);
        task.inputs[name] = inputValue;
        break;
      }
      case "--output": {
        const parts = value.split(":");
        const [name = "", type = "text"] = parts;
        if (parts.length > 2 || !OUTPUT_NAME.test(name)) {
          throw new Error(`--output must look like section_name or section_name:type, e.g. savings_balance:currency (got "${value}").`);
        }
        if (type !== "text" && type !== "currency") throw new Error(`--output type must be text or currency (got "${type}").`);
        if (name in task.outputs) throw new Error(`--output ${name} was given twice.`);
        task.outputs[name] = type as OutputType;
        break;
      }
      case "--allow":
        if (value !== "logout") throw new Error(`--allow only accepts "logout" (got "${value}").`);
        task.allowLogout = true;
        break;
      default:
        throw new Error(`Unknown option ${flag}.`);
    }
  }
  if (!task.goal) throw new Error("--goal is required.");
  if (Object.keys(task.outputs).length === 0) throw new Error("Declare at least one --output.");
  // The goal and the inputs must not disagree: an ID-like number (4+ digits)
  // in the goal must be one of the --input values, or the run would quietly
  // act on the input while the goal names someone else.
  const values = new Set(Object.values(task.inputs));
  if ((task.goal.match(/\d{4,}/g) ?? []).some((n) => !values.has(n))) {
    throw new Error("The goal names a number that is not one of the --input values. Use the same value in both, e.g. --goal \"... member 10042\" --input member_id=10042.");
  }
  return task;
}

async function main(): Promise<number> {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    process.loadEnvFile(path.join(projectRoot, ".env"));
  } catch {
    // No .env file: rely on variables already set in the environment.
  }

  let task: ReturnType<typeof parseArgs>;
  let config;
  try {
    task = parseArgs(process.argv.slice(2));
    config = readConfig();
    // A person can only take over a browser window they can see.
    if (task.handoff && config.headless) throw new Error("--handoff needs a visible browser: set BROWSER_HEADLESS=off.");
  } catch (error) {
    console.error(error instanceof ConfigError || error instanceof Error ? error.message : String(error));
    const message = error instanceof Error ? error.message : "";
    if (message !== USAGE) console.error(`\n${USAGE}`);
    return 1;
  }

  const provider = new OpenAiProvider(config.llm.apiKey, config.llm.model, config.llm.reasoningEffort);
  console.log(`Discovery with ${provider.name} ${provider.model}. Limits: ${JSON.stringify(config.limits)}`);

  if (task.handoff) {
    console.log("Human handoff is on. AUTOMATION IS IN CONTROL: do not touch the browser window until this terminal says a person is in control.");
  }
  const { handoff, ...discoveryTask } = task;
  const result = await discover(discoveryTask, config, provider, (entry) => {
    if (entry.type === "step") {
      const target = entry.target as { role: string; name?: string } | undefined;
      const element = target ? ` ${target.role}${target.name ? ` "${target.name}"` : ""}` : "";
      const value = entry.value ? ` ${JSON.stringify(entry.value)}` : "";
      console.log(`  step ${entry.step}: ${entry.kind}${element}${value} → ${entry.outcome}${entry.detail ? ` (${entry.detail})` : ""}`);
      if (entry.reason) console.log(`           why: ${entry.reason}`);
    } else if (entry.type === "step_blocked") {
      console.log(`  stopped before step ${entry.step}: ${entry.reason}`);
    } else if (entry.type === "llm_call" && entry.error) {
      console.log(`  LLM call ${entry.call} failed: ${entry.error}`);
    } else if (entry.type === "control_changed") {
      const who = entry.to === "human" ? "A PERSON IS IN CONTROL" : "AUTOMATION IS IN CONTROL: do not touch the browser window";
      console.log(`  [control → ${entry.to}, epoch ${entry.epoch}] ${who}`);
    } else if (entry.type === "human_action") {
      const element = entry.element as { role: string; name?: string } | undefined;
      const what = element ? ` ${element.role}${element.name ? ` "${element.name}"` : ""}` : "";
      console.log(`  person: ${entry.kind}${what}${entry.value ? " (value hidden)" : ""} on ${entry.path}`);
    } else if (entry.type === "handoff_finished") {
      console.log(`  handoff ${entry.handoff} ended: ${entry.end}, ${entry.humanActions} action(s) recorded`);
    }
  }, { handoff: handoff ? terminalChannel() : undefined });

  console.log(`\nResult: ${result.status}${result.stopReason ? ` (${result.stopReason})` : ""}`);
  if (result.reason) console.log(`Reason: ${result.reason}`);
  if (result.outputs) for (const [name, value] of Object.entries(result.outputs)) console.log(`${name}: ${value}`);
  if (result.businessOutcome) console.log(`Business outcome: ${result.businessOutcome.code}: ${result.businessOutcome.message}`);
  if (result.verification) {
    for (const check of result.verification.checks) console.log(`  ${check.passed ? "✓" : "✗"} ${check.check}`);
  }
  const m = result.metrics;
  console.log(
    `Steps ${m.steps} · LLM calls ${m.llmCalls} · tokens ${m.inputTokens} in / ${m.outputTokens} out · est. $${m.estimatedCostUsd.toFixed(4)} · ${(m.durationMs / 1000).toFixed(1)}s · model ${result.model.actual.join(", ") || "n/a"}`,
  );
  console.log(`Run folder: ${path.relative(process.cwd(), result.runDir)}`);
  return result.status === "SUCCESS" || result.status === "BUSINESS_OUTCOME" ? 0 : result.status === "NEEDS_HUMAN" ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
