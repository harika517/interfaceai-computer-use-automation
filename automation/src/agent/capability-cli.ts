// npm run capability -- list
// npm run capability -- get <area.action> [--version x.y.z]
// npm run capability -- execute <area.action> --args '{"member_id":"10048"}' [--version x.y.z] [--handoff]
// Any of them also takes [--capabilities <dir>].
//
// The agent-facing capability interface (D-053) as a JSON command line: the
// result is one JSON document on standard output; progress and the handoff
// prompt go to standard error so the result stays machine-readable.
// Only reusable workflows; no LLM. Exit code: 0 SUCCESS, BUSINESS_OUTCOME or
// a list/get answer, 1 FAILED, 2 NEEDS_HUMAN, 3 REFUSED (nothing was run).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, readReplayConfig } from "../config.js";
import { terminalChannel } from "../handoff.js";
import { exitCodeOf, executeCapability, getCapability, listCapabilities, type Refused } from "./capabilities.js";

const USAGE =
  "Usage: npm run capability -- list | get <area.action> [--version x.y.z] | execute <area.action> --args '<json object>' [--version x.y.z] [--handoff]  [--capabilities <dir>]";

export interface CapabilityArgs {
  command: "list" | "get" | "execute";
  name?: string;
  version?: string;
  args?: unknown;
  handoff: boolean;
  capabilities: string;
}

export class UsageError extends Error {}

export function parseCapabilityArgs(argv: string[], projectRoot: string): CapabilityArgs {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "get" && command !== "execute") throw new UsageError(USAGE);
  const parsed: CapabilityArgs = { command, handoff: false, capabilities: path.join(projectRoot, "capabilities") };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new UsageError(`${arg} needs a value.`);
      return next;
    };
    if (arg === "--version") {
      parsed.version = value();
      if (!/^\d+\.\d+\.\d+$/.test(parsed.version)) throw new UsageError("--version must look like 1.0.0.");
    } else if (arg === "--args") {
      try {
        parsed.args = JSON.parse(value());
      } catch {
        throw new UsageError("--args must be a JSON object, e.g. '{\"member_id\":\"10048\"}'.");
      }
    } else if (arg === "--handoff") parsed.handoff = true;
    else if (arg === "--capabilities") parsed.capabilities = path.resolve(value());
    else if (!arg.startsWith("--") && parsed.name === undefined && command !== "list") parsed.name = arg;
    else throw new UsageError(`Unknown argument ${arg}.`);
  }
  if (command !== "list" && !parsed.name) throw new UsageError(`${command} needs a capability name.`);
  if (command === "list" && (parsed.version || parsed.args !== undefined || parsed.handoff)) throw new UsageError("list takes no other options.");
  if (command === "get" && (parsed.args !== undefined || parsed.handoff)) throw new UsageError("get takes only a name and --version.");
  if (command === "execute" && parsed.args === undefined) throw new UsageError("execute needs --args, e.g. '{\"member_id\":\"10048\"}'.");
  return parsed;
}

async function main(): Promise<number> {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    process.loadEnvFile(path.join(projectRoot, ".env"));
  } catch {
    // No .env file: rely on variables already set in the environment.
  }
  const print = (result: object) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const refuse = (reason: string): number => {
    const result: Refused = { status: "REFUSED", reason };
    print(result);
    return 3;
  };

  let args: CapabilityArgs;
  try {
    args = parseCapabilityArgs(process.argv.slice(2), projectRoot);
  } catch (error) {
    if (error instanceof UsageError) return refuse(error.message === USAGE ? USAGE : `${error.message} ${USAGE}`);
    throw error;
  }

  if (args.command === "list") {
    const result = listCapabilities(args.capabilities);
    print(result);
    return "status" in result ? exitCodeOf(result) : 0;
  }
  if (args.command === "get") {
    const result = getCapability(args.capabilities, args.name!, args.version);
    print(result);
    return "status" in result ? exitCodeOf(result) : 0;
  }

  let config;
  try {
    config = readReplayConfig();
  } catch (error) {
    if (error instanceof ConfigError) return refuse(error.message);
    throw error;
  }
  // A person can only take over a browser window they can see.
  if (args.handoff && config.headless) return refuse("--handoff needs a visible browser: set BROWSER_HEADLESS=off.");
  const say = (line: string) => process.stderr.write(`${line}\n`);
  if (args.handoff) say("Human handoff is on. AUTOMATION IS IN CONTROL: do not touch the browser window until this terminal says a person is in control.");
  const result = await executeCapability(args.capabilities, args.name!, args.args, {
    config,
    version: args.version,
    handoff: args.handoff ? terminalChannel(process.stdin, process.stderr) : undefined,
    listener: (entry) => {
      if (entry.type === "step") say(`  step ${entry.step}: ${entry.kind} → ${entry.outcome}`);
      else if (entry.type === "conditional_step") say(`  interruption: ${entry.id} → ${entry.action}`);
      else if (entry.type === "control_changed") {
        say(`  [control → ${entry.to}, epoch ${entry.epoch}] ${entry.to === "human" ? "A PERSON IS IN CONTROL" : "AUTOMATION IS IN CONTROL: do not touch the browser window"}`);
      } else if (entry.type === "human_action") say(`  person: ${entry.kind} on ${entry.path}`);
      else if (entry.type === "handoff_finished") say(`  handoff ${entry.handoff} ended: ${entry.end}`);
    },
  });
  print(result);
  return exitCodeOf(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
