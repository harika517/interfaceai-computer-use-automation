// Module 5 tests (D-051): human handoff. A scripted person acts on the very
// same live Playwright page the automation drives (real input events, so
// the page listener records them), then hands control back. No LLM in the
// replay tests; discovery uses the scripted fake LLM.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Page } from "playwright";
import { BrowserSession } from "../src/browser.js";
import { StepCheckpoint } from "../src/checkpoint.js";
import { readReplayConfig, type ReplayConfig } from "../src/config.js";
import { discover, type DiscoveryTask, type RunResult } from "../src/discover.js";
import { ControlState } from "../src/control.js";
import { PassThrough } from "node:stream";
import { terminalChannel, type HumanAnswer, type HumanChannel, type InterventionRequest } from "../src/handoff.js";
import { Redactor } from "../src/redact.js";
import { replayWorkflow, type ReplayResult } from "../src/replay/replay.js";
import { RunLog } from "../src/run-log.js";
import { bankSafetyRules } from "../src/safety.js";
import { Workflow, type Target } from "../src/workflow/schema.js";
import { RecordingRefused, readRun } from "../src/workflow/read-run.js";
import { loadWorkflow } from "../src/workflow/store.js";
import { ScriptedProvider, TEST_PASSWORD, TEST_USERNAME, assertNoLeaks, click, loginSteps, refOf, searchSteps, startBank, testConfig, type ScriptStep } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CAPS = path.join(ROOT, "capabilities");
const SAVINGS = "member.get_savings_balance";
const MEMBERS = JSON.parse(readFileSync(path.join(ROOT, "mock-bank/data/members.json"), "utf8")).members as Array<{ memberId: string; memberName: string }>;

const temp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
const config = (port: number, extra: Record<string, string> = {}, handoff?: Partial<ReplayConfig["handoff"]>): ReplayConfig => {
  const c = readReplayConfig({
    BANK_URL: `http://localhost:${port}`,
    BANK_LOGIN_USERNAME: TEST_USERNAME,
    BANK_LOGIN_PASSWORD: TEST_PASSWORD,
    BROWSER_HEADLESS: "on",
    REPLAY_RUNS_DIR: temp("handoff-runs-"),
    ...extra,
  });
  return { ...c, handoff: { ...c.handoff, ...handoff } };
};
const workflowOf = (version = "1.0.1") => loadWorkflow(CAPS, SAVINGS, version);
const target = (primary: Target["primary"]): Target => ({ primary, fallbacks: [], why: "test" });
const edited = (change: (w: Workflow) => void): Workflow => {
  const copy = structuredClone(workflowOf());
  change(copy);
  return Workflow.parse(copy);
};
// Point a click step at a button that does not exist, so it stops quickly.
const breakClick = (w: Workflow, id: string) => {
  const step = w.steps.find((s) => s.id === id);
  if (!step || step.kind !== "click") throw new Error(`no click step ${id}`);
  step.timeoutSeconds = 1;
  step.target = target({ role: "button", name: "No Such Button" });
};

const entries = (result: ReplayResult | RunResult) =>
  readFileSync(path.join(result.runDir, "run.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

// Nothing secret or personal in any saved file, including handoff-N.json.
function assertCleanRun(result: ReplayResult, memberIds: string[]): void {
  for (const file of readdirSync(result.runDir)) {
    const text = readFileSync(path.join(result.runDir, file), "utf8");
    for (const secret of [TEST_PASSWORD, TEST_USERNAME]) assert.ok(!text.includes(secret), `${file} contains a credential`);
    for (const id of memberIds) {
      assert.ok(!new RegExp(`(?<!\\d)${id}(?!\\d)`).test(text), `${file} contains member ID ${id}`);
      const name = MEMBERS.find((m) => m.memberId === id)?.memberName;
      if (name) assert.ok(!text.includes(name), `${file} contains a member name`);
    }
    const withoutOutputs = file === "result.json" ? JSON.stringify({ ...JSON.parse(text), outputs: undefined }) : text;
    assert.ok(!/\$\d/.test(withoutOutputs), `${file} contains an amount outside the outputs`);
  }
}

// A scripted person: each handoff runs the next act on the live page.
// "wait" never answers, so only the timeout or a closed window ends it.
type Act = (page: Page, request: InterventionRequest) => Promise<HumanAnswer | "wait">;
function person(...acts: Act[]) {
  const requests: InterventionRequest[] = [];
  const pages: Page[] = [];
  let aborted = 0;
  const channel: HumanChannel = {
    async waitForPerson(request, session, signal) {
      requests.push(request);
      signal.addEventListener("abort", () => aborted++);
      const act = acts[requests.length - 1];
      if (!act) throw new Error("The scripted person has nothing more to do.");
      const page = session.livePageForTests();
      pages.push(page);
      const answer = await act(page, request);
      if (answer === "wait") return new Promise<HumanAnswer>(() => {});
      await page.waitForTimeout(300); // let the page report the last action
      return answer;
    },
  };
  return { channel, requests, pages, aborted: () => aborted };
}
const clickButton = (name: string): Act => async (page) => {
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForLoadState("load");
  return "done";
};

// A browser whose page and session the test can inspect after the run.
function trackedBrowser() {
  const opened: BrowserSession[] = [];
  return {
    opened,
    open: async (headless: boolean) => {
      const session = await BrowserSession.open(headless);
      opened.push(session);
      return session;
    },
  };
}

// ---------- unit: control ownership ----------

describe("who is in control", () => {
  it("changes owner with a new epoch each time and logs it", () => {
    const log = RunLog.create(temp("handoff-runs-"));
    const control = new ControlState(log);
    assert.deepEqual([control.owner, control.epoch], ["automation", 0]);
    assert.equal(control.transfer("human", "test"), 1);
    assert.throws(() => control.transfer("human", "again"), /already with human/);
    assert.equal(control.transfer("automation", "back"), 2);
    assert.deepEqual(control.history.map((c) => [c.from, c.to, c.epoch]), [["automation", "human", 1], ["human", "automation", 2]]);
    assert.equal(readFileSync(path.join(log.dir, "run.jsonl"), "utf8").match(/"type":"control_changed"/g)?.length, 2);
  });

  it("the shared step checkpoint refuses every automated step while a person is in control", async () => {
    let clicked = 0;
    const browser = {
      url: () => "http://localhost:4000/members",
      describe: () => ({ role: "button", name: "Savings Account" }),
      isSecret: () => false,
      click: async () => void clicked++,
    } as unknown as BrowserSession;
    const control = new ControlState();
    const log = RunLog.create(temp("handoff-runs-"));
    const checkpoint = new StepCheckpoint({
      browser,
      rules: bankSafetyRules({ origin: "http://localhost:4000", riskyKeywords: [], sensitiveLabels: [], allowLogout: false, declaredInputs: [], declaredOutputs: [] }),
      log,
      redactor: new Redactor({}, [], []),
      inputs: {},
      credentials: { username: "user-x", password: "pass-x" },
      source: "replay",
      deadline: Date.now() + 10_000,
      control,
    });
    control.transfer("human", "test");
    const refused = await checkpoint.run("click", { ref: "e1", reason: "test" }, 1);
    assert.deepEqual([refused.outcome.status, clicked], ["needs_human", 0]);
    assert.equal(checkpoint.whoIsInControl(), "human");
    control.transfer("automation", "test");
    const ran = await checkpoint.run("click", { ref: "e1", reason: "test" }, 2);
    assert.deepEqual([ran.outcome.status, clicked], ["done", 1]);
    const steps = readFileSync(path.join(log.dir, "run.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(steps.map((s) => [s.controlEpoch, s.outcome]), [[1, "needs_human"], [2, "done"]]);
  });
});

describe("terminal operator control", () => {
  const request = { handoff: 1, maxHandoffs: 2, source: "replay", reason: "A dialog is open.", path: "/members", sessionId: "s", timeoutSeconds: 600, snapshot: "" } as InterventionRequest;
  const session = {} as BrowserSession;
  const ask = (input: PassThrough, signal = new AbortController().signal) => {
    const output = new PassThrough();
    let shown = "";
    output.on("data", (d) => (shown += d));
    return { answer: terminalChannel(input, output).waitForPerson(request, session, signal), shown: () => shown };
  };

  it("Enter hands control back; cancel stops; anything else asks again", async () => {
    const input = new PassThrough();
    const enter = ask(input);
    input.write("\n");
    assert.equal(await enter.answer, "done");
    assert.match(enter.shown(), /A PERSON IS NOW IN CONTROL/);
    assert.match(enter.shown(), /press Enter here to hand control back/);
    const other = new PassThrough();
    const cancel = ask(other);
    other.write("what?\n");
    other.write(" Cancel \n");
    assert.equal(await cancel.answer, "cancel");
    assert.match(cancel.shown(), /Press Enter when you are finished/);
  });

  it("ignores input typed before the handoff began", async () => {
    const input = new PassThrough();
    input.write("\n"); // a stray Enter while automation was in control
    const waiting = ask(input);
    const early = await Promise.race([waiting.answer, new Promise((r) => setTimeout(() => r("still waiting"), 200))]);
    assert.equal(early, "still waiting");
    input.write("cancel\n");
    assert.equal(await waiting.answer, "cancel");
  });

  it("stops waiting when the handoff ends elsewhere, or when the operator's input closes", async () => {
    const abort = new AbortController();
    const waiting = ask(new PassThrough(), abort.signal);
    abort.abort();
    await assert.rejects(waiting.answer);
    const input = new PassThrough();
    const closed = ask(input);
    input.end();
    await assert.rejects(closed.answer);
  });
});

// ---------- end to end: replay handoff on real test banks ----------

describe("replay handoff", () => {
  const NORMAL = 4340;
  const NOTICE = 4341;
  const ERROR = 4342;
  const banks: Array<() => void> = [];
  before(async () => {
    banks.push(await startBank(NORMAL));
    banks.push(await startBank(NOTICE, { BANK_NOTICE: "on" }));
    banks.push(await startBank(ERROR, { BANK_SERVER_ERROR: "search" }));
  });
  after(() => banks.forEach((stop) => stop()));

  it("a person clears an unknown dialog in the same live page, then automation resumes and reads the balance itself", async () => {
    const browser = trackedBrowser();
    const someone = person(clickButton("Acknowledge"));
    let promoted = false;
    const result = await replayWorkflow(workflowOf("1.0.0"), "draft", { member_id: "10048" }, config(NOTICE), {
      handoff: someone.channel,
      openBrowser: browser.open,
      promote: () => {
        promoted = true;
        return { from: "draft", to: "reusable" };
      },
    });
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.outputs, { savings_balance: "$2,800.40" });
    assert.equal(result.metrics.llmCalls, 0);
    assert.ok(result.checks.every((c) => c.passed));

    // The person worked in the very page automation was driving.
    const [session] = browser.opened;
    assert.equal(browser.opened.length, 1, "one browser for the whole run");
    assert.equal(someone.pages[0], session!.livePageForTests(), "the person acted on the same live page object");
    assert.equal(session!.isOpen(), false, "closed at the end");
    assert.equal(session!.watchingHuman(), false, "the action listener is removed");
    assert.equal(someone.aborted(), 1, "the operator prompt was released");

    // One handoff, at the step where the dialog appeared; the search it
    // covered was already done on the page, so it was passed over.
    assert.equal(result.handoffs?.length, 1);
    const h = result.handoffs![0]!;
    assert.deepEqual([h.end, h.stopReason, h.step, h.stepsPassed, h.sessionId], ["done", "UNEXPECTED_DIALOG", "(any)", ["click_search"], session!.sessionId]);
    assert.ok(h.humanActions >= 1);
    assert.deepEqual(result.control?.map((c) => [c.to, c.epoch]), [["human", 1], ["automation", 2]]);

    const log = entries(result);
    const toHuman = log.findIndex((e) => e.type === "control_changed" && e.to === "human");
    const back = log.findIndex((e) => e.type === "control_changed" && e.to === "automation");
    assert.ok(toHuman > 0 && back > toHuman);
    // No automated step while the person was in control; the person's click was recorded.
    assert.deepEqual(log.slice(toHuman, back).filter((e) => e.type === "step"), []);
    const actions = log.slice(toHuman, back).filter((e) => e.type === "human_action");
    assert.ok(actions.some((a) => a.kind === "click" && a.source === "human" && a.element?.role === "button" && a.element?.name === "Acknowledge" && a.controlEpoch === 1 && a.ts));
    assert.deepEqual(log.filter((e) => e.type === "human_action" && log.indexOf(e) > back), [], "automation's own clicks are not recorded as a person's");
    // Same session: no second login, and every resumed step ran under the new epoch.
    assert.equal(log.filter((e) => e.type === "step" && e.value?.credential).length, 2, "logged in once");
    const after = log.slice(back).filter((e) => e.type === "step");
    assert.deepEqual(after.map((e) => [e.kind, e.controlEpoch, e.outcome]), [["click", 2, "done"], ["read", 2, "done"]]);
    for (const type of ["handoff_requested", "resumed", "handoff_finished"]) {
      assert.equal(log.find((e) => e.type === type)?.sessionId, session!.sessionId, type);
    }
    assert.equal(log.find((e) => e.type === "handoff_finished")?.sessionOpen, true);

    // The intervention request tells the person what and why, redacted.
    const request = JSON.parse(readFileSync(path.join(result.runDir, "handoff-1.json"), "utf8")) as InterventionRequest;
    assert.deepEqual([request.workflow, request.stopReason, request.step, request.path], [{ name: SAVINGS, version: "1.0.0" }, "UNEXPECTED_DIALOG", "(any)", "/members"]);
    assert.match(request.reason, /dialog/);
    assert.match(request.snapshot, /System Notice/);
    assert.deepEqual(someone.requests[0], request, "the person was shown the saved request");

    // Never promoted after a person helped.
    assert.equal(promoted, false);
    assert.equal(result.promotion, undefined);
    assert.ok(log.some((e) => e.type === "promotion_refused" && /person/.test(e.reason)));
    assertCleanRun(result, ["10048"]);
  });

  it("passes over steps the person completed, re-checking the page, and records their actions without values", async () => {
    const w = edited((w) => breakClick(w, "click_search"));
    const someone = person(clickButton("Search"));
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(NORMAL), { handoff: someone.channel });
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.outputs, { savings_balance: "$2,800.40" });
    assert.deepEqual(result.handoffs?.map((h) => [h.stopReason, h.step, h.stepsPassed]), [["TARGET_NOT_FOUND", "click_search", ["click_search"]]]);
    const actions = entries(result).filter((e) => e.type === "human_action");
    assert.ok(actions.some((a) => a.kind === "click" && a.element?.name === "Search"));
    assert.ok(!actions.some((a) => a.kind === "input"), "automation's earlier typing is not blamed on the person");
    assert.ok(actions.some((a) => a.kind === "navigation" && a.path === "/members"), "navigation is recorded by path only");
    assertCleanRun(result, ["10048"]);
  });

  it("re-runs the stopped step itself when its checkpoint does not hold after the handoff", async () => {
    // The person does nothing; the dialog is gone only because 1.0.1 knows it.
    const w = edited((w) => breakClick(w, "click_search"));
    let fixed = false;
    const someone = person(async () => {
      fixed = true;
      return "done";
    });
    // After the handoff, click_search is run again with the corrected locator.
    const realSearch = workflowOf().steps.find((s) => s.id === "click_search")!;
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(NORMAL), {
      handoff: {
        waitForPerson: async (request, session, signal) => {
          const step = w.steps.find((s) => s.id === "click_search")!;
          Object.assign(step, structuredClone(realSearch));
          return someone.channel.waitForPerson(request, session, signal);
        },
      },
    });
    assert.ok(fixed);
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.handoffs?.[0]?.stepsPassed, [], "nothing was passed over");
    const after = entries(result).filter((e) => e.type === "step" && e.controlEpoch === 2);
    assert.equal(after[0]?.target?.name, "Search", "the stopped step ran again under automation");
  });

  it("catches a person who searched a different member: the final check fails instead of returning their data", async () => {
    const w = edited((w) => breakClick(w, "click_search"));
    const someone = person(async (page) => {
      const box = page.getByRole("textbox", { name: "Member ID" });
      await box.fill("");
      await box.pressSequentially("10050"); // key by key, like a person
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.waitForLoadState("load");
      return "done";
    });
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(NORMAL), { handoff: someone.channel });
    assert.deepEqual([result.status, result.stopReason, result.outputs], ["FAILED", "SUCCESS_CHECK_FAILED", undefined]);
    assert.ok(result.checks.some((c) => !c.passed && /member_id/.test(c.check)));
    const typed = entries(result).filter((e) => e.type === "human_action" && e.kind === "input");
    assert.deepEqual(typed.map((e) => [e.element?.name, e.value]), [["Member ID", "hidden"]], "typing is one entry, and the value is never recorded");
    assertCleanRun(result, ["10048", "10050"]);
  });

  it("never runs a risky step itself: passes it only when the page shows the person did it", async () => {
    const withRisky = edited((w) => {
      const at = w.steps.findIndex((s) => s.id === "click_savings_account");
      w.steps.splice(at, 0, { kind: "click", id: "click_edit_profile", timeoutSeconds: 5, expect: [{ visible: { text: "Not available in demo." } }], target: target({ role: "button", name: "Edit Profile" }) });
    });
    const someone = person(clickButton("Edit Profile"));
    const result = await replayWorkflow(withRisky, "draft", { member_id: "10048" }, config(NORMAL), { handoff: someone.channel });
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.handoffs?.map((h) => [h.stopReason, h.step, h.stepsPassed]), [["SAFETY_STOP", "click_edit_profile", ["click_edit_profile"]]]);
    const editSteps = entries(result).filter((e) => e.type === "step" && e.target?.name === "Edit Profile");
    assert.deepEqual(editSteps.map((e) => [e.safety, e.outcome]), [["needs_human", "needs_human"]], "automation never clicked it");
    assert.ok(entries(result).some((e) => e.type === "human_action" && e.element?.name === "Edit Profile"));
  });

  it("asks again, then stops, when the person did not complete a risky step", async () => {
    const withRisky = edited((w) => {
      const at = w.steps.findIndex((s) => s.id === "click_savings_account");
      w.steps.splice(at, 0, { kind: "click", id: "click_edit_profile", timeoutSeconds: 5, expect: [], target: target({ role: "button", name: "Edit Profile" }) });
    });
    const someone = person(async () => "done", async () => "done");
    const result = await replayWorkflow(withRisky, "draft", { member_id: "10048" }, config(NORMAL), { handoff: someone.channel });
    assert.deepEqual([result.status, result.stopReason, result.failure?.step], ["FAILED", "RESUME_FAILED", "click_edit_profile"]);
    assert.deepEqual(result.handoffs?.map((h) => h.stopReason), ["SAFETY_STOP", "RESUME_FAILED"]);
    assert.match(result.reason!, /Handoff limit \(2\) reached/);
    const editSteps = entries(result).filter((e) => e.type === "step" && e.target?.name === "Edit Profile");
    assert.equal(editSteps.length, 1, "checked by the safety rules once, never run");
  });

  it("records each action once across navigations and repeated handoffs, and only during a handoff", async () => {
    const w = edited((w) => {
      breakClick(w, "click_search");
      breakClick(w, "click_savings_account");
    });
    const someone = person(clickButton("Search"), clickButton("Savings Account"));
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(NORMAL), { handoff: someone.channel });
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.handoffs?.map((h) => h.stepsPassed), [["click_search"], ["click_savings_account"]]);
    const log = entries(result);
    const clicks = (n: number) => log.filter((e) => e.type === "human_action" && e.handoff === n && e.kind === "click");
    assert.deepEqual(clicks(1).map((a) => a.element.name), ["Search"]);
    assert.deepEqual(clicks(2).map((a) => a.element.name), ["Savings Account"], "one click, one entry, after a page navigation");
    assert.deepEqual(result.control?.map((c) => c.epoch), [1, 2, 3, 4]);
    // Between the handoffs automation acted (fill, etc.) and nothing was recorded as a person's.
    const firstBack = log.findIndex((e) => e.type === "control_changed" && e.epoch === 2);
    const secondOut = log.findIndex((e) => e.type === "control_changed" && e.epoch === 3);
    assert.deepEqual(log.slice(firstBack, secondOut).filter((e) => e.type === "human_action"), []);
  });

  it("re-checks that the page is approved before resuming, and asks again if not", async () => {
    const w = edited((w) => breakClick(w, "click_search"));
    const bank = `http://localhost:${NORMAL}`;
    const someone = person(
      async (page) => {
        await page.goto("about:blank");
        return "done";
      },
      async (page, request) => {
        assert.match(request.reason, /outside the approved area/);
        await page.goto(`${bank}/members?memberId=10048`);
        return "done";
      },
    );
    const result = await replayWorkflow(w, "draft", { member_id: "10048" }, config(NORMAL), { handoff: someone.channel });
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.handoffs?.map((h) => h.stopReason), ["TARGET_NOT_FOUND", "RESUME_FAILED"]);
    assertCleanRun(result, ["10048"]);
  });

  it("cancel ends the run as FAILED HANDOFF_CANCELLED and cleans up", async () => {
    const browser = trackedBrowser();
    const someone = person(async () => "cancel");
    const result = await replayWorkflow(workflowOf("1.0.0"), "draft", { member_id: "10048" }, config(NOTICE), { handoff: someone.channel, openBrowser: browser.open });
    assert.deepEqual([result.status, result.stopReason], ["FAILED", "HANDOFF_CANCELLED"]);
    assert.deepEqual(result.handoffs?.map((h) => h.end), ["cancelled"]);
    assert.deepEqual(result.control?.map((c) => c.to), ["human"], "control is not taken back after a cancel");
    assert.deepEqual([browser.opened[0]!.isOpen(), browser.opened[0]!.watchingHuman(), someone.aborted()], [false, false, 1]);
    assertCleanRun(result, ["10048"]);
  });

  it("no answer within the handoff time limit ends as NEEDS_HUMAN HANDOFF_TIMEOUT and cleans up", async () => {
    const browser = trackedBrowser();
    const someone = person(async () => "wait");
    const started = Date.now();
    const result = await replayWorkflow(workflowOf("1.0.0"), "draft", { member_id: "10048" }, config(NOTICE, {}, { timeoutSeconds: 1 }), { handoff: someone.channel, openBrowser: browser.open });
    assert.deepEqual([result.status, result.stopReason], ["NEEDS_HUMAN", "HANDOFF_TIMEOUT"]);
    assert.ok(Date.now() - started < 20_000);
    assert.deepEqual([browser.opened[0]!.isOpen(), browser.opened[0]!.watchingHuman(), someone.aborted()], [false, false, 1]);
  });

  it("a closed window ends as FAILED HANDOFF_SESSION_LOST", async () => {
    const someone = person(async (page) => {
      await page.close();
      return "wait";
    });
    const result = await replayWorkflow(workflowOf("1.0.0"), "draft", { member_id: "10048" }, config(NOTICE), { handoff: someone.channel });
    assert.deepEqual([result.status, result.stopReason], ["FAILED", "HANDOFF_SESSION_LOST"]);
    assert.equal(someone.aborted(), 1);
  });

  it("pauses the replay time limit while a person is in control", async () => {
    const someone = person(async (page) => {
      await page.waitForTimeout(11_000); // longer than the whole replay limit
      return clickButton("Acknowledge")(page, someone.requests[0]!);
    });
    const result = await replayWorkflow(workflowOf("1.0.0"), "draft", { member_id: "10048" }, config(NOTICE, { REPLAY_MAX_SECONDS: "10" }), { handoff: someone.channel });
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.ok(result.metrics.durationMs > 11_000);
  });

  it("does not hand off stops a person cannot fix: bank errors and a failed final check", async () => {
    const nobody = person();
    const bankError = await replayWorkflow(workflowOf(), "draft", { member_id: "10048" }, config(ERROR), { handoff: nobody.channel });
    assert.deepEqual([bankError.status, bankError.stopReason, bankError.handoffs], ["FAILED", "BANK_ERROR", []]);
    const w = edited((w) => w.success.push({ visible: { text: "Never shown" } }));
    const check = await replayWorkflow(w, "draft", { member_id: "10048" }, config(NORMAL), { handoff: nobody.channel });
    assert.deepEqual([check.status, check.stopReason, check.handoffs], ["FAILED", "SUCCESS_CHECK_FAILED", []]);
    assert.equal(nobody.requests.length, 0);
  });

  it("without --handoff, behaves exactly as before: NEEDS_HUMAN, no handoff fields", async () => {
    const result = await replayWorkflow(workflowOf("1.0.0"), "draft", { member_id: "10048" }, config(NOTICE));
    assert.deepEqual([result.status, result.stopReason, result.handoffs, result.control], ["NEEDS_HUMAN", "UNEXPECTED_DIALOG", undefined, undefined]);
    assert.ok(!entries(result).some((e) => /^(handoff|human_action|control_changed)/.test(e.type)));
  });

  it("the command line refuses --handoff with a hidden browser", () => {
    const env = { PATH: process.env.PATH, BANK_URL: `http://localhost:${NORMAL}`, BANK_LOGIN_USERNAME: TEST_USERNAME, BANK_LOGIN_PASSWORD: TEST_PASSWORD, BROWSER_HEADLESS: "on", REPLAY_RUNS_DIR: temp("handoff-runs-") };
    const run = spawnSync(process.execPath, ["--import", "tsx", "automation/src/replay/replay-cli.ts", "--workflow", SAVINGS, "--version", "1.0.1", "--input", "member_id=10048", "--handoff"], { env, encoding: "utf8", cwd: ROOT });
    assert.equal(run.status, 3);
    assert.match(run.stderr, /--handoff needs a visible browser/);
  });
});

// ---------- discovery handoff: the same mechanism, scripted LLM ----------

describe("discovery handoff", () => {
  const NOTICE = 4343;
  const NORMAL = 4344;
  const banks: Array<() => void> = [];
  before(async () => {
    banks.push(await startBank(NOTICE, { BANK_NOTICE: "on" }));
    banks.push(await startBank(NORMAL));
  });
  after(() => banks.forEach((stop) => stop()));

  const task: DiscoveryTask = { goal: "Get the savings balance for member 10048", inputs: { member_id: "10048" }, outputs: { savings_balance: "currency" }, allowLogout: false };
  const why = { reason: "test step" };
  const askPerson: ScriptStep = () => ({ tool: "request_human", args: { reason: "A popup is blocking the page." } });
  const readBalance: ScriptStep = (p) => ({ tool: "read", args: { ref: refOf(p, /: \$[\d,]+\.\d{2}/), output: "savings_balance", ...why } });
  const finish: ScriptStep = () => ({ tool: "finish", args: { status: "success", summary: "done" } });
  const withHandoff = (port: number, handoff: Partial<ReplayConfig["handoff"]> = {}) => {
    const c = testConfig(port);
    return { ...c, handoff: { ...c.handoff, ...handoff } };
  };

  it("pauses the LLM loop, lets a person act in the same browser, then looks again and continues", async () => {
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, askPerson, click("Savings Account"), readBalance, finish]);
    const callsDuring: number[] = [];
    const someone = person(async (page) => {
      callsDuring.push(llm.requests.length);
      await clickButton("Acknowledge")(page, someone.requests[0]!);
      await page.waitForTimeout(500);
      callsDuring.push(llm.requests.length);
      return "done";
    });
    const result = await discover(task, withHandoff(NOTICE), llm, undefined, { handoff: someone.channel });
    assert.equal(result.status, "SUCCESS", JSON.stringify(result));
    assert.deepEqual(result.outputs, { savings_balance: "$2,800.40" });
    assert.equal(callsDuring[0], callsDuring[1], "no LLM call while the person was in control");
    assert.deepEqual(result.handoffs?.map((h) => [h.end, h.reason]), [["done", "A popup is blocking the page."]]);
    assert.deepEqual(result.control?.map((c) => c.to), ["human", "automation"]);

    // The next LLM turn saw the page afresh (no dialog) and was told a person helped.
    const next = llm.requests[callsDuring[1]!]!.user;
    assert.match(next, /A person took control .* has handed control back/);
    assert.ok(!next.slice(next.indexOf("Current page:")).includes("System Notice"));

    const log = entries(result);
    const toHuman = log.findIndex((e) => e.type === "control_changed" && e.to === "human");
    const back = log.findIndex((e) => e.type === "control_changed" && e.to === "automation");
    assert.deepEqual(log.slice(toHuman, back).filter((e) => e.type === "step" || e.type === "llm_call"), []);
    assert.ok(log.slice(toHuman, back).some((e) => e.type === "human_action" && e.element?.name === "Acknowledge"));
    assertNoLeaks(result.runDir, llm, ["10048"]);
    // A run a person helped with is never recorded as a workflow.
    assert.throws(() => readRun(result.runDir), (e: Error) => e instanceof RecordingRefused && /person took control/.test(e.message));
  });

  it("never runs a risky step the LLM chose, before or after a handoff", async () => {
    const editProfile = click("Edit Profile");
    const llm = new ScriptedProvider([...loginSteps, ...searchSteps, editProfile, editProfile]);
    const someone = person(async () => "done");
    const result = await discover(task, withHandoff(NORMAL, { maxHandoffs: 1 }), llm, undefined, { handoff: someone.channel });
    assert.equal(result.status, "NEEDS_HUMAN");
    assert.match(result.reason!, /Handoff limit \(1\) reached/);
    const edits = entries(result).filter((e) => e.type === "step" && e.target?.name === "Edit Profile");
    assert.deepEqual(edits.map((e) => e.outcome), ["needs_human", "needs_human"], "stopped by the safety rules both times, never clicked");
  });

  it("cancel ends discovery as FAILED HANDOFF_CANCELLED; timeout as NEEDS_HUMAN HANDOFF_TIMEOUT", async () => {
    const cancelled = await discover(task, withHandoff(NOTICE), new ScriptedProvider([...loginSteps, ...searchSteps, askPerson]), undefined, { handoff: person(async () => "cancel").channel });
    assert.deepEqual([cancelled.status, cancelled.stopReason], ["FAILED", "HANDOFF_CANCELLED"]);
    const timedOut = await discover(task, withHandoff(NOTICE, { timeoutSeconds: 1 }), new ScriptedProvider([...loginSteps, ...searchSteps, askPerson]), undefined, { handoff: person(async () => "wait").channel });
    assert.deepEqual([timedOut.status, timedOut.stopReason], ["NEEDS_HUMAN", "HANDOFF_TIMEOUT"]);
  });

  it("without --handoff, a request for a person still ends the run with NEEDS_HUMAN", async () => {
    const result = await discover(task, testConfig(NOTICE), new ScriptedProvider([...loginSteps, ...searchSteps, askPerson]));
    assert.deepEqual([result.status, result.handoffs, result.control], ["NEEDS_HUMAN", undefined, undefined]);
  });
});
