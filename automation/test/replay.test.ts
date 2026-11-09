// Module 4 tests (D-047): deterministic replay of the two real recorded
// workflows against real test banks, plus lookup, version selection,
// promotion and locator rules. No LLM is involved anywhere.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { BrowserSession, type PageElement } from "../src/browser.js";
import { readReplayConfig } from "../src/config.js";
import { lookup, readPhrases } from "../src/replay/lookup.js";
import { holds, resolveTarget, type ConditionContext } from "../src/replay/locate.js";
import { parseReplayArgs } from "../src/replay/replay-cli.js";
import { ReplayRefused, checkInputs, replayWorkflow, type ReplayResult } from "../src/replay/replay.js";
import { Workflow, type Target } from "../src/workflow/schema.js";
import { loadWorkflow, promote, readStatus, selectVersion } from "../src/workflow/store.js";
import { TEST_PASSWORD, TEST_USERNAME, startBank } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REAL_CAPS = path.join(ROOT, "capabilities");
const SAVINGS = "member.get_savings_balance";
const CHECKING = "member.verify_checking_account";
const MEMBERS = JSON.parse(readFileSync(path.join(ROOT, "mock-bank/data/members.json"), "utf8")).members as Array<{
  memberId: string;
  memberName: string;
}>;

const temp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
// A private copy of capabilities/ with every version back to draft, so
// tests never change the real status files and start from a known state.
function capsCopy(): string {
  const dir = temp("replay-caps-");
  cpSync(REAL_CAPS, dir, { recursive: true });
  for (const name of [SAVINGS, CHECKING]) {
    const file = path.join(dir, name, "status.json");
    const drafts = Object.fromEntries(Object.keys(JSON.parse(readFileSync(file, "utf8"))).map((v) => [v, "draft"]));
    writeFileSync(file, `${JSON.stringify(drafts, null, 2)}\n`);
  }
  return dir;
}
// 1.0.1 is the current recording (System Notice condition corrected, D-049).
const realWorkflow = (name: string, version = "1.0.1") => loadWorkflow(REAL_CAPS, name, version);
const config = (port: number, extra: Record<string, string> = {}) =>
  readReplayConfig({
    BANK_URL: `http://localhost:${port}`,
    BANK_LOGIN_USERNAME: TEST_USERNAME,
    BANK_LOGIN_PASSWORD: TEST_PASSWORD,
    BROWSER_HEADLESS: "on",
    REPLAY_RUNS_DIR: temp("replay-runs-"),
    ...extra,
  });
const edited = (name: string, change: (w: Workflow) => void): Workflow => {
  const copy = structuredClone(realWorkflow(name));
  change(copy);
  return Workflow.parse(copy);
};
const stepOf = (w: Workflow, id: string) => {
  const step = w.steps.find((s) => s.id === id);
  if (!step || !("target" in step)) throw new Error(`no step ${id}`);
  return step;
};

// Nothing secret or personal in the saved evidence. Output values may only
// appear in result.json's outputs (lead engineer's clarification 3).
function assertCleanRun(result: ReplayResult, memberId: string): void {
  const files = readdirSync(result.runDir);
  const name = MEMBERS.find((m) => m.memberId === memberId)?.memberName;
  for (const file of files) {
    const text = readFileSync(path.join(result.runDir, file), "utf8");
    for (const secret of [TEST_PASSWORD, TEST_USERNAME]) assert.ok(!text.includes(secret), `${file} contains a credential`);
    assert.ok(!new RegExp(`(?<!\\d)${memberId}(?!\\d)`).test(text), `${file} contains the member ID`);
    if (name) assert.ok(!text.includes(name), `${file} contains the member name`);
    const withoutOutputs = file === "result.json" ? JSON.stringify({ ...JSON.parse(text), outputs: undefined }) : text;
    assert.ok(!/\$\d/.test(withoutOutputs), `${file} contains an amount outside the outputs`);
  }
}

// ---------- unit: locators and conditions ----------

const el = (info: PageElement["info"], ref?: string, text?: string): PageElement => ({
  ref,
  node: { role: info.role, name: info.name, text: text ?? info.text },
  info,
});
const target = (primary: Target["primary"], fallbacks: Target["fallbacks"] = []): Target => ({ primary, fallbacks, why: "test" });

describe("locators", () => {
  const page = [
    el({ role: "button", name: "Savings Account", heading: "Member Details" }, "e1"),
    el({ role: "button", name: "Checking Account", heading: "Member Details" }, "e2"),
    el({ role: "generic", text: "Balance", heading: "Savings Account" }, "e3"),
    el({ role: "generic", text: "$1.00", label: "Balance", heading: "Savings Account" }, "e4"),
    el({ role: "text", text: "Plain text" }),
  ];

  it("resolves exactly one match", () => {
    const r = resolveTarget(page, target({ role: "button", name: "Savings Account", within: "Member Details" }));
    assert.ok(r.ok && r.ref === "e1" && r.used === "primary");
  });

  it("fails on more than one match and never tries a fallback to hide it", () => {
    const r = resolveTarget(page, target({ role: "button", within: "Member Details" }, [{ role: "button", name: "Savings Account" }]));
    assert.ok(!r.ok && r.problem === "AMBIGUOUS_TARGET");
  });

  it("uses a fallback only when the primary matches nothing, and records it", () => {
    const r = resolveTarget(page, target({ role: "button", name: "Savings Account", within: "Elsewhere" }, [{ role: "button", name: "Savings Account" }]));
    assert.ok(r.ok && r.ref === "e1");
    assert.deepEqual(r.ok && r.used, { fallback: 1 });
  });

  it("fails when an ambiguous fallback is reached", () => {
    const r = resolveTarget(page, target({ name: "Nope" }, [{ role: "button", within: "Member Details" }]));
    assert.ok(!r.ok && r.problem === "AMBIGUOUS_TARGET");
  });

  it("does not act on an element without a reference", () => {
    const r = resolveTarget(page, target({ text: "Plain text" }));
    assert.ok(!r.ok && r.problem === "TARGET_NOT_FOUND");
  });

  it("evaluates every condition kind", () => {
    const outputs = new Map([["savings_balance", { value: "$1.00", target: target({ label: "Balance", within: "Savings Account" }) }]]);
    const ctx: ConditionContext = { path: "/members", elements: [...page, el({ role: "generic", text: "10048" }, "e9")], inputs: { member_id: "10048" }, outputs };
    assert.equal(holds({ path: "/members" }, ctx), true);
    assert.equal(holds({ path: "/login" }, ctx), false);
    assert.equal(holds({ visible: { text: "Balance", within: "Savings Account" } }, ctx), true);
    assert.equal(holds({ visible: { role: "button" } }, ctx), false, "visible means exactly one");
    assert.equal(holds({ gone: { text: "Loading savings account…" } }, ctx), true);
    assert.equal(holds({ inputShown: "member_id" }, ctx), true);
    assert.equal(holds({ outputShown: "savings_balance" }, ctx), true);
    assert.equal(holds({ outputFormat: { output: "savings_balance", format: "currency" } }, ctx), true);
    outputs.set("savings_balance", { value: "$2.00", target: target({ label: "Balance" }) });
    assert.equal(holds({ outputShown: "savings_balance" }, ctx), false, "a different value is no longer shown");
  });
});

// ---------- unit: inputs, versions, promotion, lookup, CLI ----------

describe("inputs", () => {
  const w = realWorkflow(SAVINGS);
  it("refuses missing or unknown inputs as caller errors", () => {
    assert.throws(() => checkInputs(w, {}), ReplayRefused);
    assert.throws(() => checkInputs(w, { member_id: "10048", extra: "x" }), ReplayRefused);
  });
  it("reports a value that breaks the declared format as INVALID_INPUT", () => {
    assert.deepEqual(checkInputs(w, { member_id: "1234" }), { ok: false, message: "Enter a valid 5-digit member ID." });
    assert.deepEqual(checkInputs(w, { member_id: "10048" }), { ok: true });
  });
});

describe("versions and promotion", () => {
  it("requires an explicit version while only drafts exist", () => {
    const caps = capsCopy();
    assert.throws(() => selectVersion(caps, SAVINGS), /no reusable version yet: 1\.0\.0 \(draft\), 1\.0\.1 \(draft\)\. Select a draft explicitly with --version/);
    assert.equal(selectVersion(caps, SAVINGS, "1.0.0"), "1.0.0");
    assert.throws(() => selectVersion(caps, SAVINGS, "9.9.9"), /has no version 9\.9\.9/);
    assert.throws(() => selectVersion(caps, "member.unknown"), /No recorded workflow/);
  });

  it("promotes by editing status.json only, once, and then defaults to the highest reusable version", () => {
    const caps = capsCopy();
    const file = path.join(caps, SAVINGS, "1.0.0.json");
    const before = readFileSync(file);
    assert.deepEqual(promote(caps, SAVINGS, "1.0.0"), { from: "draft", to: "reusable" });
    assert.deepEqual(readStatus(caps, SAVINGS), { "1.0.0": "reusable", "1.0.1": "draft" });
    assert.ok(readFileSync(file).equals(before), "the workflow file is unchanged");
    assert.throws(() => promote(caps, SAVINGS, "1.0.0"), /already reusable/);
    assert.equal(selectVersion(caps, SAVINGS), "1.0.0", "1.0.1 is a draft, so 1.0.0 is the default");
    promote(caps, SAVINGS, "1.0.1");
    assert.equal(selectVersion(caps, SAVINGS), "1.0.1", "the highest reusable version is the default");
  });
});

describe("workflow lookup", () => {
  const phrases = readPhrases(REAL_CAPS);
  it("matches the supported phrases exactly, ignoring case, spacing and final punctuation", () => {
    assert.deepEqual(lookup("Get the savings balance for member 10077", phrases), { name: SAVINGS, inputs: { member_id: "10077" } });
    assert.deepEqual(lookup("  what is the SAVINGS balance for member   10048? ", phrases), { name: SAVINGS, inputs: { member_id: "10048" } });
    assert.deepEqual(lookup("Verify the checking account for member 10050.", phrases), { name: CHECKING, inputs: { member_id: "10050" } });
  });
  it("passes the input on as typed, for the workflow's own format check", () => {
    assert.deepEqual(lookup("get the savings balance for member 12AB", phrases).inputs, { member_id: "12AB" });
  });
  it("refuses anything else instead of guessing", () => {
    for (const request of ["savings balance 10077", "Get the savings balance for member", "Get the savings balance for member 10077 please", "Transfer $500 for member 10077"]) {
      assert.throws(() => lookup(request, phrases), /No recorded workflow matches/, request);
    }
  });
  it("refuses a request that matches more than one workflow", () => {
    const both = { "a.one": ["show member {member_id}"], "b.two": ["show member {member_id}"] };
    assert.throws(() => lookup("show member 10048", both), /more than one workflow/);
  });
  it("does not echo the request in its refusal", () => {
    assert.throws(() => lookup("password is hunter22", phrases), (e: Error) => !e.message.includes("hunter22"));
  });
});

describe("replay command line", () => {
  it("needs exactly one of --workflow or --request", () => {
    assert.throws(() => parseReplayArgs([], ROOT), /either --workflow or --request/);
    assert.throws(() => parseReplayArgs(["--workflow", SAVINGS, "--request", "x"], ROOT), /either --workflow or --request/);
    assert.throws(() => parseReplayArgs(["--request", "x", "--input", "member_id=1"], ROOT), /--input is not used with --request/);
    assert.throws(() => parseReplayArgs(["--workflow", SAVINGS, "--version", "1.0"], ROOT), /--version must look like/);
    const args = parseReplayArgs(["--workflow", SAVINGS, "--input", "member_id=10048", "--promote"], ROOT);
    assert.deepEqual([args.workflow, args.inputs, args.promote], [SAVINGS, { member_id: "10048" }, true]);
  });
});

describe("replay uses no LLM", () => {
  it("imports nothing that can reach an LLM or discovery", () => {
    const srcRoot = path.resolve(import.meta.dirname, "../src");
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/^import[^"']*["']([^"']+)["']/gm)) {
        assert.ok(spec !== "openai", `${path.relative(srcRoot, file)} imports openai`);
        if (spec!.startsWith(".")) visit(path.resolve(path.dirname(file), spec!.replace(/\.js$/, ".ts")));
      }
    };
    visit(path.join(srcRoot, "replay/replay-cli.ts"));
    const reached = [...seen].map((f) => path.relative(srcRoot, f));
    for (const file of reached) assert.ok(!/^(llm\/|discover)/.test(file), `replay reaches ${file}`);
    assert.ok(reached.includes("checkpoint.ts") && reached.includes("safety.ts"), "replay reuses the shared checkpoint and safety rules");
  });
});

// ---------- end to end against real test banks ----------

describe("replay of the recorded workflows (normal bank)", () => {
  const PORT = 4330;
  let stopBank: () => void;
  before(async () => (stopBank = await startBank(PORT)));
  after(() => stopBank?.());

  it("replays the real savings workflow for a different member with fresh output and no LLM", async () => {
    const result = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "10048" }, config(PORT));
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.outputs, { savings_balance: "$2,800.40" });
    assert.equal(result.metrics.llmCalls, 0);
    assert.ok(result.checks.length === 3 && result.checks.every((c) => c.passed));
    assert.deepEqual([result.recovered, result.fallbacksUsed], [[], []]);
    const log = readFileSync(path.join(result.runDir, "run.jsonl"), "utf8");
    assert.match(log, /"source":"replay"/, "steps went through the shared checkpoint");
    assert.match(log, /"credential":"username"/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(result.runDir, "result.json"), "utf8")).outputs, { savings_balance: "$2,800.40" });
    assertCleanRun(result, "10048");
  });

  it("the notice handler does not interfere when there is no notice", async () => {
    for (const name of [SAVINGS, CHECKING]) {
      const result = await replayWorkflow(realWorkflow(name), "draft", { member_id: "10050" }, config(PORT));
      assert.equal(result.status, "SUCCESS", JSON.stringify(result));
      assert.deepEqual([result.recovered, result.metrics.steps], [[], 7], name);
      assert.ok(!readFileSync(path.join(result.runDir, "run.jsonl"), "utf8").includes("conditional_step"));
    }
  });

  it("replays the real checking workflow: Active and Closed are reported values", async () => {
    const active = await replayWorkflow(realWorkflow(CHECKING), "draft", { member_id: "10050" }, config(PORT));
    assert.deepEqual([active.status, active.outputs], ["SUCCESS", { checking_status: "Active" }]);
    const closed = await replayWorkflow(realWorkflow(CHECKING), "draft", { member_id: "10047" }, config(PORT));
    assert.deepEqual([closed.status, closed.outputs], ["SUCCESS", { checking_status: "Closed" }]);
    assertCleanRun(closed, "10047");
  });

  it("returns documented business outcomes, not failures", async () => {
    const cases: Array<[string, string, string, string]> = [
      [SAVINGS, "99999", "NOT_FOUND", "Member not found."],
      [SAVINGS, "10049", "NO_ACCOUNT", "No savings account on file."],
      [SAVINGS, "10046", "PERMISSION_DENIED", "You do not have permission to view this account."],
      [CHECKING, "10045", "NO_ACCOUNT", "No checking account on file."],
      [CHECKING, "10044", "PERMISSION_DENIED", "You do not have permission to view this account."],
    ];
    for (const [name, id, code, message] of cases) {
      const result = await replayWorkflow(realWorkflow(name), "draft", { member_id: id }, config(PORT));
      assert.deepEqual([result.status, result.businessOutcome], ["BUSINESS_OUTCOME", { code, message }], `${name} ${id}`);
      assert.equal(result.outputs, undefined);
      assertCleanRun(result, id);
    }
  });

  it("returns INVALID_INPUT before opening a browser", async () => {
    const result = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "1234" }, config(PORT));
    assert.deepEqual([result.status, result.businessOutcome?.code, result.metrics.steps], ["BUSINESS_OUTCOME", "INVALID_INPUT", 0]);
    assert.ok(!readFileSync(path.join(result.runDir, "run.jsonl"), "utf8").includes('"type":"step"'));
  });

  it("promotes a draft only after a successful replay, leaving the workflow file unchanged", async () => {
    const caps = capsCopy();
    const file = path.join(caps, SAVINGS, "1.0.1.json");
    const bytes = readFileSync(file);
    const promoteIt = () => promote(caps, SAVINGS, "1.0.1");
    const outcome = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "99999" }, config(PORT), { promote: promoteIt });
    assert.equal(outcome.promotion, undefined);
    assert.deepEqual(readStatus(caps, SAVINGS), { "1.0.0": "draft", "1.0.1": "draft" }, "a business outcome does not promote");
    const ok = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "10048" }, config(PORT), { promote: promoteIt });
    assert.deepEqual(ok.promotion, { from: "draft", to: "reusable" });
    assert.equal(ok.workflow.status, "reusable");
    assert.deepEqual(readStatus(caps, SAVINGS), { "1.0.0": "draft", "1.0.1": "reusable" });
    assert.ok(readFileSync(file).equals(bytes));
    assert.match(readFileSync(path.join(ok.runDir, "run.jsonl"), "utf8"), /"type":"promoted"/);
    assert.equal(selectVersion(caps, SAVINGS), "1.0.1");
  });

  it("uses a fallback locator only when the primary matches nothing, and reports it", async () => {
    const w = edited(SAVINGS, (w) => (stepOf(w, "click_savings_account").target.primary.within = "No Such Section"));
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(PORT));
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.fallbacksUsed, [{ step: "click_savings_account", locator: 'button named "Savings Account"' }]);
  });

  it("fails with AMBIGUOUS_TARGET when the primary matches several elements, even with a usable fallback", async () => {
    const w = edited(SAVINGS, (w) => {
      // "Member ID" is both the search box label and a details row label.
      stepOf(w, "click_savings_account").target.primary = { text: "Member ID" };
    });
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(PORT));
    assert.deepEqual([result.status, result.stopReason, result.failure?.step], ["FAILED", "AMBIGUOUS_TARGET", "click_savings_account"]);
    assert.match(result.failure!.observed, /primary locator matched 2 elements/);
    assert.deepEqual(result.fallbacksUsed, []);
  });

  it("fails with TARGET_NOT_FOUND, naming the step, what was expected and what was seen", async () => {
    const w = edited(SAVINGS, (w) => {
      const step = stepOf(w, "click_savings_account");
      step.timeoutSeconds = 1;
      step.target = target({ role: "button", name: "Savings Plus" });
    });
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(PORT));
    assert.deepEqual([result.status, result.stopReason, result.failure?.step], ["FAILED", "TARGET_NOT_FOUND", "click_savings_account"]);
    assert.match(result.failure!.expected, /exactly one button named "Savings Plus"/);
    assert.match(result.failure!.observed, /page \/members; headings: "Member Search", "Member Details"/);
    assert.ok(existsSync(path.join(result.runDir, "failure-snapshot.txt")));
    assertCleanRun(result, "10048");
  });

  it("fails a checkpoint that does not hold, instead of assuming the step worked", async () => {
    const w = edited(SAVINGS, (w) => {
      const step = stepOf(w, "click_search");
      step.timeoutSeconds = 1;
      step.expect = [{ visible: { text: "Never shown" } }];
    });
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(PORT));
    assert.deepEqual([result.status, result.stopReason, result.failure?.step], ["FAILED", "CHECKPOINT_FAILED", "click_search"]);
    assert.match(result.failure!.observed, /not met: exactly one element with text "Never shown" is shown/);
  });

  it("reports a business outcome before a checkpoint failure", async () => {
    // click_search expects the Savings Account button; for 99999 it never shows.
    const result = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "99999" }, config(PORT));
    assert.equal(result.status, "BUSINESS_OUTCOME");
  });

  it("never returns SUCCESS when a final condition is not verified", async () => {
    const w = edited(SAVINGS, (w) => w.success.push({ visible: { text: "Never shown" } }));
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(PORT));
    assert.deepEqual([result.status, result.stopReason, result.outputs], ["FAILED", "SUCCESS_CHECK_FAILED", undefined]);
    assert.deepEqual(result.checks.map((c) => c.passed), [true, true, true, false]);
  });

  it("applies the safety rules to replay steps: a risky step stops with NEEDS_HUMAN and is not run", async () => {
    const w = edited(SAVINGS, (w) => {
      const read = w.steps.findIndex((s) => s.id === "click_savings_account");
      w.steps.splice(read, 0, { kind: "click", id: "click_edit_profile", timeoutSeconds: 5, expect: [], target: target({ role: "button", name: "Edit Profile" }) });
    });
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(PORT));
    assert.deepEqual([result.status, result.stopReason], ["NEEDS_HUMAN", "SAFETY_STOP"]);
    assert.match(readFileSync(path.join(result.runDir, "run.jsonl"), "utf8"), /"kind":"click".*"name":"Edit Profile".*"safety":"needs_human"/);
  });

  it("runs from the command line with no API key, and selects drafts only by explicit version", () => {
    const caps = capsCopy();
    const env = { PATH: process.env.PATH, BANK_URL: `http://localhost:${PORT}`, BANK_LOGIN_USERNAME: TEST_USERNAME, BANK_LOGIN_PASSWORD: TEST_PASSWORD, BROWSER_HEADLESS: "on", REPLAY_RUNS_DIR: temp("replay-runs-") };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "automation/src/replay/replay-cli.ts", "--capabilities", caps, ...args], { env, encoding: "utf8", cwd: ROOT });
    const noVersion = run("--request", "Get the savings balance for member 10048");
    assert.equal(noVersion.status, 3);
    assert.match(noVersion.stderr, /Select a draft explicitly with --version/);
    const ok = run("--request", "Get the savings balance for member 10048", "--version", "1.0.1", "--promote");
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Result: SUCCESS/);
    assert.match(ok.stdout, /Promoted member\.get_savings_balance 1\.0\.1: draft → reusable/);
    const again = run("--workflow", SAVINGS, "--input", "member_id=10050");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Replaying member\.get_savings_balance 1\.0\.1 \(reusable\)/);
    writeFileSync(path.join(caps, CHECKING, "1.0.1.json"), "{ not json");
    const broken = run("--workflow", CHECKING, "--version", "1.0.1", "--input", "member_id=10050");
    assert.equal(broken.status, 3);
    assert.match(broken.stderr, /not valid JSON/);
  });
});

describe("replay with interruptions", () => {
  const banks: Array<() => void> = [];
  before(async () => {
    banks.push(await startBank(4331, { BANK_NOTICE: "on" }));
    banks.push(await startBank(4332, { BANK_SLOW_MS: "2500" }));
    banks.push(await startBank(4333, { BANK_SERVER_ERROR: "search" }));
    banks.push(await startBank(4334, { BANK_SERVER_ERROR: "accounts" }));
    banks.push(await startBank(4335, { BANK_SESSION_TTL_SECONDS: "5" }));
  });
  after(() => banks.forEach((stop) => stop()));

  it("dismisses the System Notice in both recorded workflows (1.0.1)", async () => {
    const savings = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "10048" }, config(4331));
    assert.deepEqual([savings.status, savings.outputs], ["SUCCESS", { savings_balance: "$2,800.40" }], JSON.stringify(savings));
    assert.deepEqual(savings.recovered.map((r) => [r.id, r.times]), [["system_notice", 1]]);
    const checking = await replayWorkflow(realWorkflow(CHECKING), "draft", { member_id: "10050" }, config(4331));
    assert.deepEqual([checking.status, checking.outputs], ["SUCCESS", { checking_status: "Active" }], JSON.stringify(checking));
    assert.deepEqual(checking.recovered.map((r) => [r.id, r.times]), [["system_notice", 1]]);
    assertCleanRun(savings, "10048");
  });

  it("hands a genuinely unknown dialog to a person (NEEDS_HUMAN) with evidence", async () => {
    // The same popup, but the workflow has no handler for it.
    const w = edited(SAVINGS, (w) => (w.conditionalSteps = w.conditionalSteps.filter((c) => c.id !== "system_notice")));
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(4331));
    assert.deepEqual([result.status, result.stopReason], ["NEEDS_HUMAN", "UNEXPECTED_DIALOG"]);
    assert.match(result.failure!.observed, /"System Notice"/);
    assert.ok(existsSync(path.join(result.runDir, "failure-snapshot.txt")));
    assert.ok(!readFileSync(path.join(result.runDir, "run.jsonl"), "utf8").includes('"name":"Acknowledge"'), "nothing was clicked in the dialog");
    assertCleanRun(result, "10048");
  });

  it("1.0.0, recorded with the old dialog condition, stays safe: NEEDS_HUMAN, not a guess", async () => {
    const result = await replayWorkflow(realWorkflow(SAVINGS, "1.0.0"), "reusable", { member_id: "10048" }, config(4331));
    assert.deepEqual([result.status, result.stopReason], ["NEEDS_HUMAN", "UNEXPECTED_DIALOG"]);
  });

  it("waits out slow loading", async () => {
    const result = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "10048" }, config(4332));
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.recovered.map((r) => r.id), ["loading_savings_account"]);
  });

  it("reports running out of replay time while waiting as TIME_LIMIT, not a missing target", async () => {
    const w = edited(SAVINGS, (w) => {
      const step = stepOf(w, "click_savings_account");
      step.timeoutSeconds = 30; // longer than the replay limit below
      step.target = target({ role: "button", name: "Savings Plus" });
    });
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(4332, { REPLAY_MAX_SECONDS: "5" }));
    assert.deepEqual([result.status, result.stopReason], ["FAILED", "TIME_LIMIT"]);
  });

  it("stops at the time limit", async () => {
    const result = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "10048" }, config(4332, { REPLAY_MAX_SECONDS: "5" }));
    assert.deepEqual([result.status, result.stopReason], ["FAILED", "TIME_LIMIT"]);
  });

  it("fails with BANK_ERROR on the error page and on an account load error", async () => {
    const search = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "10048" }, config(4333));
    assert.deepEqual([search.status, search.stopReason, search.failure?.step], ["FAILED", "BANK_ERROR", "server_error_page"]);
    const account = await replayWorkflow(realWorkflow(CHECKING), "draft", { member_id: "10050" }, config(4334));
    assert.deepEqual([account.status, account.stopReason, account.failure?.step], ["FAILED", "BANK_ERROR", "load_error_checking_account"]);
  });

  // Make the session expire by holding back the click on the account button.
  const delayingBrowser = (times: number) => async (headless: boolean) => {
    const session = await BrowserSession.open(headless);
    const click = session.click.bind(session);
    let delays = 0;
    session.click = async (ref: string) => {
      if (delays < times && session.describe(ref)?.name === "Savings Account") {
        delays++;
        await new Promise((r) => setTimeout(r, 5500)); // past the 5 s session limit
      }
      return click(ref);
    };
    return session;
  };

  it("logs in again and restarts once when the session expires", async () => {
    const result = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "10048" }, config(4335), { openBrowser: delayingBrowser(1) });
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.outputs, { savings_balance: "$2,800.40" });
    assert.deepEqual(result.recovered.map((r) => [r.id, r.times]), [["session_expired", 1]]);
    assertCleanRun(result, "10048");
  });

  it("does not restart more than once", async () => {
    const result = await replayWorkflow(realWorkflow(SAVINGS), "draft", { member_id: "10048" }, config(4335), { openBrowser: delayingBrowser(9) });
    assert.deepEqual([result.status, result.stopReason, result.failure?.step], ["FAILED", "INTERRUPTION_LIMIT", "session_expired"]);
  });
});
