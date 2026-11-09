# REPORT: Computer-Use Automation System

A mock credit-union back office (`mock-bank/`) stands in for a legacy bank app.
- An LLM discovers how to do a task in it once.
- A deterministic recorder turns the verified run into a typed, versioned workflow.
- Replay runs that workflow with no LLM.
- A person can take over the same live browser when a run cannot continue safely.

Decision IDs (D-0xx) refer to `DECISIONS.md`. Run evidence is in `/evidence/`.

## Executive summary

The whole required path works end to end against a live local surface: goal → real LLM discovery → saved, typed, versioned capability → deterministic replay with inputs, outputs and error handling → human takeover of the same live session → evidence.
- **Real execution evidence** (`evidence/`): 2 real OpenAI discovery runs (SUCCESS, 8 and 9 LLM calls), the two workflows recorded from them, 8 replays covering success and each kind of outcome or failure, a real manual handoff by a person, and real calls to the capability interface.
- **Automated tests:** 163 tests pass (`npm test`) and the type check is clean. They run against real mock banks with a scripted stand-in for the LLM, so they need no API key.
- **Stretch goal:** an agent-facing capability interface (`list` / `get` / `execute`) over reusable workflows, with no LLM.
- **Main limits:** the operator interface is the terminal; heterogeneous surfaces and multi-tenant reuse are designed, not built (§4, §6 Limits, §7).

## Validation summary

| Area | Real runs (`evidence/`) | Automated tests |
|---|---|---|
| Discovery | 2 OpenAI runs (savings, checking) → SUCCESS with all final checks passed | Scripted-LLM runs: success, business outcomes, limits, risky step, redaction, wrong-evidence and wrong-output rejection |
| Recording | Both workflows (1.0.1) recorded from those runs, no LLM | Only verified SUCCESS runs are recorded; failed, unverified, inconsistent or handed-off runs are refused; no real values in the file |
| Replay | SUCCESS, notice recovered, NOT_FOUND, INVALID_INPUT, PERMISSION_DENIED, BANK_ERROR, unknown dialog (NEEDS_HUMAN); 0 LLM calls | All outcomes and failures, fallbacks, ambiguity, slow load, session expiry, time limit, promotion rules |
| Handoff | A person cleared an unknown popup in the same session; automation resumed and returned SUCCESS | Same page object, control epochs, no duplicate actions, resume rules, cancel / timeout / closed window / limit, risky step never automated |
| Safety | Run folders and evidence checked: no credentials, member names, account numbers or local paths | Allowlist, risky and session-changing clicks, credential placement, control-label reads, goal/input mismatch, redaction |
| Capability interface | `list`, `get`, `execute` (SUCCESS, NOT_FOUND) and a REFUSED call | Reusable versions only, drafts refused, argument checks, no LLM import, handoff pass-through, CLI exit codes |

## 1. Architecture

```
mock-bank/          Express + server-rendered pages; fault settings; operated only through its UI
automation/src/
  browser.ts        the only Playwright code: accessibility snapshot, element list, actions, person-watching
  checkpoint.ts     shared step checkpoint: shape → safety rules → who is in control → run → log entry
  safety.ts         default-deny rules: approved origin, pages, step kinds; risky and session-changing elements
  redact.ts         what the LLM sees and what is saved
  discover.ts       LLM loop (observe → decide → act) with stopping rules and final checks   [LLM]
  llm/              swappable provider boundary; OpenAI today (gpt-5.4-mini-2026-03-17)    [LLM]
  workflow/         recorder (no LLM), workflow schema (Zod), versioned store, catalog of known messages
  replay/           deterministic replay engine, exact-phrase lookup                         [no LLM]
  control.ts, handoff.ts   who is in control; human handoff
  agent/            agent-facing capability interface (list / get / execute)              [no LLM]
capabilities/       <name>/<x.y.z>.json workflows + status.json (draft | reusable) + phrases.json
runs/<runId>/       run.jsonl (log), result.json, failure snapshot, handoff-N.json
```

**Key decisions and trade-offs:**
- **One TypeScript process per command** (`discover`, `record`, `replay`, `capability`). There is no server or queue. The PDF does not reward infrastructure, and each piece stays easy to run and test.
- **Discovery and replay share the same browser layer, step checkpoint, safety rules, redaction and log format.** Safety and "who is in control" are therefore enforced in one place for every automated step, whether the LLM chose it or a workflow did.
- **Recording uses no second LLM (D-024).** It is a set of rules over the discovery log, so a workflow is reviewable and reproducible. Only a SUCCESS run whose final checks all passed can be recorded. A run with a human handoff is refused.
- **Replay needs no API key.** Its code does not import the LLM layer, and every result reports `llmCalls: 0`.
- **LLM provider:** OpenAI, because that is where the available credits were (D-037). The provider sits behind an interface, so Claude or another model can be swapped in without touching the loop.

## 2. Artifact schema

A workflow (`capabilities/member.get_savings_balance/1.0.1.json`; schema in `workflow/schema.ts`) has:

| Part | What it holds | Why |
|---|---|---|
| `name`, `version`, `description`, `schemaVersion` | e.g. `member.get_savings_balance` 1.0.1 | Versions are immutable files. A new recording is the next patch version, and older ones stay. |
| `inputs` | `member_id: {type, pattern "^\d{5}$", description, source}` | A typed contract. The format comes from the app's documented rule, not from the run. |
| `outputs` | `savings_balance: {type: currency, section, description}` | The caller knows what comes back. The section ties the value to "Savings Account". |
| `start`, `login`, `steps` | Steps: `fill` / `click` / `read`, each with a `target` and an `expect` checkpoint | The login steps may only type credentials, by name (`{credential: "password"}`). Values never appear in the file. |
| `target` | `primary` locator (role + name or label, within a section heading) plus one `fallback` | See section 3. |
| `conditionalSteps` | Known interruptions, e.g. the System Notice: `when` visible → click "Acknowledge", at most N times | Recoverable conditions are declared, not improvised. |
| `businessOutcomes` | e.g. NOT_FOUND when "Member not found." is visible; also INVALID_INPUT, NO_ACCOUNT, PERMISSION_DENIED, ACCOUNT_CLOSED | Valid answers are part of the contract, not failures. |
| `success` | e.g. the input is shown, the output is still shown where it was read, the output looks like an amount | Replay proves it reached the right state. |
| `provenance` | the source discovery run, recorder version, discovery model | Each version can be traced back to the run it came from. |

The schema refuses:
- a credential typed outside `login`
- an undeclared input or output
- an output read more than once
- duplicate step IDs
- any redacted or masked text, so a recording can never contain the run's real values.

`status.json` (draft → reusable) is kept separate from the workflow file. A version becomes reusable only after a successful test replay with `--promote`. A replay that needed a person is never promoted.

## 3. Determinism & error handling

**Targeting:**
- Elements are found from the browser's accessibility tree (role, accessible name, nearby label, closest section heading), never CSS, coordinates or LLM element references.
- A locator must match exactly one element. The fallback is used only when the primary matches nothing, and its use is logged. More than one match fails with AMBIGUOUS_TARGET instead of guessing.

**Waiting:** every step has a timeout and an `expect` checkpoint (path, text visible or gone, input shown). Replay polls until the checkpoint holds, and the whole replay has a time limit (`REPLAY_MAX_SECONDS`, 60 s by default).

**Every look at the page,** in this order:
1. **Known interruptions** (`conditionalSteps`), handled a bounded number of times.
2. **Business outcomes**, checked before any failure.
3. **An unknown dialog**, which gives NEEDS_HUMAN.
4. Otherwise, **the step**.

So "no such member" is always reported as an outcome, never as a missing element.

**Result contract:** `SUCCESS` (with outputs), `BUSINESS_OUTCOME` (code + message), `FAILED`, or `NEEDS_HUMAN`. Failures carry `stopReason` and `failure {step, expected, observed}`, and recovered conditions are listed in `recovered`.

| Condition (tested against controlled bank faults) | Result |
|---|---|
| Bad input (`1234`) | BUSINESS_OUTCOME INVALID_INPUT, before a browser opens |
| Member not found, no account, permission denied, closed account | BUSINESS_OUTCOME with the app's message |
| System Notice popup | recovered (dismissed), then SUCCESS |
| Slow load | waits within the step timeout, then SUCCESS |
| Session expired | logs in again and restarts once (read-only workflows only) |
| Server error page or account load error | FAILED BANK_ERROR + redacted page snapshot |
| Unknown dialog | NEEDS_HUMAN UNEXPECTED_DIALOG (+ handoff if enabled) |
| Locator matches nothing or several elements | FAILED TARGET_NOT_FOUND / AMBIGUOUS_TARGET (NEEDS_HUMAN with handoff) |
| Final success checks fail | FAILED SUCCESS_CHECK_FAILED, and no outputs are returned |

**Fault injection:** the bank's faults are switched on by settings read only at startup (`BANK_NOTICE`, `BANK_SLOW_MS`, `BANK_SERVER_ERROR`, `BANK_SESSION_TTL_SECONDS`). The automation can neither cause nor avoid them.

**UI drift:** shows up as a failed locator or checkpoint with a clear error. The fix is to re-discover and record a new version. Replay never silently repairs a step with an LLM.

## 4. Heterogeneity & multi-tenant

*Designed, not built.*

**Surface seam:** the workflow never refers to Playwright. It refers to roles, names, labels and section headings, and to conditions on what is visible. Only `browser.ts` knows the browser.
- **A legacy web app** keeps the same workflow and adds locator kinds: a labelled table cell, or text near a landmark. These still require exactly one match.
- **A desktop app** needs a different browser layer, built on the OS accessibility APIs (UI Automation, AT-SPI). These expose the same role/name tree. Steps and conditions stay the same; path conditions become window titles.

**Multi-tenant reuse:** tenants running the same vendor product differ mostly in configuration: messages, input formats, popups, and labels (e.g. "Share Savings" instead of "Savings Account").
- The plan is one base workflow per vendor product and version.
- Each tenant gets a small override: its catalog of messages and interruptions, plus a label map applied when the workflow is loaded.
- A tenant variant must pass its own test replay before it is reusable for that tenant.

**Drift detection:**
- Each version records its source run.
- A locator that stops matching fails loudly at replay, and the replay log says which step.
- At scale, failure rates per tenant and version would flag drift. The response is a new recording for that tenant or version; the others stay unchanged.

## 5. Escalation & handoff

**Detecting "stuck":**
- In replay: an unknown dialog, a risky step stopped by the safety rules, a missing or ambiguous target, a failed checkpoint, or an interruption that would not clear.
- In discovery: the LLM asks for a person, a risky step comes up, or the browser leaves the approved pages.

Bank errors, time limits and failed final checks are **not** handed off, because a person cannot fix those by clicking.

**Intervention request:** with `--handoff`, the run pauses instead of ending.
- It writes `handoff-N.json`, containing the goal or workflow, the step, the stop reason, what was expected, the page path and a redacted page snapshot.
- The terminal shows the reason and says that a person now has control.

**Taking over the live session:** the person uses the *same* visible browser window: the same page object, session cookie and `sessionId`. There is no new login.
- **Who is in control:** a single state per run (`control.ts`) with an owner and an epoch, logged on every change. The step checkpoint refuses every automated step while a person is in control.
- **What the person did:** their clicks, submits and key presses are recorded with timestamps, element role and name, and page path. Typed values are always `"hidden"`.

**Handing control back:** pressing Enter in the terminal returns control to automation with a new epoch. Automation does not trust that the person did the right thing; it re-checks the page:
1. The page must be approved.
2. Interruptions, business outcomes and unknown dialogs are checked.
3. Click steps whose checkpoint already holds are passed over.
4. Fill and read steps always run again, so outputs are always read by automation.
5. The final success checks still apply. A person who searched a different member gives FAILED, not wrong data.

A risky step is never run by automation, even after a handoff. There is no "approve, then automation clicks" path: if the action should happen, the person performs it in the browser during the handoff. Afterwards automation passes over that step only if the page shows its result; otherwise it asks again and then stops.

**Other endings:**
- `cancel` → FAILED HANDOFF_CANCELLED
- the handoff timeout (600 s) → NEEDS_HUMAN HANDOFF_TIMEOUT
- a closed window → FAILED HANDOFF_SESSION_LOST
- at most 2 handoffs per run

**Two separate time limits:**
- The **run time limit** covers automated work: 60 s for replay (`REPLAY_MAX_SECONDS`) and 120 s for discovery (`DISCOVERY_MAX_SECONDS`). Reaching it gives FAILED TIME_LIMIT, which is not handed off.
- The **handoff timeout** covers one handoff: 600 s by default (`HANDOFF_TIMEOUT_SECONDS`, 10–3600). Reaching it gives NEEDS_HUMAN HANDOFF_TIMEOUT, and control stays with the person.
- The time a person holds control is added to the run's deadline, so a handoff never uses up automation's time.

**Evidence:** a real manual takeover is in `evidence/4-handoff/`. The person clicked "Acknowledge" on a popup that workflow 1.0.0 cannot handle and pressed Enter. Replay resumed at the next step with the search already done and returned SUCCESS. The log shows the same `sessionId` throughout and control epochs 1 → 2.

**Current operator interface and future extension:** the operator interface is the terminal (Enter to hand back, `cancel` to stop). A web operator console with remote co-browsing and a queue of requests is the next step. `HumanChannel` is the seam it would plug into.

## 6. Safety

**Default-deny rules,** enforced for every automated step in both discovery and replay:
- the approved origin, and the pages `/`, `/login` and `/members` with no query
- the step kinds `click`, `fill`, `read`, `wait_for`, `navigate`, `request_human` and `finish`
- declared inputs and outputs only

**Risky and irreversible actions:** blocked for automation; only a person can perform them during a handoff.
- "Edit Profile" is risky by an explicit rule. A configurable keyword list (Transfer, Delete, Close Account, Update, …) is the fallback.
- A risky click stops with NEEDS_HUMAN and is never executed by automation. With `--handoff`, the person decides; if the action should happen, the person performs it in the browser. Automation does not execute it after approval.
- "Log Out" changes the session and is allowed only when the task permits it.

**Other rules:**
- Credentials may be typed only into the password and username boxes on the login page.
- An output may not be read from a control's label (a button or link), only from page text.

**Data handling:**
- **Credentials** come only from settings, never from the goal, arguments or a workflow. They are never sent to the LLM, logged or saved.
- **What the LLM sees:** declared inputs as `<input:name>`, and sensitive labels (member name) blanked.
- **Saved logs and snapshots** also mask member IDs (`***42`) and amounts (`$[amount]`). Snapshots are size-limited, and failure screenshots are off by default and painted over when on.
- **`result.json`** contains only the declared outputs, which the caller needs.
- **Goal and inputs must agree:** a discovery goal naming an ID different from `--input` is refused before a run starts.

**Limits:**
- The rules match on visible names, so a risky action with a harmless-looking label would not be caught without a rule for it.
- Redaction is pattern-based for this app's data formats.
- While automation is in control, nothing stops a person from touching the visible browser window. The terminal says clearly who is in control at every change, and only actions during a handoff are recorded.
- A second tab opened by the person is not watched.

## 7. Cuts

**Cut or mocked:**
- the operator web console (the terminal is the operator surface)
- Edit Profile as a real approval flow; it is risky and handed to a person
- a second tenant variant, and legacy or hostile page modes
- semantic or LLM-based request routing; lookup is exact phrases or names
- automatic fallback from a missing workflow to discovery
- MCP. The capability interface is three plain functions, so an MCP server would be a thin adapter. Its open point is the handoff channel, because MCP's stdio transport uses the standard input the terminal handoff reads.
- multi-run stability scoring

**Stretch goal built:** an agent-facing capability interface (`npm run capability -- list | get | execute`). It exposes only reusable workflows, with a JSON Schema for the inputs, and executes them through the same replay engine with no LLM. Evidence is in `evidence/5-capability/`.

**Next with more time:**
1. A web operator console behind `HumanChannel`, with a request queue.
2. A per-tenant override and a second bank variant replaying the same base workflow.
3. Replay stability scores per workflow version, to gate promotion.
4. Locator kinds for table-based legacy pages.
5. Edit Profile with an explicit approval step.
