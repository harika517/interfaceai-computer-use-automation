// npm run record -- --run runs/<runId> --name member.get_savings_balance [--capabilities <dir>]
//
// Turns one verified discovery run into a draft recorded workflow. Reads the
// run folder only: no LLM, no browser, no bank, no credentials or API key.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordRun } from "./record.js";

const USAGE = "Usage: npm run record -- --run <run-folder> --name <area.action> [--capabilities <dir>]";

export function parseRecordArgs(argv: string[], projectRoot: string): { run: string; name: string; capabilities: string } {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    if (!["--run", "--name", "--capabilities"].includes(flag)) throw new Error(`Unknown option ${flag}.`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    options[flag.slice(2)] = value;
  }
  if (!options.run) throw new Error("--run is required.");
  if (!options.name) throw new Error("--name is required.");
  return {
    run: options.run,
    name: options.name,
    capabilities: path.resolve(options.capabilities ?? path.join(projectRoot, "capabilities")),
  };
}

function main(): number {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  let args;
  try {
    args = parseRecordArgs(process.argv.slice(2), projectRoot);
  } catch (error) {
    console.error((error as Error).message);
    if ((error as Error).message !== USAGE) console.error(`\n${USAGE}`);
    return 1;
  }
  const outcome = recordRun(args.run, args.name, args.capabilities);
  if (!outcome.ok) {
    console.error(`Not recorded: ${outcome.reason}`);
    return 1;
  }
  console.log(`Recorded workflow: ${outcome.name}`);
  console.log(`Version: ${outcome.version}`);
  console.log(`Status: ${outcome.status} (becomes reusable only after a test replay passes, Module 4)`);
  console.log(`File: ${path.relative(process.cwd(), outcome.file)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
