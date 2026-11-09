// Agent-facing capability interface tests (D-053): list, get and execute over
// a private copy of capabilities/ against real test banks. Only reusable
// versions are exposed; execution is the existing replay with no LLM.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Page } from "playwright";
import { exitCodeOf, executeCapability, getCapability, listCapabilities, type ExecutionResult } from "../src/agent/capabilities.js";
import { parseCapabilityArgs, UsageError } from "../src/agent/capability-cli.js";
import { readReplayConfig } from "../src/config.js";
import type { HumanChannel } from "../src/handoff.js";
import { TEST_PASSWORD, TEST_USERNAME, startBank } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SAVINGS = "member.get_savings_balance";
const CHECKING = "member.verify_checking_account";
const PORT = 4350;
const NOTICE_PORT = 4351;
const ERROR_PORT = 4352;
const MEMBERS = JSON.parse(readFileSync(path.join(ROOT, "mock-bank/data/members.json"), "utf8")).members as Array<{
  memberId: string;
  memberName: string;
}>;

const temp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file: string, data: unknown) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

// A copy of the real capabilities with: a newer draft of the savings
// workflow (1.0.2), a workflow that has only a draft, and unsafe example
// phrases that must never be shown.
function capsCopy(): string {
  const dir = temp("caps-agent-");
  cpSync(path.join(ROOT, "capabilities"), dir, { recursive: true });
  const savings = readJson(path.join(dir, SAVINGS, "1.0.1.json"));
  writeJson(path.join(dir, SAVINGS, "1.0.2.json"), { ...savings, version: "1.0.2" });
  writeJson(path.join(dir, SAVINGS, "status.json"), { "1.0.0": "reusable", "1.0.1": "reusable", "1.0.2": "draft" });
  mkdirSync(path.join(dir, "member.draft_only"));
  writeJson(path.join(dir, "member.draft_only", "1.0.0.json"), { ...savings, name: "member.draft_only", version: "1.0.0" });
  writeJson(path.join(dir, "member.draft_only", "status.json"), { "1.0.0": "draft" });
  const phrases = readJson(path.join(dir, "phrases.json"));
  phrases[SAVINGS].push("get the savings balance for member 10042", "get the savings balance for ssn {ssn}");
  writeJson(path.join(dir, "phrases.json"), phrases);
  return dir;
}

const config = (port: number, extra: Record<string, string> = {}) =>
  readReplayConfig({
    BANK_URL: `http://localhost:${port}`,
    BANK_LOGIN_USERNAME: TEST_USERNAME,
    BANK_LOGIN_PASSWORD: TEST_PASSWORD,
    BROWSER_HEADLESS: "on",
    REPLAY_RUNS_DIR: temp("caps-runs-"),
    ...extra,
  });

function executed(result: Awaited<ReturnType<typeof executeCapability>>): ExecutionResult {
  assert.notEqual(result.status, "REFUSED", JSON.stringify(result));
  return result as ExecutionResult;
}

// Nothing secret or personal in the run folder; amounts only in result.json outputs.
function assertCleanRun(result: ExecutionResult, memberId: string): void {
  const name = MEMBERS.find((m) => m.memberId === memberId)?.memberName;
  for (const file of readdirSync(result.runDir)) {
    const text = readFileSync(path.join(result.runDir, file), "utf8");
    for (const secret of [TEST_PASSWORD, TEST_USERNAME]) assert.ok(!text.includes(secret), `${file} contains a credential`);
    assert.ok(!new RegExp(`(?<!\\d)${memberId}(?!\\d)`).test(text), `${file} contains the member ID`);
    if (name) assert.ok(!text.includes(name), `${file} contains the member name`);
    const withoutOutputs = file === "result.json" ? JSON.stringify({ ...JSON.parse(text), outputs: undefined }) : text;
    assert.ok(!/\$\d/.test(withoutOutputs), `${file} contains an amount outside the outputs`);
  }
}

describe("capability catalog: list and get", () => {
  const caps = capsCopy();

  it("lists only reusable workflows with their newest reusable version, never a draft", () => {
    const result = listCapabilities(caps);
    assert.ok(!("status" in result));
    assert.deepEqual(
      result.capabilities.map((c) => [c.name, c.version, c.versions]),
      [
        [SAVINGS, "1.0.1", ["1.0.0", "1.0.1"]],
        [CHECKING, "1.0.1", ["1.0.0", "1.0.1"]],
      ].sort(),
    );
    assert.equal(result.unavailable, undefined);
    assert.ok(!JSON.stringify(result).includes("1.0.2"));
    assert.ok(!JSON.stringify(result).includes("draft_only"));
  });

  it("describes a capability: typed inputs, outputs, outcomes and safe examples only", () => {
    const detail = getCapability(caps, SAVINGS);
    assert.ok(!("status" in detail), JSON.stringify(detail));
    assert.equal(detail.version, "1.0.1");
    assert.deepEqual(detail.versions, ["1.0.0", "1.0.1"]);
    assert.deepEqual(detail.inputSchema, {
      type: "object",
      properties: { member_id: { type: "string", pattern: "^\\d{5}$", description: "The member's 5-digit member ID." } },
      required: ["member_id"],
      additionalProperties: false,
    });
    assert.deepEqual(Object.keys(detail.outputs), ["savings_balance"]);
    assert.equal(detail.outputs.savings_balance!.type, "currency");
    assert.deepEqual(detail.outcomes.statuses, ["SUCCESS", "BUSINESS_OUTCOME", "FAILED", "NEEDS_HUMAN"]);
    for (const code of ["INVALID_INPUT", "NOT_FOUND", "NO_ACCOUNT", "PERMISSION_DENIED"]) assert.ok(detail.outcomes.businessOutcomeCodes.includes(code), code);
    // The phrase with a real member ID and the one with an undeclared placeholder are left out.
    assert.deepEqual(detail.examples, readJson(path.join(ROOT, "capabilities", "phrases.json"))[SAVINGS]);
    // Page steps, locators, login and provenance are not part of the contract.
    for (const key of ["steps", "login", "start", "conditionalSteps", "provenance", "success"]) assert.ok(!(key in detail), key);
    assert.ok(!/credential|password/i.test(JSON.stringify(detail)));
    assert.equal((getCapability(caps, SAVINGS, "1.0.0") as { version: string }).version, "1.0.0");
  });

  it("refuses drafts, unknown versions and unknown names", () => {
    assert.match((getCapability(caps, SAVINGS, "1.0.2") as { reason: string }).reason, /1\.0\.2 is not a reusable version/);
    assert.match((getCapability(caps, SAVINGS, "9.9.9") as { reason: string }).reason, /not a reusable version/);
    assert.match((getCapability(caps, "member.draft_only") as { reason: string }).reason, /No reusable capability/);
    assert.match((getCapability(caps, "member.transfer_money") as { reason: string }).reason, /No reusable capability/);
    assert.match((getCapability(caps, "../secrets") as { reason: string }).reason, /not a capability name/);
    for (const r of [getCapability(caps, SAVINGS, "1.0.2"), getCapability(caps, "member.draft_only")]) assert.equal((r as { status?: string }).status, "REFUSED");
  });

  it("reports an unreadable reusable workflow instead of hiding it", () => {
    const broken = capsCopy();
    writeFileSync(path.join(broken, CHECKING, "1.0.1.json"), "{ not json");
    const result = listCapabilities(broken);
    assert.ok(!("status" in result));
    assert.deepEqual(result.capabilities.map((c) => c.name), [SAVINGS]);
    assert.match(result.unavailable![0]!.reason, /not valid JSON/);
  });
});

describe("capability execution through deterministic replay", () => {
  const caps = capsCopy();
  const banks: Array<() => void> = [];
  before(async () => {
    banks.push(await startBank(PORT));
    banks.push(await startBank(NOTICE_PORT, { BANK_NOTICE: "on" }));
    banks.push(await startBank(ERROR_PORT, { BANK_SERVER_ERROR: "search" }));
  });
  after(() => banks.forEach((stop) => stop()));

  it("returns SUCCESS with the declared output, no LLM, and a clean run folder", async () => {
    const result = executed(await executeCapability(caps, SAVINGS, { member_id: "10048" }, { config: config(PORT) }));
    assert.deepEqual([result.status, result.outputs], ["SUCCESS", { savings_balance: "$2,800.40" }]);
    assert.deepEqual(result.capability, { name: SAVINGS, version: "1.0.1" }); // not the newer 1.0.2 draft
    assert.equal(result.metrics.llmCalls, 0);
    assert.ok(!path.isAbsolute(result.runDir), "no local absolute path in the result");
    const started = readFileSync(path.join(result.runDir, "run.jsonl"), "utf8").split("\n")[0]!;
    assert.match(started, /"type":"replay_started".*"status":"reusable"/);
    assertCleanRun(result, "10048");
    const checking = executed(await executeCapability(caps, CHECKING, { member_id: "10050" }, { config: config(PORT) }));
    assert.deepEqual([checking.status, checking.outputs], ["SUCCESS", { checking_status: "Active" }]);
  });

  it("keeps the existing outcomes: not found, invalid input, unknown dialog, bank error", async () => {
    const notFound = executed(await executeCapability(caps, SAVINGS, { member_id: "99999" }, { config: config(PORT) }));
    assert.deepEqual([notFound.status, notFound.businessOutcome?.code, notFound.outputs], ["BUSINESS_OUTCOME", "NOT_FOUND", undefined]);
    assertCleanRun(notFound, "99999");

    const invalid = executed(await executeCapability(caps, SAVINGS, { member_id: "1234" }, { config: config(PORT) }));
    assert.deepEqual([invalid.status, invalid.businessOutcome?.code, invalid.metrics.steps], ["BUSINESS_OUTCOME", "INVALID_INPUT", 0]);

    const dialog = executed(await executeCapability(caps, SAVINGS, { member_id: "10048" }, { config: config(NOTICE_PORT), version: "1.0.0" }));
    assert.deepEqual([dialog.status, dialog.stopReason], ["NEEDS_HUMAN", "UNEXPECTED_DIALOG"]);

    const error = executed(await executeCapability(caps, SAVINGS, { member_id: "10048" }, { config: config(ERROR_PORT) }));
    assert.deepEqual([error.status, error.stopReason], ["FAILED", "BANK_ERROR"]);
    assert.deepEqual([0, 0, 2, 1], [notFound, invalid, dialog, error].map(exitCodeOf));
  });

  it("hands a stop to a person and resumes, as replay does", async () => {
    let asked = 0;
    const person: HumanChannel = {
      async waitForPerson(_request, session) {
        asked++;
        const page: Page = session.livePageForTests();
        await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
        await page.waitForTimeout(300);
        return "done";
      },
    };
    const result = executed(
      await executeCapability(caps, SAVINGS, { member_id: "10048" }, { config: config(NOTICE_PORT), version: "1.0.0", handoff: person }),
    );
    assert.deepEqual([result.status, result.outputs, asked], ["SUCCESS", { savings_balance: "$2,800.40" }, 1]);
    assert.deepEqual(result.handoffs?.map((h) => [h.stopReason, h.end]), [["UNEXPECTED_DIALOG", "done"]]);
    assertCleanRun(result, "10048");
  });

  it("refuses before running anything: drafts, unknown names and bad arguments", async () => {
    const cfg = config(PORT);
    const cases: Array<[string, unknown, string | undefined, RegExp]> = [
      [SAVINGS, { member_id: "10048" }, "1.0.2", /not a reusable version/],
      ["member.draft_only", { member_id: "10048" }, undefined, /No reusable capability/],
      ["member.transfer_money", { member_id: "10048" }, undefined, /No reusable capability/],
      [SAVINGS, {}, undefined, /Missing input\(s\): member_id/],
      [SAVINGS, { member_id: "10048", password: "x" }, undefined, /Unknown input\(s\): password/],
      [SAVINGS, { member_id: 10048 }, undefined, /must be strings: member_id/],
      [SAVINGS, ["10048"], undefined, /must be a JSON object/],
      [SAVINGS, null, undefined, /must be a JSON object/],
    ];
    for (const [name, args, version, reason] of cases) {
      const result = await executeCapability(caps, name, args, { config: cfg, version });
      assert.equal(result.status, "REFUSED", name);
      assert.match((result as { reason: string }).reason, reason);
      assert.equal(exitCodeOf(result), 3);
    }
    assert.deepEqual(readdirSync(cfg.runsDir), [], "no run folder was created");
  });
});

describe("no LLM in the capability interface", () => {
  it("does not import the LLM code or the discovery loop", () => {
    for (const file of ["capabilities.ts", "capability-cli.ts"]) {
      const source = readFileSync(path.join(ROOT, "automation/src/agent", file), "utf8");
      assert.ok(!/from "(\.\.\/llm\/|\.\.\/discover|openai)/.test(source), file);
    }
  });
});

describe("capability command line", () => {
  const caps = capsCopy();
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "tsx", "automation/src/agent/capability-cli.ts", ...args, "--capabilities", caps], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      cwd: ROOT,
    });

  it("parses the three commands and refuses anything else", () => {
    const parse = (argv: string[]) => parseCapabilityArgs(argv, ROOT);
    assert.equal(parse(["list"]).command, "list");
    assert.deepEqual([parse(["get", SAVINGS, "--version", "1.0.0"]).name, parse(["get", SAVINGS, "--version", "1.0.0"]).version], [SAVINGS, "1.0.0"]);
    assert.deepEqual(parse(["execute", SAVINGS, "--args", '{"member_id":"10048"}', "--handoff"]).args, { member_id: "10048" });
    for (const bad of [[], ["run"], ["get"], ["execute", SAVINGS], ["execute", SAVINGS, "--args", "{bad"], ["get", SAVINGS, "--version", "1.0.0."], ["list", "--handoff"]]) {
      assert.throws(() => parse(bad), UsageError, bad.join(" "));
    }
  });

  it("prints JSON only and uses the replay exit codes", () => {
    const list = run(["list"]);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).capabilities.map((c: { name: string }) => c.name), [SAVINGS, CHECKING].sort());

    const draft = run(["get", SAVINGS, "--version", "1.0.2"]);
    assert.deepEqual([draft.status, JSON.parse(draft.stdout).status], [3, "REFUSED"]);

    const headless = run(["execute", SAVINGS, "--args", '{"member_id":"10048"}', "--handoff"], {
      BROWSER_HEADLESS: "on",
      BANK_LOGIN_USERNAME: TEST_USERNAME,
      BANK_LOGIN_PASSWORD: TEST_PASSWORD,
    });
    assert.equal(headless.status, 3);
    assert.match(JSON.parse(headless.stdout).reason, /--handoff needs a visible browser/);
  });
});
