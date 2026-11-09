# Architecture Plan: Computer-Use Automation System

**Status:** v0.3 (2026-11-06), final for submission. All five modules and the capability-interface stretch goal are built and approved. The system was built **functionality-first, module by module** (D-021).
**Source of truth:** the assignment PDF. Requirement IDs (FR-x, NFR-x, D-x) refer to `REQUIREMENTS.md`.
**Note:** This file describes *what* each module does and how they connect. Each module's internal design (data shapes, file layout, how a button is identified, log format) is decided in that module's design review (Phase A–E, D-028) and added here once approved.

---

## 1. The five modules

| # | Module | What it does | Main PDF requirements |
|---|---|---|---|
| 1 | **Mock Banking Application** | A fake bank back-office app: login, member search, member page, Savings and Checking buttons, account details, fake data. Operated only through its visible UI. | §4 (proxy target), T-1…T-4 |
| 2 | **LLM-Driven Discovery** | The LLM reads the user query, looks at the screen, chooses the next UI step, acts through Playwright, and repeats until the goal is verified or a safe stopping rule fires. | FR-1.*, FR-1.7 (real run) |
| 3 | **Successful Workflow Recording** | Turns a successful, verified discovery run into a saved, versioned, reusable recorded workflow (steps, how each element is identified, typed inputs/outputs, success checks). No second LLM. Kept only if a test replay passes. | FR-2.* |
| 4 | **Reuse Saved Workflows Without LLM Decisions** | Workflow lookup (simple and explicit), then replay of the recorded workflow with new inputs and no LLM decisions. Returns success, business outcome, recovered problem, or failure / needs-human. | FR-3.*, FR-3A.* |
| 5 | **Human Handoff** | Pauses automation, lets a person take over the **same** visible browser session, records what they do, and returns control so automation can re-check its position and continue. | FR-6.* |

### Module 1 as built (1a, 2026-10-15)
- **Location:** `mock-bank/` (its own folder; nothing outside it may import its code or read `mock-bank/data/`).
- **Stack:** Express 5 + EJS + `express-session`, run with `tsx`; plain browser JavaScript for account switching (`mock-bank/public/member-page.js`).
- **Screens:** `/login` → `/members` (search) → `/members?memberId=…` (Member Details: ID, name, Savings, Checking, Loans, Credit Cards, Edit Profile).
- **Account switching:** same page; the browser script fetches `/members/:id/accounts/:type` (login required) and fills one details area. The server sends only what may be shown (D-031).
- **1b failure settings (2026-10-27):** `mock-bank/src/faults.ts` reads `BANK_SESSION_TTL_SECONDS`, `BANK_SLOW_MS`, `BANK_SERVER_ERROR`, `BANK_NOTICE` at startup only (D-036). The System Notice popup is `views/members.ejs` + `public/notice.js`, and the error page is `views/error.ejs`.
- **Not built:** 1c, Edit Profile as an approval flow (deferred). Edit Profile is treated as a risky step and handed to a person. E-11 not applicable.

### Module 2 as built (2026-10-29; approved as complete 2026-11-06)
- **Location:** `automation/` (separate from `mock-bank/`; it operates the bank only through the browser).
- **Run:** `npm run discover -- --goal "…" --input member_id=10042 --output savings_balance:currency [--allow logout] [--handoff]`. A goal naming a different ID than `--input` is refused (D-054).
- **Pieces (`automation/src/`):**

  | File | Role |
  |---|---|
  | `config.ts` | Settings, checked at startup |
  | `steps.ts` | UI step shapes (Zod) and the tools offered to the LLM |
  | `browser.ts` | Browser layer, the only Playwright code. Snapshot is Playwright `ariaSnapshotJSON({mode:"ai"})` + `getByRef`. |
  | `safety.ts` | Safety rules |
  | `checkpoint.ts` | Shared step checkpoint (shape → safety → who is in control → run → log) |
  | `redact.ts` | Redaction for the LLM view and saved text |
  | `run-log.ts` | Run folder |
  | `llm/provider.ts` + `llm/openai.ts` | Swappable LLM boundary |
  | `discover.ts` | Loop, stopping rules, result checks |
  | `cli.ts` | Command line |

- **Run folder:** `runs/<runId>/run.jsonl`, `result.json`, and on failure or `NEEDS_HUMAN` a `failure-snapshot.txt` (`failure.png` only if switched on).
- **Ready for Module 3:** each step log entry has the element's role, name, label and section heading, plus the value as an input or credential name.
- **Ready for Module 4:** replay can call the same checkpoint with `source: "replay"`.

### Module 3 as built (2026-10-31, D-044/D-045; complete 2026-11-01, D-046)
- **Run:** `npm run record -- --run runs/<runId> --name member.get_savings_balance [--capabilities <dir>]`. Reads only the run folder. No LLM, browser, bank, credentials or API key.
- **Pieces (`automation/src/workflow/`):**

  | File | Role |
  |---|---|
  | `schema.ts` | Workflow shape (Zod): contract, `login`, `steps`, `conditionalSteps`, `businessOutcomes`, `success`, `provenance`. Conditions: `path`, `visible`, `gone`, `inputShown`, `outputShown`, `outputFormat`. |
  | `read-run.ts` | Only SUCCESS runs with every check passed, complete logs and agreeing files |
  | `catalog.ts` | Documented input formats, interruptions and business outcomes, each with its source |
  | `record.ts` | Clean-up rules, locators with robustness notes, checkpoints |
  | `store.ts` | `capabilities/<name>/<x.y.z>.json` (create-only, patch increments) and `status.json` (draft; Module 4 promotes) |
  | `record-cli.ts` | Command line |

- **Locators:** role + name (or label) within a section heading, plus one fallback without the section. Exactly one match is required at replay, resolved against the same page view discovery uses.
- **Ready for Module 4:** replay reads `login`, `steps` and `expect`, applies `conditionalSteps` when their `when` holds, checks `businessOutcomes` before failing a checkpoint, then checks `success`.

### Module 4 as built (2026-11-01, D-047–D-049; complete)
- **Run:**
  - `npm run replay -- --workflow <name> --input member_id=10048 [--version 1.0.0] [--promote]`
  - `npm run replay -- --request "Get the savings balance for member 10048" ...`
  - Needs the bank settings and login only. No API key, no LLM.
- **Pieces (`automation/src/replay/`):**

  | File | Role |
  |---|---|
  | `locate.ts` | Pure matching on the browser layer's element list: exactly one match, a fallback only when the primary matches nothing, and evaluation of every condition kind |
  | `replay.ts` | The engine: inputs checked, log in, steps, conditional steps, business outcomes, checkpoints, success checks, result, optional promotion |
  | `lookup.ts` | Exact-phrase workflow lookup from `capabilities/phrases.json`; unknown or ambiguous requests are refused |
  | `replay-cli.ts` | Command line. Exit codes: 0 SUCCESS or BUSINESS_OUTCOME, 1 FAILED, 2 NEEDS_HUMAN, 3 not run |

- **Reused:**
  - The browser layer, with a new `elements()`.
  - The shared step checkpoint (`source: "replay"`), which applies the safety rules, the "who is in control" check and the log entry.
  - The redactor and the run folder.
  - `store.ts`, with new `selectVersion` and `promote` (these edit `status.json` only).
- **Every look at the page,** in this order:
  1. Known interruptions (bounded by `maxTimes`).
  2. Business outcomes.
  3. An unknown dialog, which means NEEDS_HUMAN.
  4. Otherwise, the step's target or checkpoint.

  So a business outcome is always found before a checkpoint is reported as failed.
- **Workflow versions:** 1.0.1 is the preferred reusable version of both workflows. 1.0.0 is kept unchanged, but its System Notice condition never matches, so it returns NEEDS_HUMAN when the notice shows.
- **Session expiry:** log in again and restart the main steps, once. This is safe only for today's read-only workflows; it is not a policy for workflows with side effects.

### Module 5 as built (2026-11-01, D-050/D-051; real manual takeover 2026-11-06; approved as complete 2026-11-06)
- **Run:**
  - Add `--handoff` to `npm run replay` or `npm run discover`.
  - It needs a visible browser (`BROWSER_HEADLESS=off`). Settings: `HANDOFF_TIMEOUT_SECONDS`, `HANDOFF_MAX`.
- **Pieces:**

  | File | Role |
  |---|---|
  | `control.ts` | One "who is in control" state per run (`owner`, `epoch`, `history`). The shared step checkpoint refuses every automated step unless automation is in control |
  | `handoff.ts` | `Handoffs`: intervention request (`handoff-N.json`), recording of the person's actions, control transfer, waiting for done / cancel / timeout / closed window, cleanup. `terminalChannel()` is the operator control |
  | `browser.ts` | `sessionId`, `watchHuman()` (page script plus bridge, installed once per session), `onLost()`, `isOpen()` |

- **Flow:**
  1. A stop a person can fix pauses the run instead of ending it.
  2. The person works in the same browser window while the terminal shows who is in control.
  3. On Enter, automation takes control back with a new epoch.
  4. Replay re-checks the page (approved page, interruptions, business outcomes, unknown dialog), passes over click steps whose checkpoint already holds, and continues. Discovery simply looks at the page again on its next turn.
- **Rules:**
  - A risky step is never run by automation.
  - Outputs are always read by automation.
  - A run with a handoff is never promoted (replay) or recorded (discovery).

### Future compatibility (design only; FR-7, not built)
- **Legacy web apps:** the workflow does not depend on Playwright refs or CSS. A locator is role/name/label/section. An older app with poor accessibility markup would need extra locator kinds (e.g. a labelled table cell, or visible text near a landmark) in `Locator`. Each would still need exactly one match.
- **Desktop apps:** the same workflow shape, with a different browser layer. A desktop adapter (UI Automation on Windows, or AT-SPI) gives the same role/name tree, so `steps` and conditions stay the same. Path conditions would become window or screen titles.
- **Tenant (bank) variations:** what differs per bank is the catalog (messages, input formats, popups) and some names (e.g. "Share Savings" instead of "Savings Account"). Plan: a per-tenant catalog plus an optional per-tenant name map applied when a workflow is loaded, with no re-recording. A variant still has to pass its own test replay before it is reusable for that tenant (ties to OPT-5).
- **App version drift:** a locator that matches nothing, or more than one element, fails replay with a clear error instead of guessing. The fallback is tried only within the same evidence. Drift means re-discovering and recording a new version (the old versions stay). `provenance.sourceRun` shows which run each version came from.

## 2. How a request flows

```
User query + login details (always kept separate)
        │
        ▼
 Workflow lookup ── known workflow? ──yes──► Module 4: Replay (no LLM) ──► structured result
        │                                         │
        no → refused (not run); discovery is      │ cannot continue safely
        started separately (npm run discover)     ▼
        │                                  Module 5: Human handoff ──► back to automation
        ▼                                         ▲
 Module 2: Discovery (LLM decides each UI step) ──┘ (stuck, or risky step needs a person)
        │ success + result verified
        ▼
 Module 3: Recording → draft workflow → replay with --promote succeeds → marked reusable
        │
 Every module works against Module 1 (the mock banking app) through its visible UI only.
```

## 3. Requirements that run through all modules
These are not separate modules. Each module's design must meet them.
- **Safety & sensitive data** (FR-4.*): a configurable list of allowed sites/pages and kinds of UI step, enforced in discovery and replay; careful handling of risky/irreversible actions (D-017); credentials and personal data never stored in recorded workflows or logs.
- **Evidence & logs** (FR-5.*): a structured record of what happened and why for every run, plus at least one richer signal (e.g. a screenshot) on failure. Start with the simplest approach that works.
- **Replay never uses the LLM** (D-011, D-024): this must be provable.

**Known gaps** (G-1…G-6, identified 2026-10-15). Each fix is decided during the relevant module:

| Gap | Summary | Decide in |
|---|---|---|
| G-1 | No risky/irreversible action exists to demonstrate safety handling | Module 1 |
| G-2 | Safety rules (allowed sites/pages and UI step kinds) need an owner | Modules 2 & 4 |
| G-3 | Logs and failure evidence need an owner | Module 2 (first use) |
| G-4 | Handoff must also be triggerable from discovery and from risky steps | Modules 2 & 5 |
| G-5 | How a user query maps to a recorded workflow + inputs | Module 4 |
| G-6 | Final deliverables (README, REPORT, `/evidence/`) | Final wrap-up |

**Status at submission:** G-2 to G-6 are closed (D-039, D-047, D-051, D-053, D-054). G-1 is partly closed: Edit Profile is a risky step that is never automated and is handed to a person, but there is no full approval flow.

**Answered design question:** every automated UI step, from discovery or replay, goes through one shared step checkpoint (`checkpoint.ts`), so the safety rules, the "who is in control" check and logging each live in one place.

## 4. Built now vs. future extensibility

| Built now | Designed only (REPORT.md) / later |
|---|---|
| One mock bank (one tenant), two banking actions | Second tenant variant (OPT-5), legacy/hostile page modes |
| Web browser via Playwright | Legacy web and desktop apps (FR-7.1–7.2) |
| Simple, explicit workflow lookup | Semantic search / LLM-based request routing |
| Visible browser + simple operator control for handoff | React dashboard / co-browsing console |
| Recorded workflows as files | Multi-tenant reuse and drift management at scale (FR-7.3–7.4) |
| — | Confidence scoring and approval states (OPT-3) |

## Agent-facing capability interface (stretch goal, as built, D-053)
- `automation/src/agent/capabilities.ts`: `listCapabilities`, `getCapability`, `executeCapability` over the existing workflow store and `replayWorkflow`. Only reusable versions; no LLM; no discovery fallback.
- `automation/src/agent/capability-cli.ts`: a JSON command line (`npm run capability`). The result goes to stdout; progress and handoff to stderr.
- MCP is a possible later adapter over the same three functions. Its handoff channel is the open design point.

## 5. Final wrap-up (done 2026-11-06, D-054)
- `README.md`: setup, running without live services, the demo path, and the capability interface.
- `REPORT.md`: the seven required headings.
- `evidence/`: recorded workflows, two real discovery runs, replays including error and outcome cases, the real manual takeover, and the capability calls.

---
---

# Historical: original plan (v0.1, 2026-10-13)
> Kept for reference. It was based on the earlier workspace-first approach (Python core, then all-TypeScript per D-001…D-020). Where it conflicts with the sections above or with `DECISIONS.md`, the newer content wins.

### Legend (used throughout)
| Tag | Meaning |
|---|---|
| **[M]** | **Mandatory.** Required by the PDF (§3, §4, §6). |
| **[O]** | **Optional.** A stretch goal from the PDF (§8). |
| **[R]** | **Recommendation.** My suggestion, not required by the PDF. |
| **[U]** | **User addition.** In the brief but not in the PDF. |

> Two items in the original brief went beyond the PDF: semantic capability lookup/routing [U] (closest PDF item is OPT-1) and "test multiple times" [U] (= OPT-6).

### H1. High-Level Architecture (original)

```
                         ┌──────────────────────────────────────────────┐
   NL goal + target      │                 CLI / Entry                  │   capability_id + params
   (+ declared inputs) ─►│  `discover`   `replay`   `ask` [U/OPT-1]     │◄── (AI agent / human)
                         └──────┬───────────────┬──────────────┬────────┘
                                │               │              │
                                │               │     ┌────────▼─────────┐
                                │               │     │ Capability Router│  [U]/[O] match request →
                                │               │     │ (catalog lookup) │  capability + extract params
                                │               │     └────────┬─────────┘  (LLM allowed HERE, not in replay)
                ┌───────────────▼──────┐  ┌─────▼──────────────▼───┐
                │  DISCOVERY ENGINE    │  │    REPLAY ENGINE       │
                │  observe→decide→act  │  │  step executor,        │
                │  (LLM in loop)       │  │  locator resolver,     │
                │        │             │  │  checkpoint verifier,  │
                │  ┌─────▼──────────┐  │  │  state detectors,      │
                │  │ Flow Recorder  │  │  │  output extractor      │
                │  │ (refs→locators,│  │  │  (NO LLM import)       │
                │  │ values→params) │  │  └──┬──────────▲─────────┘
                │  └─────┬──────────┘  │     │          │ load
                └────┬───┼─────────────┘     │          │
                     │   │ emit (validated)  │   ┌──────┴──────────────┐
                     │   └───────────────────┼──►│ CAPABILITY REGISTRY │ versioned JSON artifacts
                     │                       │   │ (artifact store)    │ + schema validation
                     │                       │   └─────────────────────┘
        ┌────────────▼───────────────────────▼────────────┐
        │              POLICY GUARD (every action)        │◄── policy.yaml
        └────────────┬────────────────────────────────────┘
                     │ allowed actions only
        ┌────────────▼────────────────────────────────────┐        ┌───────────────────────┐
        │      SURFACE ADAPTER  (the seam, FR-7.2)        │◄──────►│ SESSION / CONTROL     │
        │  observe(): a11y tree + screenshot              │        │ CONTROLLER            │
        │  act(): click/type/select/navigate/press        │        │ owner: AUTOMATION |   │
        │  resolve(locator) · check(condition)            │        │ AWAITING_HUMAN | HUMAN│
        └────────────┬────────────────────────────────────┘        └──────────┬────────────┘
                     │ live session (same browser context)                    │ intervention request
        ┌────────────▼──────────────┐                              ┌──────────▼────────────┐
        │  TARGET APP (proxy)       │◄──── human operates the ─────│ OPERATOR SURFACE      │
        │  mock credit-union app    │      SAME live session       │ (minimal web page/CLI)│
        └───────────────────────────┘                              └───────────────────────┘

  Cross-cutting: RUN LOGGER (JSONL) · EVIDENCE STORE (screenshots, traces) · REDACTOR
```

Key boundaries (original): only the surface layer knows Playwright; replay has no LLM dependency; a policy guard sits between every decision-maker and the surface; a control controller owns "who drives the session".

### H2. Modules (original)

| # | Module | Responsibility | Requirements |
|---|---|---|---|
| 1 | Contracts | Typed definitions for artifact, step, locator, condition, run result, intervention request, control state, policy | FR-2.*, FR-3A.*, FR-6.10 |
| 2 | Target App (proxy) | Stand-in bank app with multi-step flow and fault injection | T-1…T-4, D-5 |
| 3 | Surface Adapter | Observe (a11y snapshot + refs, screenshot), act, resolve locator, check condition; owns live session | FR-1.5–1.6, FR-3.3, FR-7.1–7.2 |
| 4 | Policy Guard | Allowlist, action types, risk class, approval; redaction rules | FR-4.* |
| 5 | Discovery Engine | LLM observe→decide→act loop, stop conditions, `request_human`/`done` tools | FR-1.* |
| 6 | Flow Recorder | Trace → artifact: refs → locator sets, literals → params, extracts → outputs, final state → success condition | FR-2.* |
| 7 | Capability Registry | Store, version, load, validate artifacts | FR-2.9–2.10 |
| 8 | Replay Engine | Deterministic steps, param binding, locator fallbacks, checkpoints, state detectors, outputs, outcome classification | FR-3.*, FR-3A.* |
| 9 | Capability Router [U]/[O] | NL → capability + params, validated | OPT-1 |
| 10 | Control Controller + Operator Surface | State machine, intervention requests, same-session takeover, human-action capture, resume | FR-6.* |
| 11 | Observability | JSONL run log, evidence, redaction on write | FR-5.*, FR-4.5 |
| 12 | CLI | discover / replay / ask / operator | D-2 |

### H3. Original phase plan (2-day version, superseded)
P0 decisions & contracts → P1 target app → P2 surface + discovery (with minimal guard, redaction, log, stop conditions, screenshot on failure, `request_human` stub) → P3 artifact builder → P4a replay core → P5 errors & observability → P6 safety depth → P7 human handoff → P4b router (optional) → P8 E2E evidence → P9 docs → P10 optional. Critical path: target app → real discovery run.

### H4. Technology comparison (original summary)
- **Language:** Python (Pydantic, desktop a11y libraries) vs TypeScript (Playwright-native, Zod). *Later decided: TypeScript (D-001).*
- **Computer-use tech:** Playwright recommended over Selenium/Puppeteer; LLM-agent libraries (browser-use/Stagehand) rejected because they hide the loop and recording; screenshot + coordinates kept as a perception fallback and for the desktop design story, not as a replay primitive.
- **Perception:** accessibility tree first (role + accessible name), screenshot as context; ordered fallbacks role+name → label → text → css/xpath, plus frame path.
- **LLM:** Claude Opus 5.5 behind a provider interface; Sonnet 5.5 as cheaper alternative. Discovery is rare, so reliability matters more than cost.
- **Loop:** own thin loop on the raw Messages API with custom action tools (each tool call = recordable step).
- **Storage:** versioned JSON files; JSONL run logs; SQLite unnecessary at this scale.
- **Lookup:** exact invocation by id for production; NL routing via LLM over the catalog + deterministic validation; embeddings skipped. Routing LLM calls counted separately; replay LLM calls must be 0.
- **Proving no LLM in replay:** no import of the LLM client in replay code, call counter in logs, demo replay with API key unset.
- **Logging/testing:** structured JSON logs with redaction, screenshot + Playwright trace on failure, unit tests + one replay integration test.

### H5. Original smallest end-to-end workflow
Discover "look up member 10042 and read their savings balance" → artifact `member.get_savings_balance` → replay with 10077 (success), 99999 (business outcome: not found), injected interstitial (recovered), injected permission error (human handoff on the same browser, then resume) → safety block shown in log.

### H6. Original key decisions list
Language; proxy target; perception and locator strategy; artifact schema shape; error taxonomy and result contract; control-transfer model; risky-action policy; parameterization at discovery; LLM provider; JSON vs YAML; sync vs async Playwright; router; logging/CLI libraries. *All now tracked in `DECISIONS.md`.*
