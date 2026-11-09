// Full discovery runs against a real mock bank with a scripted fake LLM.
// These check the loop, safety stops, limits, verification and redaction
// without any API calls.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { discover, type DiscoveryTask } from "../src/discover.js";
import { execSync } from "node:child_process";
import { BrowserSession, type PageNode } from "../src/browser.js";
import { Redactor, pageKey } from "../src/redact.js";
import {
  ScriptedProvider,
  assertNoLeaks,
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

const PORT = 4310;
const why = { reason: "test step" };

const savingsTask = (memberId = "10042"): DiscoveryTask => ({
  goal: `Get the savings balance for member ${memberId}`,
  inputs: { member_id: memberId },
  outputs: { savings_balance: "currency" },
  allowLogout: false,
});

const readBalance: ScriptStep = (p) => ({
  tool: "read",
  args: { ref: refOf(p, /: \$[\d,]+\.\d{2}/), output: "savings_balance", ...why },
});
const finishSuccess: ScriptStep = () => ({ tool: "finish", args: { status: "success", summary: "done" } });

function savedText(runDir: string): string {
  return ["run.jsonl", "result.json", "failure-snapshot.txt"]
    .map((f) => path.join(runDir, f))
    .filter(existsSync)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

describe("discovery with a scripted LLM", () => {
  let stopBank: () => void;
  before(async () => {
    stopBank = await startBank(PORT);
  });
  after(() => stopBank());

  it("finds and verifies a savings balance without leaking anything", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, click("Savings Account"), readBalance, finishSuccess]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);

    assert.equal(result.status, "SUCCESS", JSON.stringify(result.verification));
    assert.deepEqual(result.outputs, { savings_balance: "$5,200.75" });
    assert.equal(result.verification?.passed, true);
    assert.equal(result.metrics.steps, 8);
    assert.equal(result.metrics.llmCalls, 8);
    assert.deepEqual(result.model.actual, ["scripted-test-model"]);

    // The LLM never saw credentials, the member ID or the member's name.
    const shown = llm.requests.map((r) => r.user + r.system).join("\n");
    for (const leak of [TEST_USERNAME, TEST_PASSWORD, "10042", "John Smith"]) assert.ok(!shown.includes(leak), `LLM saw ${leak}`);

    // Saved logs hold none of those, nor the balance; result.json holds the declared output only.
    const log = readFileSync(path.join(result.runDir, "run.jsonl"), "utf8");
    for (const leak of [TEST_USERNAME, TEST_PASSWORD, "10042", "John Smith", "5,200.75", "sk-test"]) {
      assert.ok(!log.includes(leak), `log contains ${leak}`);
    }
    const saved = JSON.parse(readFileSync(path.join(result.runDir, "result.json"), "utf8"));
    assert.equal(saved.outputs.savings_balance, "$5,200.75");
    assert.equal(saved.runDir, undefined, "no local absolute path is saved");
    assert.ok(!existsSync(path.join(result.runDir, "failure-snapshot.txt")));

    // Each step entry names its element by role and name, for Module 3.
    const steps = log.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "step");
    assert.deepEqual(steps[3].target, { role: "textbox", name: "Member ID", heading: "Member Search" });
    // A nameless text element is recorded with its label and section heading.
    assert.deepEqual(steps[6].target, { role: "generic", text: "$[amount]", label: "Balance", heading: "Savings Account" });
    assert.deepEqual(steps[3].value, { input: "member_id" });
    assert.deepEqual(steps[1].value, { credential: "password" });
  });

  it("reports member not found as a business outcome", async () => {
    const llm = new ScriptedProvider([
      ...loginSteps,
      ...searchSteps,
      (p) => ({
        tool: "finish",
        args: { status: "business_outcome", outcome_code: "NOT_FOUND", evidence_ref: refOf(p, "Member not found."), summary: "s" },
      }),
    ]);
    const result = await discover(savingsTask("99999"), testConfig(PORT), llm);
    assert.equal(result.status, "BUSINESS_OUTCOME");
    assert.deepEqual(result.businessOutcome, { code: "NOT_FOUND", message: "Member not found." });
    assert.equal(result.outputs, undefined);
    assertNoLeaks(result.runDir, llm, ["99999"]);
  });

  it("rejects a business outcome whose evidence is a control, not a message", async () => {
    const llm = new ScriptedProvider([
      ...loginSteps,
      ...searchSteps,
      (p) => ({
        tool: "finish",
        args: { status: "business_outcome", outcome_code: "NOT_FOUND", evidence_ref: refOf(p, 'button "Savings Account"'), summary: "s" },
      }),
    ]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.status, "FAILED");
    assert.equal(result.stopReason, "VERIFICATION_FAILED");
    assert.equal(result.businessOutcome, undefined);
  });

  it("refuses to read the member's name and never shows or saves it", async () => {
    const readName: ScriptStep = (p) => ({
      tool: "read",
      args: { ref: refOf(p, "generic: [redacted]"), output: "savings_balance", ...why },
    });
    // Reading the whole details card would capture the name inside other text.
    const readCard: ScriptStep = (p) => ({
      tool: "read",
      args: { ref: refOf(p, 'heading "Member Details"').replace(/e(\d+)$/, (_m, n) => `e${Number(n) - 1}`), output: "savings_balance", ...why },
    });
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, readCard, readName]);
    const result = await discover(savingsTask(), testConfig(PORT, { DISCOVERY_MAX_FAILURES: "1" }), llm);
    assert.equal(result.stopReason, "CONSECUTIVE_FAILURES", JSON.stringify(result));
    assert.match(result.reason ?? "", /protected data/);
    // The card read did run; its captured text came back with the name scrubbed.
    assert.match(llm.requests.at(-1)!.user, /Captured output "savings_balance" = .*\[redacted\]/s);
    assertNoLeaks(result.runDir, llm, ["10042"]);
  });

  it("stops with NEEDS_HUMAN before a risky click and saves a sanitized snapshot only", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, click("Edit Profile")]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.status, "NEEDS_HUMAN");
    assert.match(result.reason ?? "", /Edit Profile/);
    const snapshot = readFileSync(path.join(result.runDir, "failure-snapshot.txt"), "utf8");
    assert.match(snapshot, /button "Edit Profile"/);
    for (const leak of ["10042", "John Smith", TEST_PASSWORD]) assert.ok(!snapshot.includes(leak), leak);
    assert.ok(!existsSync(path.join(result.runDir, "failure.png")), "no screenshot by default");
    assertNoLeaks(result.runDir, llm, ["10042"]);
  });

  it("refuses a button label as a profile status, then stops before the risky Edit Profile click", async () => {
    const profileTask: DiscoveryTask = {
      goal: "Open Edit Profile for member 10042 and report the message shown",
      inputs: { member_id: "10042" },
      outputs: { profile_status: "text" },
      allowLogout: false,
    };
    const readButton: ScriptStep = (p) => ({ tool: "read", args: { ref: refOf(p, 'button "Edit Profile"'), output: "profile_status", ...why } });
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, readButton, click("Edit Profile")]);
    const result = await discover(profileTask, testConfig(PORT), llm);
    assert.equal(result.status, "NEEDS_HUMAN", JSON.stringify(result));
    assert.match(result.reason ?? "", /Edit Profile/);
    assert.equal(result.outputs, undefined);
    // The label read was refused and the LLM was told why; the risky click never ran.
    assert.match(llm.requests.at(-1)!.user, /its label is not a value/);
    const steps = readFileSync(path.join(result.runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "step");
    assert.deepEqual(steps.slice(-2).map((e) => [e.kind, e.outcome]), [["read", "refused"], ["click", "needs_human"]]);
    assertNoLeaks(result.runDir, llm, ["10042"]);
  });

  it("stops with NEEDS_HUMAN for a click matching a configured risky keyword", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, click("Loans")]);
    const result = await discover(savingsTask(), testConfig(PORT, { SAFETY_RISKY_KEYWORDS: "Loans" }), llm);
    assert.equal(result.status, "NEEDS_HUMAN");
    assert.match(result.reason ?? "", /risky keyword "Loans"/);
  });

  it("navigates to an approved page", async () => {
    const llm = new ScriptedProvider([
      ...loginSteps,
      () => ({ tool: "navigate", args: { path: "/members", ...why } }),
      () => ({ tool: "request_human", args: { reason: "stop here" } }),
    ]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.status, "NEEDS_HUMAN");
    const log = readFileSync(path.join(result.runDir, "run.jsonl"), "utf8");
    const nav = log.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "navigate");
    assert.equal(nav.outcome, "done");
    assert.equal(nav.path, "/members");
  });

  it("stops after two refused steps in a row", async () => {
    const llm = new ScriptedProvider([
      ...loginSteps,
      click("Log Out"),
      () => ({ tool: "navigate", args: { path: "/admin", ...why } }),
    ]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.status, "FAILED");
    assert.equal(result.stopReason, "CONSECUTIVE_FAILURES");
    assertNoLeaks(result.runDir, llm);
  });

  it("stops before repeating the same step on an unchanged page", async () => {
    const wait: ScriptStep = () => ({ tool: "wait_for", args: { text: "Member Search", state: "visible", timeout_seconds: 2, ...why } });
    const llm = new ScriptedProvider([...loginSteps, wait, wait]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.stopReason, "REPEATED_STEP");
    assert.equal(result.metrics.steps, 4, "the repeated step is not executed");
  });

  it("offers only finish and request_human once every output is captured (live run 8 re-read)", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, click("Savings Account"), readBalance, finishSuccess]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    const offered = llm.requests.map((r) => r.tools.map((t) => t.name).sort());
    assert.ok(offered.at(-2)!.includes("read"), "read is offered before the output is captured");
    assert.deepEqual(offered.at(-1), ["finish", "request_human"], "after the read, only finishing or asking a person");
  });

  it("does not mistake reads of two different text elements for a repeat", async () => {
    const readLabel: ScriptStep = (p) => ({
      tool: "read",
      args: { ref: refOf(p, "generic: Balance"), output: "savings_balance", ...why },
    });
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, click("Savings Account"), readLabel, readBalance, finishSuccess]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.outputs, { savings_balance: "$5,200.75" });
    const shown = llm.requests.at(-1)!.user;
    assert.match(shown, /Captured output "savings_balance" = "\$5,200\.75"/);
    const log = readFileSync(path.join(result.runDir, "run.jsonl"), "utf8");
    assert.match(log, /= \\"\$\[amount\]\\"/);
  });

  it("stops with NEEDS_HUMAN when the LLM asks for a person, and redacts its reason", async () => {
    const llm = new ScriptedProvider([
      ...loginSteps,
      ...searchSteps,
      click("Savings Account"),
      () => ({ tool: "request_human", args: { reason: "Balance shows $5,200.75 for 10042, please check" } }),
    ]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.status, "NEEDS_HUMAN");
    assert.equal(result.reason, "Balance shows $[amount] for <input:member_id>, please check");
    const saved = readFileSync(path.join(result.runDir, "result.json"), "utf8");
    assert.ok(!saved.includes("5,200.75"));
    assertNoLeaks(result.runDir, llm, ["10042"]);
  });

  it("stops at the time limit without acting on a late reply", async () => {
    const late: ScriptStep = (p) => ({
      tool: "fill",
      args: { ref: refOf(p, 'textbox "Username"'), value: { credential: "username" }, ...why },
      delayMs: 10_500,
    });
    const llm = new ScriptedProvider([late]);
    const result = await discover(savingsTask(), testConfig(PORT, { DISCOVERY_MAX_SECONDS: "10" }), llm);
    assert.equal(result.stopReason, "TIME_LIMIT");
    assert.equal(result.metrics.steps, 0, "the late step was not run");
    assert.ok(result.metrics.durationMs < 12_000);
  });

  it("caps a wait at the time left", async () => {
    const longWait: ScriptStep = () => ({
      tool: "wait_for",
      args: { text: "Text that never appears", state: "visible", timeout_seconds: 15, ...why },
    });
    const llm = new ScriptedProvider([longWait, longWait]);
    const result = await discover(savingsTask(), testConfig(PORT, { DISCOVERY_MAX_SECONDS: "10" }), llm);
    assert.equal(result.stopReason, "TIME_LIMIT");
    assert.ok(result.metrics.durationMs < 12_000, `took ${result.metrics.durationMs} ms`);
  });

  it("stops at the step limit", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps]);
    const result = await discover(savingsTask(), testConfig(PORT, { DISCOVERY_MAX_STEPS: "3" }), llm);
    assert.equal(result.stopReason, "STEP_LIMIT");
    assert.equal(result.metrics.steps, 3);
  });

  it("stops at the LLM call limit", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps]);
    const result = await discover(savingsTask(), testConfig(PORT, { DISCOVERY_MAX_LLM_CALLS: "2" }), llm);
    assert.equal(result.stopReason, "LLM_CALL_LIMIT");
    assert.equal(result.metrics.llmCalls, 2);
  });

  it("rejects a success claim that was never read from the page", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, click("Savings Account"), finishSuccess]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.stopReason, "VERIFICATION_FAILED");
    assert.equal(result.outputs, undefined);
  });

  it("rejects a value read from the wrong account", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, click("Checking Account"), readBalance, finishSuccess]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.stopReason, "VERIFICATION_FAILED");
    const heading = result.verification?.checks.find((c) => c.check.includes("heading"));
    assert.equal(heading?.passed, false);
  });

  it("counts invalid LLM replies as failures", async () => {
    const llm = new ScriptedProvider([() => ({ tool: "select", args: {} }), () => ({ tool: "click", args: { ref: "e1" } })]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.stopReason, "CONSECUTIVE_FAILURES");
  });

  it("counts a reply with no step, or with unreadable arguments, as a failure", async () => {
    const llm = new ScriptedProvider([() => ({}), () => ({ tool: "click", args: undefined })]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.stopReason, "CONSECUTIVE_FAILURES");
    assert.equal(result.metrics.steps, 2);
  });

  it("records an unexpected error as FAILED and closes the browser", async () => {
    const browsers = () => {
      try {
        // Only browsers started by this test process; other test files run in parallel.
        return Number(execSync(`pgrep -P ${process.pid} -f chrome-headless-shell | wc -l`).toString().trim());
      } catch {
        return 0;
      }
    };
    const before = browsers();
    const broken = new ScriptedProvider([]);
    broken.nextStep = async () => ({ toolName: "click", model: "m" }) as never; // no usage: throws in the loop
    const result = await discover(savingsTask(), testConfig(PORT), broken);
    assert.equal(result.status, "FAILED");
    assert.equal(result.stopReason, "UNEXPECTED_ERROR");
    assert.ok(existsSync(path.join(result.runDir, "result.json")));
    assert.ok(browsers() <= before, "browser left running");
  });

  it("reports whether the password box is filled, never its value", async () => {
    const session = await BrowserSession.open(true);
    try {
      await session.goto(`http://localhost:${PORT}/login`);
      const passwordBox = (nodes: PageNode[]): PageNode | undefined => {
        for (const n of nodes) {
          if (n.role === "textbox" && n.name === "Password") return n;
          const inner = n.children && passwordBox(n.children);
          if (inner) return inner;
        }
        return undefined;
      };
      const redactor = new Redactor({}, [TEST_USERNAME, TEST_PASSWORD], ["Member Name"]);
      const empty = await session.view();
      assert.deepEqual([passwordBox(empty.nodes)?.secret, passwordBox(empty.nodes)?.filled], [true, undefined]);
      assert.ok(!redactor.pageForLlm(empty).includes("[filled]"));

      await session.fill(passwordBox(empty.nodes)!.ref!, TEST_PASSWORD);
      const filled = await session.view();
      const box = passwordBox(filled.nodes)!;
      assert.deepEqual([box.secret, box.filled, box.text], [true, true, undefined]);
      assert.ok(!JSON.stringify(filled).includes(TEST_PASSWORD), "the value is not kept in the page view");
      for (const page of [redactor.pageForLlm(filled), redactor.pageForLog(filled)]) {
        assert.match(page, /textbox "Password" \(value hidden\) \[filled\]/);
        assert.ok(!page.includes(TEST_PASSWORD));
      }
      assert.notEqual(pageKey(empty), pageKey(filled), "filling the box changes the page for the repeat check");
    } finally {
      await session.close();
    }
  });

  it("lets the LLM see the password is filled, and logs a truly repeated step's target safely", async () => {
    const fillPassword: ScriptStep = (p) => ({ tool: "fill", args: { ref: refOf(p, 'textbox "Password"'), value: { credential: "password" }, ...why } });
    // Fill the password, fill it again on the now-[filled] page (allowed: the page changed),
    // then a third time on the same page: a true repeat that must still stop the run.
    const llm = new ScriptedProvider([loginSteps[0]!, loginSteps[1]!, fillPassword, fillPassword]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.deepEqual([result.status, result.stopReason], ["FAILED", "REPEATED_STEP"]);
    assert.ok(!llm.requests[1]!.user.includes("[filled]"), "before step 2 the box is empty");
    assert.match(llm.requests[2]!.user, /textbox "Password" \(value hidden\) \[filled\]/);
    const entries = readFileSync(path.join(result.runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entries.filter((e) => e.type === "step").length, 3);
    const blocked = entries.find((e) => e.type === "step_blocked");
    assert.deepEqual(
      { kind: blocked.kind, target: blocked.target, value: blocked.value },
      { kind: "fill", target: { role: "textbox", name: "Password", heading: "Employee Sign In" }, value: { credential: "password" } },
    );
    assertNoLeaks(result.runDir, llm, ["10042"]);
  });

  it("paints over protected values in screenshots", async () => {
    const session = await BrowserSession.open(true);
    try {
      await session.goto(`http://localhost:${PORT}/login`);
      let view = await session.view();
      const find = (nodes: PageNode[], test: (n: PageNode) => boolean): PageNode | undefined => {
        for (const n of nodes) {
          if (test(n)) return n;
          const inner = n.children && find(n.children, test);
          if (inner) return inner;
        }
        return undefined;
      };
      const ref = (test: (n: PageNode) => boolean) => find(view.nodes, test)!.ref!;
      await session.fill(ref((n) => n.name === "Username"), TEST_USERNAME);
      await session.fill(ref((n) => n.name === "Password"), TEST_PASSWORD);
      await session.click(ref((n) => n.name === "Sign In"));
      await session.goto(`http://localhost:${PORT}/members?memberId=10042`);
      view = await session.view();
      const masked = session.sensitiveRefs(["Member Name"], ["10042"]);
      assert.ok(masked.includes(ref((n) => n.text === "John Smith")), "member name");
      assert.ok(masked.includes(ref((n) => n.role !== "textbox" && n.text === "10042")), "member ID text");
      assert.ok(masked.includes(ref((n) => n.role === "textbox" && n.name === "Member ID")), "text box");
      assert.ok(!masked.includes(ref((n) => n.name === "Savings Account")), "ordinary button stays visible");
      assert.ok((await session.screenshot(masked)).length > 0);
    } finally {
      await session.close();
    }
  });

  it("stops cleanly when the LLM service fails", async () => {
    const llm = new ScriptedProvider([() => new Error("service unavailable")]);
    const result = await discover(savingsTask(), testConfig(PORT), llm);
    assert.equal(result.stopReason, "LLM_ERROR");
    assert.ok(existsSync(path.join(result.runDir, "failure-snapshot.txt")));
    assert.ok(!savedText(result.runDir).includes(TEST_PASSWORD));
  });
});

describe("discovery with the System Notice popup", () => {
  const NOTICE_PORT = 4311;
  let stopBank: () => void;
  before(async () => {
    stopBank = await startBank(NOTICE_PORT, { BANK_NOTICE: "on" });
  });
  after(() => stopBank());

  it("acknowledges the notice, then completes the task", async () => {
    const llm = new ScriptedProvider([
      ...loginSteps,
      ...searchSteps,
      click("Acknowledge"),
      click("Savings Account"),
      readBalance,
      finishSuccess,
    ]);
    const result = await discover(savingsTask(), testConfig(NOTICE_PORT), llm);
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.equal(result.metrics.steps, 9);
  });
});

describe("discovery with a slow bank (E-8)", () => {
  const SLOW_PORT = 4312;
  let stopBank: () => void;
  before(async () => {
    stopBank = await startBank(SLOW_PORT, { BANK_SLOW_MS: "2500" });
  });
  after(() => stopBank());

  it("waits for the loading message to go, then reads the balance", async () => {
    let sawLoading = false;
    const waitLoaded: ScriptStep = (p) => {
      sawLoading = p.includes("Loading savings account");
      return { tool: "wait_for", args: { text: "Loading savings account…", state: "hidden", timeout_seconds: 10, ...why } };
    };
    const llm = new ScriptedProvider([
      ...loginSteps,
      ...searchSteps,
      click("Savings Account"),
      waitLoaded,
      readBalance,
      finishSuccess,
    ]);
    const result = await discover(savingsTask(), testConfig(SLOW_PORT), llm);
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.ok(sawLoading, "the LLM was shown the loading message");
  });
});

describe("discovery with session expiry (E-7)", () => {
  const TTL_PORT = 4313;
  let stopBank: () => void;
  before(async () => {
    stopBank = await startBank(TTL_PORT, { BANK_SESSION_TTL_SECONDS: "6" });
  });
  after(() => stopBank());

  it("logs in again after being sent back to the login page, with raised limits", async () => {
    const idle: ScriptStep = () => ({
      tool: "wait_for",
      args: { text: "Text that never appears", state: "visible", timeout_seconds: 7, ...why },
    });
    let sawExpired = false;
    const checkExpired: ScriptStep = (p) => {
      sawExpired = p.includes("Session expired");
      return loginSteps[0]!(p);
    };
    const llm = new ScriptedProvider([
      ...loginSteps,
      idle, // the session expires while waiting
      ...searchSteps, // → sent back to the login page
      checkExpired,
      ...loginSteps.slice(1),
      ...searchSteps,
      click("Savings Account"),
      readBalance,
      finishSuccess,
    ]);
    const config = testConfig(TTL_PORT, {
      DISCOVERY_MAX_STEPS: "20",
      DISCOVERY_MAX_LLM_CALLS: "20",
      DISCOVERY_MAX_FAILURES: "3",
      DISCOVERY_MAX_SECONDS: "60",
    });
    const result = await discover(savingsTask(), config, llm);
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.ok(sawExpired, "the login page said the session expired");
    assert.equal(result.metrics.steps, 14);
  });
});
