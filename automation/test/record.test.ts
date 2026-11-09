// Module 3: deterministic recording. Unit tests use synthetic run folders;
// end-to-end tests record runs made by fake-LLM discovery against the test
// bank. No API calls, and no real discovery traces are used as fixtures.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { discover, type DiscoveryTask } from "../src/discover.js";
import { buildWorkflow, recordRun } from "../src/workflow/record.js";
import { readRun } from "../src/workflow/read-run.js";
import { Workflow } from "../src/workflow/schema.js";
import { loadWorkflow, readStatus, saveDraft } from "../src/workflow/store.js";
import {
  ScriptedProvider,
  TEST_PASSWORD,
  TEST_USERNAME,
  click,
  loginSteps,
  refOf,
  searchSteps,
  startBank,
  testConfig,
  type ScriptStep,
} from "./helpers.js";

const tempDir = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));

// ---------- synthetic run folders ----------

type Entry = Record<string, unknown>;
const T = {
  username: { role: "textbox", name: "Username", heading: "Employee Sign In" },
  password: { role: "textbox", name: "Password", heading: "Employee Sign In" },
  signIn: { role: "button", name: "Sign In", heading: "Employee Sign In" },
  memberId: { role: "textbox", name: "Member ID", heading: "Member Search" },
  search: { role: "button", name: "Search", heading: "Member Search" },
  savings: { role: "button", name: "Savings Account", heading: "Member Details" },
  checking: { role: "button", name: "Checking Account", heading: "Member Details" },
  balance: { role: "generic", text: "$[amount]", label: "Balance", heading: "Savings Account" },
  status: { role: "generic", text: "Active", label: "Status", heading: "Checking Account" },
  acknowledge: { role: "button", name: "Acknowledge", heading: "System Notice" },
};
const step = (kind: string, page: string, extra: Entry = {}): Entry => ({ type: "step", kind, page, safety: "allow", outcome: "done", ...extra });
const LOGIN = [
  step("fill", "/login", { target: T.username, value: { credential: "username" } }),
  step("fill", "/login", { target: T.password, value: { credential: "password" } }),
  step("click", "/login", { target: T.signIn }),
];
const SEARCH = [step("fill", "/members", { target: T.memberId, value: { input: "member_id" } }), step("click", "/members", { target: T.search })];
const SAVINGS = [step("click", "/members", { target: T.savings }), step("read", "/members", { target: T.balance, output: "savings_balance" })];
const FINISH = step("finish", "/members", { outcome: "finish" });
const GOOD = [...LOGIN, ...SEARCH, ...SAVINGS, FINISH];
const PASSED = { passed: true, checks: [{ check: "output savings_balance was captured by a read step", passed: true }] };

let runCounter = 0;
interface RunOptions {
  steps?: Entry[];
  status?: string;
  stopReason?: string;
  verification?: unknown;
  outputs?: Record<string, string>;
  goal?: string;
  edit?: (files: { log: string[]; result: Entry }) => void;
}
function writeRun(root: string, options: RunOptions = {}): string {
  const runId = `20261031T000000-${(++runCounter).toString(16).padStart(6, "0")}`;
  const dir = path.join(root, runId);
  mkdirSync(dir, { recursive: true });
  const outputs = options.outputs ?? { savings_balance: "currency" };
  const status = options.status ?? "SUCCESS";
  const verification = "verification" in options ? options.verification : PASSED;
  const log: Entry[] = [
    { type: "run_started", runId, goal: options.goal ?? "Get the savings balance for member <input:member_id>", inputs: { member_id: "<input:member_id>" }, outputs },
    ...(options.steps ?? GOOD).map((s, i) => ({ step: i + 1, ...s })),
    { type: "run_finished", status, verification, model: { actual: ["scripted-test-model"] } },
  ];
  const result: Entry = {
    runId,
    status,
    stopReason: options.stopReason,
    outputs: status === "SUCCESS" ? Object.fromEntries(Object.keys(outputs).map((k) => [k, "$5,200.75"])) : undefined,
    verification,
  };
  const files = { log: log.map((e) => JSON.stringify(e)), result };
  options.edit?.(files);
  writeFileSync(path.join(dir, "run.jsonl"), `${files.log.join("\n")}\n`);
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(files.result, null, 2));
  return dir;
}

const record = (runDir: string, caps: string, name = "member.get_savings_balance") => recordRun(runDir, name, caps);
const refusal = (runDir: string) => {
  const outcome = record(runDir, tempDir("caps-"));
  assert.equal(outcome.ok, false, "expected the recording to be refused");
  return (outcome as { reason: string }).reason;
};
const workflowOf = (runDir: string, name = "member.get_savings_balance") => buildWorkflow(readRun(runDir), name);
const withoutVersion = (file: string) => {
  const { version: _v, ...rest } = JSON.parse(readFileSync(file, "utf8"));
  return rest;
};

// Nothing secret, member-specific or masked may appear in saved workflow files.
function assertCleanCapabilities(caps: string, memberIds: string[]): void {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(caps);
  assert.ok(files.length > 0);
  const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const value of [TEST_USERNAME, TEST_PASSWORD, "John Smith", "sk-test", ...memberIds]) {
    assert.ok(!text.includes(value), `workflow files contain "${value}"`);
  }
  assert.doesNotMatch(text, /\$\d|\$\[amount\]|\*\*\*\d|\[redacted\]|\[hidden\]|<input:|••••/);
}

describe("recording a verified run", () => {
  const runs = tempDir("runs-");

  it("saves a valid draft workflow with contract, steps, checkpoints and outcomes", () => {
    const caps = tempDir("caps-");
    const outcome = record(writeRun(runs), caps);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.version, "1.0.0");
    assert.equal(outcome.file, path.join(caps, "member.get_savings_balance", "1.0.0.json"));
    assert.deepEqual(readStatus(caps, "member.get_savings_balance"), { "1.0.0": "draft" });

    const w = loadWorkflow(caps, "member.get_savings_balance", "1.0.0");
    assert.equal(w.description, "Get the savings balance for member {member_id}");
    assert.deepEqual(w.inputs.member_id?.pattern, "^\\d{5}$");
    assert.deepEqual(w.outputs, {
      savings_balance: { type: "currency", section: "Savings Account", description: 'Amount shown as "Balance" in the "Savings Account" section.' },
    });
    assert.deepEqual(w.login.map((s) => s.id), ["fill_username", "fill_password", "click_sign_in"]);
    assert.deepEqual(w.steps.map((s) => s.id), ["fill_member_id", "click_search", "click_savings_account", "read_savings_balance"]);
    assert.deepEqual(w.success, [
      { inputShown: "member_id" },
      { outputShown: "savings_balance" },
      { outputFormat: { output: "savings_balance", format: "currency" } },
    ]);
    assert.deepEqual(w.provenance.discoveryModel, ["scripted-test-model"]);
    assertCleanCapabilities(caps, ["10042"]);
  });

  it("parameterizes values: inputs and credentials are references only", () => {
    const w = workflowOf(writeRun(runs));
    const fills = [...w.login, ...w.steps].filter((s) => s.kind === "fill").map((s) => s.value);
    assert.deepEqual(fills, [{ credential: "username" }, { credential: "password" }, { input: "member_id" }]);
  });

  it("gives every element a role/name or label locator inside its section, with a robustness note", () => {
    const w = workflowOf(writeRun(runs));
    const read = w.steps.find((s) => s.kind === "read")!;
    assert.ok("target" in read);
    assert.deepEqual(read.target.primary, { label: "Balance", within: "Savings Account" });
    assert.deepEqual(read.target.fallbacks, [{ label: "Balance" }]);
    assert.match(read.target.why, /never used to find the element/);
    for (const s of [...w.login, ...w.steps]) {
      assert.ok("target" in s && s.target.why.length > 20);
      assert.ok(!("text" in s.target.primary), `${s.id} must not be found by its text`);
    }
  });

  it("writes structured checkpoints: next element visible, and the page path when it changes", () => {
    const w = workflowOf(writeRun(runs));
    const signIn = w.login.at(-1)!;
    assert.deepEqual(signIn.expect, [{ path: "/members" }, { visible: { role: "textbox", name: "Member ID", within: "Member Search" } }]);
    const openSavings = w.steps.find((s) => s.id === "click_savings_account")!;
    assert.deepEqual(openSavings.expect, [{ visible: { label: "Balance", within: "Savings Account" } }]);
  });

  it("adds documented business outcomes; a closed account is an outcome for a balance", () => {
    const w = workflowOf(writeRun(runs));
    assert.deepEqual(w.businessOutcomes.map((o) => o.code), ["NOT_FOUND", "INVALID_INPUT", "NO_ACCOUNT", "PERMISSION_DENIED", "ACCOUNT_CLOSED"]);
    assert.deepEqual(w.businessOutcomes.find((o) => o.code === "NO_ACCOUNT")!.when, [
      { visible: { text: "No savings account on file.", within: "Savings Account" } },
    ]);
    for (const o of w.businessOutcomes) assert.ok(o.source.length > 5);
  });

  it("treats Closed as a reported status, not an outcome, when the workflow reports checking status", () => {
    const steps = [...LOGIN, ...SEARCH, step("click", "/members", { target: T.checking }), step("read", "/members", { target: T.status, output: "checking_status" }), FINISH];
    const w = workflowOf(writeRun(runs, { steps, outputs: { checking_status: "text" }, goal: "Verify the checking account for the given member and report its status" }), "member.verify_checking_account");
    assert.deepEqual(w.businessOutcomes.map((o) => o.code), ["NOT_FOUND", "INVALID_INPUT", "NO_ACCOUNT", "PERMISSION_DENIED"]);
    assert.equal(w.businessOutcomes.find((o) => o.code === "NO_ACCOUNT")!.message, "No checking account on file.");
    assert.deepEqual(w.success, [{ inputShown: "member_id" }, { outputShown: "checking_status" }]);
  });

  it("always carries the documented conditional steps, marked as not seen when they did not happen", () => {
    const w = workflowOf(writeRun(runs));
    assert.deepEqual(
      w.conditionalSteps.map((c) => [c.id, c.seenInSourceRun]),
      [["system_notice", false], ["session_expired", false], ["server_error_page", false], ["loading_savings_account", false], ["load_error_savings_account", false]],
    );
  });
});

describe("refusing runs that must not be recorded", () => {
  const runs = tempDir("runs-");

  it("refuses FAILED, NEEDS_HUMAN and BUSINESS_OUTCOME runs", () => {
    assert.match(refusal(writeRun(runs, { status: "FAILED", stopReason: "STEP_LIMIT" })), /ended FAILED \(STEP_LIMIT\)/);
    assert.match(refusal(writeRun(runs, { status: "NEEDS_HUMAN" })), /ended NEEDS_HUMAN/);
    assert.match(refusal(writeRun(runs, { status: "BUSINESS_OUTCOME" })), /ended BUSINESS_OUTCOME/);
  });

  it("refuses unverified runs and runs with a failed check", () => {
    assert.match(refusal(writeRun(runs, { verification: undefined })), /unverified/);
    assert.match(refusal(writeRun(runs, { verification: { passed: true, checks: [] } })), /unverified/);
    const failed = { passed: false, checks: [{ check: "output savings_balance looks like an amount", passed: false }] };
    assert.match(refusal(writeRun(runs, { verification: failed })), /did not all pass: output savings_balance looks like an amount/);
  });

  it("refuses incomplete, corrupted or inconsistent run folders", () => {
    assert.match(refusal(path.join(runs, "no-such-run")), /does not exist/);
    const noResult = writeRun(runs);
    writeFileSync(path.join(noResult, "result.json"), "{ not json");
    assert.match(refusal(noResult), /result.json is not a valid/);
    assert.match(refusal(writeRun(runs, { edit: (f) => f.log.pop() })), /does not end with a run_finished/);
    assert.match(refusal(writeRun(runs, { edit: (f) => f.log.splice(2, 1, '{"type":"step",') })), /line 3 is not valid JSON/);
    assert.match(refusal(writeRun(runs, { edit: (f) => (f.result.runId = "20261031T000000-ffffff") })), /name different runs/);
    assert.match(
      refusal(writeRun(runs, { edit: (f) => (f.log[f.log.length - 1] = JSON.stringify({ type: "run_finished", status: "SUCCESS" })) })),
      /disagree/,
    );
  });

  it("refuses a read the run recorded without label or heading (as in live runs 3 and 5)", () => {
    const steps = [...LOGIN, ...SEARCH, SAVINGS[0]!, step("read", "/members", { target: { role: "generic" }, output: "savings_balance" }), FINISH];
    assert.match(refusal(writeRun(runs, { steps })), /did not record its section heading/);
    const noLabel = step("read", "/members", { target: { role: "generic", text: "$[amount]", heading: "Savings Account" }, output: "savings_balance" });
    assert.match(refusal(writeRun(runs, { steps: [...LOGIN, ...SEARCH, SAVINGS[0]!, noLabel, FINISH] })), /only by its \(masked\) value/);
  });

  it("never uses a masked value as a locator", () => {
    const masked = step("click", "/members", { target: { role: "button", name: "Pay $[amount]", heading: "Member Details" } });
    assert.match(refusal(writeRun(runs, { steps: [...LOGIN, ...SEARCH, masked, ...SAVINGS, FINISH] })), /without a usable name/);
  });

  it("refuses runs missing a login, an input or an output, or typing free text", () => {
    assert.match(refusal(writeRun(runs, { steps: [...SEARCH, ...SAVINGS, FINISH] })), /does not start by logging in/);
    assert.match(refusal(writeRun(runs, { steps: [...LOGIN, SEARCH[1]!, ...SAVINGS, FINISH] })), /input member_id is never typed/);
    assert.match(refusal(writeRun(runs, { steps: [...LOGIN, ...SEARCH, SAVINGS[0]!, FINISH] })), /not read by exactly one/);
    const typed = step("fill", "/members", { target: T.memberId, value: { text: "hello" } });
    assert.match(refusal(writeRun(runs, { steps: [...LOGIN, typed, ...SEARCH, ...SAVINGS, FINISH] })), /free text/);
    assert.match(refusal(writeRun(runs, { steps: [LOGIN[0]!, LOGIN[2]!, ...SEARCH, ...SAVINGS, FINISH] })), /login steps are incomplete/);
  });

  it("refuses an invalid workflow name", () => {
    const outcome = recordRun(writeRun(runs), "Savings Balance", tempDir("caps-"));
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /must look like area\.action/);
  });
});

describe("clean-up and conditional steps", () => {
  const runs = tempDir("runs-");
  const mainIds = (runDir: string) => workflowOf(runDir).steps.map((s) => s.id);
  const EXPECTED = ["fill_member_id", "click_search", "click_savings_account", "read_savings_balance"];

  it("drops refused, failed and invalid steps", () => {
    const steps = [
      ...LOGIN,
      step("fill", "/members", { safety: "refuse", outcome: "refused" }),
      step("click", "/members", { target: T.savings, outcome: "failed" }),
      step("navigate", "/members", { outcome: "invalid", safety: undefined }),
      ...SEARCH,
      ...SAVINGS,
      FINISH,
    ];
    assert.deepEqual(mainIds(writeRun(runs, { steps })), EXPECTED);
  });

  it("keeps only the last read of an output and one of two identical fills in a row", () => {
    const wrongRead = step("read", "/members", { target: { role: "generic", label: "Status", heading: "Savings Account" }, output: "savings_balance" });
    const steps = [...LOGIN, SEARCH[0]!, ...SEARCH, SAVINGS[0]!, wrongRead, SAVINGS[1]!, FINISH];
    assert.deepEqual(mainIds(writeRun(runs, { steps })), EXPECTED);
  });

  it("turns an observed System Notice acknowledgement into a conditional step", () => {
    const steps = [...LOGIN, ...SEARCH, step("click", "/members", { target: T.acknowledge }), ...SAVINGS, FINISH];
    const w = workflowOf(writeRun(runs, { steps }));
    assert.deepEqual(w.steps.map((s) => s.id), EXPECTED);
    const notice = w.conditionalSteps.find((c) => c.id === "system_notice")!;
    assert.equal(notice.seenInSourceRun, true);
    // Matches the real page view: the dialog has no name, its heading does (D-049).
    assert.deepEqual(notice.when, [
      { visible: { role: "heading", name: "System Notice" } },
      { visible: { role: "button", name: "Acknowledge", within: "System Notice" } },
    ]);
  });

  it("turns an observed loading wait into a conditional step", () => {
    const wait = step("wait_for", "/members", { waitFor: { text: "Loading savings account…", state: "hidden" } });
    const w = workflowOf(writeRun(runs, { steps: [...LOGIN, ...SEARCH, SAVINGS[0]!, wait, SAVINGS[1]!, FINISH] }));
    assert.deepEqual(w.steps.map((s) => s.id), EXPECTED);
    assert.equal(w.conditionalSteps.find((c) => c.id === "loading_savings_account")!.seenInSourceRun, true);
  });

  it("keeps any other wait as a bounded, structured step", () => {
    const wait = step("wait_for", "/members", { waitFor: { text: "Account Number", state: "visible" } });
    const w = workflowOf(writeRun(runs, { steps: [...LOGIN, ...SEARCH, SAVINGS[0]!, wait, SAVINGS[1]!, FINISH] }));
    const kept = w.steps.find((s) => s.kind === "wait_for")!;
    assert.deepEqual(kept.kind === "wait_for" && kept.until, { visible: { text: "Account Number" } });
    assert.equal(kept.timeoutSeconds, 10);
  });

  it("accepts session expiry only when the steps before it are proven duplicates", () => {
    const steps = [...LOGIN, ...SEARCH, ...LOGIN, ...SEARCH, ...SAVINGS, FINISH];
    const w = workflowOf(writeRun(runs, { steps }));
    assert.equal(w.login.length, 3);
    assert.deepEqual(w.steps.map((s) => s.id), EXPECTED);
    assert.equal(w.conditionalSteps.find((c) => c.id === "session_expired")!.seenInSourceRun, true);
  });

  it("refuses session expiry when the steps before and after it differ", () => {
    const other = step("click", "/members", { target: T.checking });
    const steps = [...LOGIN, ...SEARCH, other, ...LOGIN, ...SEARCH, ...SAVINGS, FINISH];
    assert.match(refusal(writeRun(runs, { steps })), /steps before and after it differ/);
  });
});

describe("storage and versions", () => {
  const runs = tempDir("runs-");

  it("is deterministic: re-recording the same run gives identical content, as the next patch version", () => {
    const caps = tempDir("caps-");
    const run = writeRun(runs);
    const first = record(run, caps);
    const firstBytes = readFileSync(path.join(caps, "member.get_savings_balance", "1.0.0.json"), "utf8");
    const second = record(run, caps);
    assert.ok(first.ok && second.ok);
    assert.equal(second.version, "1.0.1");
    assert.deepEqual(withoutVersion(first.file), withoutVersion(second.file));
    assert.equal(readFileSync(first.file, "utf8"), firstBytes, "an existing version is never rewritten");
    assert.deepEqual(readStatus(caps, "member.get_savings_balance"), { "1.0.0": "draft", "1.0.1": "draft" });
  });

  it("keeps two different successful paths as separate draft versions", () => {
    const caps = tempDir("caps-");
    const viaNavigate = [...LOGIN, step("navigate", "/members", { path: "/members" }), ...SEARCH, ...SAVINGS, FINISH];
    const a = record(writeRun(runs), caps);
    const b = record(writeRun(runs, { steps: viaNavigate }), caps);
    assert.ok(a.ok && b.ok);
    assert.equal(b.version, "1.0.1");
    const stepsOf = (v: string) => loadWorkflow(caps, "member.get_savings_balance", v).steps.map((s) => s.id);
    assert.deepEqual(stepsOf("1.0.0"), ["fill_member_id", "click_search", "click_savings_account", "read_savings_balance"]);
    assert.deepEqual(stepsOf("1.0.1"), ["go_members", "fill_member_id", "click_search", "click_savings_account", "read_savings_balance"]);
  });

  it("refuses to save an invalid workflow", () => {
    const caps = tempDir("caps-");
    const draft = workflowOf(writeRun(runs));
    assert.throws(() => saveDraft(caps, { ...draft, steps: [] }), /Refusing to save an invalid workflow/);
    const leaky = { ...draft, description: "Balance $[amount] for <input:member_id>" };
    assert.throws(() => saveDraft(caps, leaky), /redacted or masked text/);
    assert.ok(!existsSync(path.join(caps, "member.get_savings_balance", "1.0.0.json")));
  });

  it("refuses malformed, edited or misplaced workflow files on load", () => {
    const caps = tempDir("caps-");
    const saved = record(writeRun(runs), caps);
    assert.ok(saved.ok);
    const original = JSON.parse(readFileSync(saved.file, "utf8"));
    const write = (content: unknown) => writeFileSync(saved.file, typeof content === "string" ? content : JSON.stringify(content));
    const load = () => loadWorkflow(caps, "member.get_savings_balance", "1.0.0");

    write("{ truncated");
    assert.throws(load, /not valid JSON/);
    write({ ...original, approvedBy: "me" });
    assert.throws(load, /not a valid workflow/);
    write({ ...original, steps: [{ ...original.steps[0], expect: ["the page looks right"] }, ...original.steps.slice(1)] });
    assert.throws(load, /not a valid workflow/);
    write({ ...original, steps: [{ ...original.steps[0], target: { ...original.steps[0].target, primary: { role: "textbox" } } }, ...original.steps.slice(1)] });
    assert.throws(load, /needs a name, a label or a text/);
    write({ ...original, steps: [{ ...original.steps[0], value: { credential: "password" } }, ...original.steps.slice(1)] });
    assert.throws(load, /credential outside the login/);
    write({ ...original, schemaVersion: 2 });
    assert.throws(load, /not a valid workflow/);
    write({ ...original, version: "2.0.0" });
    assert.throws(load, /misplaced or edited/);
    write(original);
    assert.equal(load().name, "member.get_savings_balance");
  });

  it("checks the same rules on parse that it enforces on save", () => {
    const draft = workflowOf(writeRun(runs));
    assert.equal(Workflow.safeParse({ ...draft, version: "1.0.0" }).success, true);
    assert.equal(Workflow.safeParse({ ...draft, version: "1.0" }).success, false);
  });
});

describe("recording uses no LLM", () => {
  it("imports nothing that can reach an LLM, a browser or discovery", () => {
    const srcRoot = path.resolve(import.meta.dirname, "../src");
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/^import[^"']*["']([^"']+)["']/gm)) {
        assert.ok(!["openai", "playwright"].includes(spec!), `${path.relative(srcRoot, file)} imports ${spec}`);
        if (spec!.startsWith(".")) visit(path.resolve(path.dirname(file), spec!.replace(/\.js$/, ".ts")));
      }
    };
    visit(path.join(srcRoot, "workflow/record-cli.ts"));
    const reached = [...seen].map((f) => path.relative(srcRoot, f));
    for (const file of reached) assert.ok(!/^(llm\/|discover|browser|checkpoint|config)/.test(file), `recording reaches ${file}`);
    assert.ok(reached.includes("workflow/record.ts"));
  });

  it("runs from the command line with no API key, credentials or .env values", () => {
    const run = writeRun(tempDir("runs-"));
    const caps = tempDir("caps-");
    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx", "automation/src/workflow/record-cli.ts", "--run", run, "--name", "member.get_savings_balance", "--capabilities", caps],
      { env: { PATH: process.env.PATH }, encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Version: 1\.0\.0/);
    assert.match(cli.stdout, /Status: draft/);

    const refused = spawnSync(process.execPath, ["--import", "tsx", "automation/src/workflow/record-cli.ts", "--run", run], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--name is required/);
  });
});

// ---------- end to end: fake-LLM discovery → recording ----------

const why = { reason: "test step" };
const savingsTask: DiscoveryTask = {
  goal: "Get the savings balance for member 10042",
  inputs: { member_id: "10042" },
  outputs: { savings_balance: "currency" },
  allowLogout: false,
};
const readBalance: ScriptStep = (p) => ({ tool: "read", args: { ref: refOf(p, /: \$[\d,]+\.\d{2}/), output: "savings_balance", ...why } });
const finishSuccess: ScriptStep = () => ({ tool: "finish", args: { status: "success", summary: "done" } });

async function discoverAndRecord(port: number, task: DiscoveryTask, script: ScriptStep[], name: string, overrides: Record<string, string> = {}) {
  const result = await discover(task, testConfig(port, overrides), new ScriptedProvider(script));
  assert.equal(result.status, "SUCCESS", JSON.stringify(result));
  const caps = tempDir("caps-");
  const outcome = recordRun(result.runDir, name, caps);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assertCleanCapabilities(caps, Object.values(task.inputs));
  return loadWorkflow(caps, name, "1.0.0");
}

describe("recording real discovery runs (fake LLM, test bank)", () => {
  const PORT = 4320;
  let stopBank: () => void;
  before(async () => {
    stopBank = await startBank(PORT);
  });
  after(() => stopBank());

  it("records the savings balance run", async () => {
    const w = await discoverAndRecord(PORT, savingsTask, [...loginSteps, ...searchSteps, click("Savings Account"), readBalance, finishSuccess], "member.get_savings_balance");
    assert.deepEqual(w.steps.map((s) => s.id), ["fill_member_id", "click_search", "click_savings_account", "read_savings_balance"]);
    const read = w.steps.at(-1)!;
    assert.deepEqual("target" in read && read.target.primary, { label: "Balance", within: "Savings Account" });
  });

  it("records the checking status run for another member", async () => {
    const task: DiscoveryTask = {
      goal: "Verify the checking account for the given member and report its status",
      inputs: { member_id: "10050" },
      outputs: { checking_status: "text" },
      allowLogout: false,
    };
    const readStatus: ScriptStep = (p) => ({ tool: "read", args: { ref: refOf(p, /generic: Active \[ref=/), output: "checking_status", ...why } });
    const w = await discoverAndRecord(PORT, task, [...loginSteps, ...searchSteps, click("Checking Account"), readStatus, finishSuccess], "member.verify_checking_account");
    const read = w.steps.at(-1)!;
    assert.deepEqual("target" in read && read.target.primary, { label: "Status", within: "Checking Account" });
    assert.ok(!w.businessOutcomes.some((o) => o.code === "ACCOUNT_CLOSED"));
  });
});

describe("recording runs with the System Notice popup (E-10)", () => {
  const PORT = 4321;
  let stopBank: () => void;
  before(async () => {
    stopBank = await startBank(PORT, { BANK_NOTICE: "on" });
  });
  after(() => stopBank());

  it("makes the acknowledgement conditional", async () => {
    const script = [...loginSteps, ...searchSteps, click("Acknowledge"), click("Savings Account"), readBalance, finishSuccess];
    const w = await discoverAndRecord(PORT, savingsTask, script, "member.get_savings_balance");
    assert.ok(!w.steps.some((s) => s.id.includes("acknowledge")));
    assert.equal(w.conditionalSteps.find((c) => c.id === "system_notice")!.seenInSourceRun, true);
  });
});

describe("recording runs with slow loading (E-8)", () => {
  const PORT = 4322;
  let stopBank: () => void;
  before(async () => {
    stopBank = await startBank(PORT, { BANK_SLOW_MS: "2500" });
  });
  after(() => stopBank());

  it("makes the loading wait conditional", async () => {
    const wait: ScriptStep = () => ({ tool: "wait_for", args: { text: "Loading savings account…", state: "hidden", timeout_seconds: 10, ...why } });
    const script = [...loginSteps, ...searchSteps, click("Savings Account"), wait, readBalance, finishSuccess];
    const w = await discoverAndRecord(PORT, savingsTask, script, "member.get_savings_balance");
    assert.ok(!w.steps.some((s) => s.kind === "wait_for"));
    assert.equal(w.conditionalSteps.find((c) => c.id === "loading_savings_account")!.seenInSourceRun, true);
  });
});

describe("recording runs with session expiry (E-7)", () => {
  const PORT = 4323;
  let stopBank: () => void;
  before(async () => {
    stopBank = await startBank(PORT, { BANK_SESSION_TTL_SECONDS: "6" });
  });
  after(() => stopBank());

  it("records one login plus conditional recovery, not two logins", async () => {
    const idle: ScriptStep = () => ({ tool: "wait_for", args: { text: "Text that never appears", state: "visible", timeout_seconds: 7, ...why } });
    const script = [...loginSteps, idle, ...searchSteps, ...loginSteps, ...searchSteps, click("Savings Account"), readBalance, finishSuccess];
    const limits = { DISCOVERY_MAX_STEPS: "20", DISCOVERY_MAX_LLM_CALLS: "20", DISCOVERY_MAX_FAILURES: "3", DISCOVERY_MAX_SECONDS: "60" };
    const w = await discoverAndRecord(PORT, savingsTask, script, "member.get_savings_balance", limits);
    assert.equal(w.login.length, 3);
    assert.deepEqual(w.steps.map((s) => s.id), ["fill_member_id", "click_search", "click_savings_account", "read_savings_balance"]);
    assert.equal(w.conditionalSteps.find((c) => c.id === "session_expired")!.seenInSourceRun, true);
  });
});
