import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageView } from "../src/browser.js";
import { readConfig } from "../src/config.js";
import { Redactor } from "../src/redact.js";
import { bankSafetyRules, checkStep, type StepContext } from "../src/safety.js";
import { parseStep, stepTools, type Step } from "../src/steps.js";
import { parseArgs } from "../src/cli.js";
import { verifyFinish } from "../src/discover.js";

const baseEnv = { BANK_LOGIN_USERNAME: "u-name", BANK_LOGIN_PASSWORD: "p-word-123", OPEN_AI_KEY: "sk-x" };

describe("settings", () => {
  it("uses the agreed demo defaults", () => {
    const config = readConfig(baseEnv);
    assert.deepEqual(config.limits, { maxSteps: 10, maxSeconds: 120, maxFailures: 2, maxLlmCalls: 10 });
    assert.equal(config.llm.model, "gpt-5.4-mini-2026-03-17");
    assert.equal(config.screenshotsForLlm, false);
    assert.equal(config.saveFailureScreenshot, false);
    assert.equal(config.bankUrl, "http://localhost:4000");
  });

  it("refuses invalid values with every problem listed", () => {
    assert.throws(
      () => readConfig({ ...baseEnv, DISCOVERY_MAX_STEPS: "0", DISCOVERY_SCREENSHOTS: "maybe", BANK_URL: "ftp://x" }),
      (error: Error) =>
        error.message.includes("DISCOVERY_MAX_STEPS") &&
        error.message.includes("DISCOVERY_SCREENSHOTS") &&
        error.message.includes("BANK_URL"),
    );
  });

  it("requires automation credentials and the API key", () => {
    assert.throws(() => readConfig({}), /BANK_LOGIN_USERNAME.*\n.*BANK_LOGIN_PASSWORD.*\n.*OPEN_AI_KEY/s);
  });

  it("keeps credentials exactly as given and refuses ones too short to redact", () => {
    assert.equal(readConfig({ ...baseEnv, BANK_LOGIN_PASSWORD: " pass word " }).password, " pass word ");
    assert.throws(() => readConfig({ ...baseEnv, BANK_LOGIN_PASSWORD: "abc" }), /at least 4 characters/);
  });

  it("refuses a protection list that would end up empty", () => {
    assert.throws(() => readConfig({ ...baseEnv, SAFETY_RISKY_KEYWORDS: "," }), /SAFETY_RISKY_KEYWORDS must list/);
    assert.throws(() => readConfig({ ...baseEnv, SAFETY_SENSITIVE_LABELS: " , " }), /SAFETY_SENSITIVE_LABELS must list/);
  });
});

describe("command-line task", () => {
  it("parses declared inputs and outputs", () => {
    const task = parseArgs(["--goal", "g", "--input", "member_id=10042", "--output", "savings_balance:currency"]);
    assert.deepEqual(task.inputs, { member_id: "10042" });
    assert.deepEqual(task.outputs, { savings_balance: "currency" });
    assert.equal(task.allowLogout, false);
  });

  it("refuses a goal that names a different number than the inputs", () => {
    const args = (goal: string, input = "member_id=10042") => ["--goal", goal, "--input", input, "--output", "savings_balance:currency"];
    assert.throws(() => parseArgs(args("Get the savings balance for member 10077")), /goal names a number that is not one of the --input values/);
    assert.throws(() => parseArgs(args("Compare member 10042 with member 10050")), /not one of the --input values/);
    assert.equal(parseArgs(args("Get the savings balance for member 10042")).inputs.member_id, "10042");
    assert.equal(parseArgs(args("Get the savings balance for the member")).goal, "Get the savings balance for the member");
    assert.equal(parseArgs(args("Get the savings balance for member 10042", "member_id= 10042 ")).inputs.member_id, "10042");
  });

  it("trims input values", () => {
    const task = parseArgs(["--goal", "g", "--input", "member_id= 10042 ", "--output", "savings_balance"]);
    assert.equal(task.inputs.member_id, "10042");
  });

  it("rejects bad declarations", () => {
    assert.throws(() => parseArgs(["--goal", "g", "--output", "savings_x:number"]), /type must be/);
    assert.throws(() => parseArgs(["--goal", "g", "--output", "balance"]), /section_name/);
    assert.throws(() => parseArgs(["--goal", "g", "--output", "savings_balance:currency:junk"]), /section_name/);
    assert.throws(
      () => parseArgs(["--goal", "g", "--output", "savings_balance", "--output", "savings_balance:currency"]),
      /given twice/,
    );
    assert.throws(() => parseArgs(["--help"]), /Usage:/);
    assert.throws(() => parseArgs(["--goal", "g", "--input", "Bad=1", "--output", "x"]), /lower_case/);
    assert.throws(() => parseArgs(["--goal", "g"]), /at least one --output/);
    assert.throws(() => parseArgs(["--goal", "g", "--output", "savings_x", "--allow", "everything"]), /only accepts/);
  });
});

describe("UI step shapes", () => {
  it("accepts a valid step and rejects unknown kinds and fields", () => {
    assert.equal(parseStep("click", { ref: "e1", reason: "r" }).ok, true);
    assert.equal(parseStep("select", { ref: "e1", reason: "r" }).ok, false);
    assert.equal(parseStep("click", { ref: "e1", reason: "r", x: 5 }).ok, false);
    assert.equal(parseStep("click", undefined).ok, false);
  });

  it("requires an outcome code for business outcomes", () => {
    assert.equal(parseStep("finish", { status: "business_outcome", summary: "s" }).ok, false);
  });

  it("offers exactly the approved step kinds to the LLM", () => {
    assert.deepEqual(
      stepTools().map((t) => t.name),
      ["click", "fill", "read", "wait_for", "navigate", "request_human", "finish"],
    );
  });
});

describe("safety rules", () => {
  const rules = bankSafetyRules({
    origin: "http://localhost:4000",
    riskyKeywords: ["Edit Profile", "Transfer", "Delete", "Close Account", "Update"],
    sensitiveLabels: ["Member Name"],
    allowLogout: false,
    declaredInputs: ["member_id"],
    declaredOutputs: ["savings_balance"],
  });
  const onMembers = (target?: StepContext["target"], secret = false): StepContext => ({
    currentUrl: "http://localhost:4000/members?memberId=10042",
    target,
    targetIsSecret: secret,
  });
  const click = (name: string) =>
    checkStep(rules, { kind: "click", ref: "e1", reason: "r" }, onMembers({ role: "button", name })).verdict;

  it("sends risky clicks to a person: explicit rule first, keywords as fallback", () => {
    assert.equal(click("Edit Profile"), "needs_human");
    assert.equal(click("Transfer Funds"), "needs_human");
    assert.equal(click("Update Address"), "needs_human");
    assert.equal(click("Savings Account"), "allow");
    assert.equal(click("Loans"), "allow");
  });

  it("checks clickable elements by visible text or label when they have no name", () => {
    const clickTarget = (target: StepContext["target"]) =>
      checkStep(rules, { kind: "click", ref: "e1", reason: "r" }, onMembers(target)).verdict;
    assert.equal(clickTarget({ role: "generic", text: "Transfer funds" }), "needs_human");
    assert.equal(clickTarget({ role: "generic", label: "Delete" }), "needs_human");
    assert.equal(clickTarget({ role: "generic", text: "Loans" }), "allow");
    assert.equal(clickTarget({ role: "button" }), "refuse"); // nothing to identify it by
  });

  it("refuses Log Out unless the task permits it", () => {
    assert.equal(click("Log Out"), "refuse");
    const permissive = { ...rules, allowLogout: true };
    assert.equal(
      checkStep(permissive, { kind: "click", ref: "e1", reason: "r" }, onMembers({ role: "button", name: "Log Out" })).verdict,
      "allow",
    );
  });

  it("limits navigation to approved pages without a query", () => {
    const go = (path: string) => checkStep(rules, { kind: "navigate", path, reason: "r" }, onMembers()).verdict;
    assert.equal(go("/members"), "allow");
    assert.equal(go("/members?memberId=10042"), "refuse");
    assert.equal(go("/members/10042/accounts/savings"), "refuse");
    assert.equal(go("https://example.com/"), "refuse");
  });

  it("stops when the browser is outside the approved area", () => {
    const step: Step = { kind: "click", ref: "e1", reason: "r" };
    const verdict = checkStep(rules, step, { currentUrl: "https://example.com/", target: { role: "button" }, targetIsSecret: false });
    assert.equal(verdict.verdict, "needs_human");
  });

  it("keeps credentials on the login page and in the right box", () => {
    const fill = (value: Extract<Step, { kind: "fill" }>["value"], url: string, secret: boolean) =>
      checkStep(rules, { kind: "fill", ref: "e1", value, reason: "r" }, {
        currentUrl: url,
        target: { role: "textbox", name: "x" },
        targetIsSecret: secret,
      }).verdict;
    const login = "http://localhost:4000/login";
    assert.equal(fill({ credential: "password" }, login, true), "allow");
    assert.equal(fill({ credential: "password" }, login, false), "refuse");
    assert.equal(fill({ credential: "username" }, login, true), "refuse");
    assert.equal(fill({ text: "hello" }, login, true), "refuse");
    assert.equal(fill({ credential: "password" }, "http://localhost:4000/members", true), "refuse");
    assert.equal(fill({ input: "member_id" }, "http://localhost:4000/members", false), "allow");
    assert.equal(fill({ input: "ssn" }, "http://localhost:4000/members", false), "refuse");
  });

  it("only reads declared outputs, and needs a real element", () => {
    const read = (output: string, target?: StepContext["target"]) =>
      checkStep(rules, { kind: "read", ref: "e1", output, reason: "r" }, onMembers(target)).verdict;
    assert.equal(read("savings_balance", { role: "generic" }), "allow");
    assert.equal(read("savings_balance", { role: "generic", label: "Member Name" }), "refuse");
    assert.equal(
      checkStep(rules, { kind: "read", ref: "e1", output: "savings_balance", reason: "r" }, onMembers({ role: "textbox" }, true)).verdict,
      "refuse",
    );
    assert.equal(read("member_name", { role: "generic" }), "refuse");
    assert.equal(read("savings_balance", undefined), "refuse");
  });

  it("refuses to read an output from a control's label", () => {
    const read = (target: StepContext["target"]) =>
      checkStep(rules, { kind: "read", ref: "e1", output: "savings_balance", reason: "r" }, onMembers(target)).verdict;
    assert.equal(read({ role: "button", name: "Edit Profile" }), "refuse");
    assert.equal(read({ role: "link", name: "Savings" }), "refuse");
    assert.equal(read({ role: "generic", text: "$5,200.75", label: "Balance" }), "allow");
    assert.equal(read({ role: "paragraph", text: "Not available in demo." }), "allow");
  });

  it("final checks reject an output that came from a control's label", () => {
    const view: PageView = {
      url: "http://localhost:4000/members?memberId=10042",
      path: "/members",
      nodes: [
        { role: "heading", name: "Member Details", level: 2 },
        { role: "generic", text: "10042" },
        { ref: "e9", role: "button", name: "Edit Profile" },
      ],
    };
    const captured = new Map([["profile_status", { value: "Edit Profile", ref: "e9", target: { role: "button", name: "Edit Profile", heading: "Profile" } }]]);
    const task = { goal: "g", inputs: { member_id: "10042" }, outputs: { profile_status: "text" as const }, allowLogout: false };
    const { passed, checks } = verifyFinish({ kind: "finish", status: "success", summary: "s" }, view, captured, task, new Redactor({}, [], []));
    assert.equal(passed, false);
    const failed = checks.filter((c) => !c.passed).map((c) => c.check);
    assert.ok(failed.includes("output profile_status was read from page text, not a control"), failed.join("; "));
  });
});

describe("redaction", () => {
  const redactor = new Redactor({ member_id: "10042" }, ["teller01", "s3cret-pass"], ["Member Name"]);
  const view: PageView = {
    url: "http://localhost:4000/members?memberId=10042",
    path: "/members",
    nodes: [
      { role: "textbox", name: "Member ID", ref: "e1", text: "10042" },
      { role: "textbox", name: "Password", ref: "e9", secret: true },
      {
        role: "generic",
        children: [
          { role: "generic", text: "Member Name" },
          { role: "generic", ref: "e2", text: "John Smith" },
        ],
      },
      { role: "generic", ref: "e3", text: "$5,200.75" },
      { role: "generic", ref: "e4", text: "••••0042" },
      { role: "text", text: "logged in as teller01 with s3cret-pass" },
    ],
  };

  it("shows the LLM placeholders instead of inputs, names and credentials", () => {
    const page = redactor.pageForLlm(view);
    assert.match(page, /<input:member_id>/);
    assert.match(page, /\[redacted\]/);
    assert.match(page, /textbox "Password" \(value hidden\)/);
    assert.match(page, /\$5,200\.75/); // the LLM may see the value it must read
    for (const leak of ["10042", "John Smith", "teller01", "s3cret-pass"]) assert.ok(!page.includes(leak), leak);
  });

  it("saves stricter text: amounts and member IDs masked, no references", () => {
    const saved = redactor.pageForLog(view);
    for (const leak of ["10042", "John Smith", "teller01", "s3cret-pass", "5,200.75", "[ref="]) assert.ok(!saved.includes(leak), leak);
    assert.match(saved, /\$\[amount\]/);
    assert.equal(redactor.forLog("member 99999 not found"), "member ***99 not found");
    assert.equal(redactor.forLog("member 10042"), "member <input:member_id>");
  });

  it("marks a filled password box [filled] and an empty one not, in both views", () => {
    const withBox = (filled: boolean): PageView => ({
      url: "http://localhost:4000/login",
      path: "/login",
      nodes: [{ role: "textbox", name: "Password", ref: "e9", secret: true, ...(filled ? { filled: true } : {}) }],
    });
    for (const render of [(v: PageView) => redactor.pageForLlm(v), (v: PageView) => redactor.pageForLog(v)]) {
      const empty = render(withBox(false));
      const filled = render(withBox(true));
      assert.match(empty, /textbox "Password" \(value hidden\)/);
      assert.ok(!empty.includes("[filled]"), "an empty box is not marked");
      assert.match(filled, /textbox "Password" \(value hidden\) \[filled\]/);
      for (const page of [empty, filled]) assert.ok(!page.includes("s3cret-pass"));
    }
  });

  it("keeps a hidden value hidden in later text, such as step feedback", () => {
    const fresh = new Redactor({}, [], ["Member Name"]);
    fresh.pageForLlm(view); // sees "John Smith" next to "Member Name"
    assert.equal(fresh.forLlm('Captured "John Smith Account"'), 'Captured "[redacted] Account"');
    assert.equal(fresh.forLog("reason: John Smith"), "reason: [redacted]");
  });

  it("limits the size of saved snapshots", () => {
    const big: PageView = { url: "http://x/", path: "/", nodes: [{ role: "text", text: "a".repeat(40_000) }] };
    const saved = redactor.pageForLog(big);
    assert.ok(saved.length < 16_200);
    assert.match(saved, /truncated/);
  });
});
