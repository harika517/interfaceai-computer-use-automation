# Decision Log

Each entry: **context → options → decision → why → trade-off**. This log feeds `REPORT.md`.
Status values: **Accepted** (confirmed by us), **Proposed** (recommended, awaiting confirmation), **Pending** (blocked on input).

> These decisions supersede the Python-based tech choices in `ARCHITECTURE_PLAN.md` §4.
>
> `PROGRESS.md` and `dailyStatus.md`, mentioned below, were working notes kept outside the public repository. Each decision here is self-contained.

---

### D-001 · Language & runtime: TypeScript + Node.js for the whole system — **Accepted**
- **Options:** Python core + TS mock app; all Python; all TypeScript.
- **Decision:** All TypeScript (strict mode), on Node.js LTS.
- **Why:** Playwright is written in TypeScript, so its newest APIs, tracing and docs arrive there first. One runtime means one install and one toolchain, and fewer failure points on a clean clone. Strict types plus Zod give compile-time and runtime guarantees on the artifact contract.
- **Trade-off:** Native desktop automation libraries are stronger in Python and C#. This is handled by D-010 (language-neutral surface protocol), so a desktop adapter can be written in any language.

### D-002 · Timeline: 30–40 focused hours as a planning estimate — **Accepted**
- **Why:** The PDF sets no deadline but asks us to time-box ourselves and says it rewards "judgment, not endurance". Correctness and full mandatory coverage come before speed.
- **Trade-off:** None. Milestones replace dates.

### D-003 · Computer-use driver: Playwright (Chromium) — **Accepted**
- **Options:** Playwright, Selenium, Puppeteer, LLM-agent libraries (browser-use/Stagehand), screenshot + coordinates (native computer-use tools).
- **Why:** It gives us accessibility-tree access, role/name locators, frame support, auto-waiting and built-in tracing. We also stay in control of the loop and the recording, which are the graded parts.
- **Trade-off:** Browser only. Desktop is covered by design (D-010).

### D-004 · Perception & targeting: accessibility tree first, plus ordered locator fallbacks — **Accepted; screenshot part amended by D-039 (2026-10-29), pending plan approval**
- **Decision:** The LLM observes an accessibility-tree snapshot (role, accessible name, element refs), plus a screenshot for context. Recorded locators are an ordered list: `role+name` → `label` → `text` → `css/xpath` (last resort), plus a frame path. Coordinates are recorded only as metadata, never used to replay.
- **Why:** Role and name are the representation that carries over to legacy web and to desktop accessibility APIs (Windows UI Automation, macOS Accessibility). This follows the PDF's bias toward "no clean DOM".
- **Trade-off:** Pages with poor accessibility markup yield weaker names. The fallback strategies cover that, and screenshot + coordinates remain a documented perception fallback for the design.

### D-005 · Typed contracts: Zod schemas as the single source of truth — **Partly superseded by D-022 (2026-10-15)**: "define all shapes upfront" removed; "recorded workflow is typed and validated" kept
- **Decision:** Every cross-module contract (artifact, action, locator, condition, observation, policy, run event, run result, control state) is a Zod schema. TS types are inferred from the schemas, and a JSON Schema is exported for reviewers and calling agents.
- **Trade-off:** Some schema verbosity, in exchange for runtime validation at every boundary.

### D-006 · LLM: Claude Opus 5.5 (`claude-opus-5-5`) behind a provider interface — **Superseded in part by D-037 (2026-10-28):** the provider is now OpenAI; "behind a provider interface" stays open for the Module 2 design
- **Decision:** Our own thin loop on the Messages API with custom action tools. The model is configurable; Sonnet 5.5 is the cheaper alternative.
- **Why:** Discovery runs are rare, so reliably finishing the goal matters more than cost. Custom tools map one-to-one onto recordable steps.
- **Pending:** The user will confirm which API key is available before live discovery (M2).

### D-007 · Agent loop: our own loop, not an agent SDK or native computer-use tool — **Accepted**
- **Why:** Each tool call is a semantic, recordable step (`click(ref)`, `fill(ref, value)`, `extract(...)`, `done`, `request_human`). The policy guard runs before every action, and the artifact never depends on the transcript (FR-2.2).
- **Trade-off:** We maintain about 200 lines of loop code ourselves.

### D-008 · Target app: local mock credit-union back office, Express + server-rendered HTML — **Accepted**
- **Decision:** Express, server-rendered templates, legacy flavor (table layouts, no test IDs, generated field names, some unlabeled inputs, one content iframe). Seeded fake data. Business outcomes are triggered by the data; faults are triggered by switches. It is a separate package that the automation never imports.
- **Why:** We control the faults and the reproducibility, and no ToS or real-data concerns arise. A single-page React app would produce the clean DOM the PDF says we can't assume, so the *target* deliberately does not use React.
- **Scope now:** One tenant (Tenant A), one read-only workflow (savings balance).

### D-009 · Operator & automation dashboard: minimal React + TypeScript (Vite) — **Superseded by D-026 (2026-10-15)**: deferred
- **Decision:** A small dashboard for runs, intervention queue, take/release control and results. The operator interface lives inside it. It is *our* tool and is separate from the target app.
- **Trade-off:** Adds a build tool (Vite). It is kept minimal; a full co-browsing console is out of scope per the PDF.

### D-010 · Surface seam: TypeScript `SurfaceAdapter` interface now; JSON-RPC desktop integration in design only — **Accepted**
- **Decision:** Discovery, replay and the recorder depend only on `SurfaceAdapter` and surface-neutral contracts (locators, conditions, actions). `WebPlaywrightSurface` is the one implementation. REPORT.md describes a JSON-RPC protocol (observe / act / resolve / check / screenshot) that lets a desktop adapter run as a separate process.
- **Why:** This is the seam FR-7.2 asks for, without building it early.

### D-011 · Replay independence from the LLM, enforced by package boundaries — **Rule kept; enforcement mechanism reopened by D-024 (2026-10-15). Resolved in Module 4 (D-047/D-048): replay and the capability interface don't import the LLM layer, need no API key, and every result reports `llmCalls: 0`.**
- **Decision:** An npm workspace keeps the LLM SDK as a dependency *only* of the discovery package. The core package (surface, policy, session, recorder, replay, observability) has no LLM dependency, so replay physically cannot import it. Lint and test rules add a second check, and run logs record `llmCalls: 0` for replay.
- **Why:** This proves "no LLM in the decision loop" structurally, not just by convention.

### D-012 · Session ownership: an explicit control lease, designed in M1 — **Principle kept, mechanism reopened (2026-10-15)**: decided in Module 5 as one "who is in control" state per run with epochs (`control.ts`, D-050/D-051)
- **Decision:** A `SessionManager` owns the live browser session. Every action requires a **control lease** `{sessionId, owner: automation|human|none, holderId, epoch}`. Changing the owner bumps the epoch, so stale holders are rejected. States: `AUTOMATION → AWAITING_HUMAN → HUMAN → RESUMING → AUTOMATION`.
- **Why:** A same-session handoff is only possible if automation can be blocked out of a live session and let back in safely. Retrofitting this later would mean rewriting the surface layer.
- **Proposed detail:** The browser runs **headed** from the start, so the human operates the same window. Human actions are captured by an injected page listener plus navigation events. On resume, automation re-checks the current step's checkpoint before continuing.

### D-013 · Artifact storage: versioned JSON files, plus a JSONL run index — **Accepted**
- **Decision:** `capabilities/<capabilityId>/<semver>.json`, validated against the Zod schema. Run outputs go in `runs/<runId>/` (gitignored); selected runs are copied to `/evidence/`.
- **Trade-off:** No query engine. Fine at this scale; a database for scale is described in REPORT.

### D-014 · Stretch goals: OPT-5 (cross-tenant reuse) + OPT-3 (confidence/approval), tentative — **Accepted (tentative)**
- **Rule:** Start only after the core system *and* the human handoff work (after M5).
- **Next-step candidates for REPORT:** OPT-1 (agent-facing catalog/router).

### D-015 · Deferred until all mandatory functionality is complete — **Accepted**
- Tenant B variant, hostile framesets, advanced locator scoring, N-run approval gating.

### D-016 · Discovery inputs are declared up front — **Accepted (2026-10-14)**
- **Decision:** The caller passes typed inputs with the goal (for example `member_id=10042`). The recorder binds matching literal values to `{{member_id}}`.
- **Why:** Binding is deterministic and reviewable, with no LLM guessing which value is a parameter.

### D-017 · Risky or irreversible actions: require explicit approval, otherwise block — **Accepted (2026-10-14)**; Module 2 application in D-039
- **Decision:** The policy assigns each action a risk class. `irreversible` actions need an approval, either pre-granted at invocation or given interactively by an operator. Without approval they are blocked and escalated.
- **Why:** In regulated finance, a silent "flag" is too weak, and a blanket block makes write workflows impossible.

### D-018 · Process model: a long-lived control server hosts sessions and runs — **Under review (2026-10-15)**: revisit in Module 5. **Decided in Module 5 (D-050): no long-lived server. Each command is one process, and the handoff operator control is the terminal.**
- **Decision:** One Node process (Express API + Server-Sent Events) owns the `SessionManager` and runs discovery and replay. The CLI and the React dashboard are thin clients of this API.
- **Why:** A paused run waiting for a human must keep its live session. A short-lived CLI process can't hold it while the dashboard acts on it. The API is also the natural surface for an AI agent to invoke capabilities.
- **Trade-off:** Running the demo needs one more process.

### D-019 · Repository layout: npm workspaces — **Superseded by D-021 (2026-10-15)**
- `packages/contracts` (Zod schemas only)
- `packages/core` (surface, session, policy, observability, recorder, replay; **no LLM**)
- `packages/discovery` (LLM client + agent loop; depends on core)
- `apps/server` (control API + CLI)
- `apps/dashboard` (React)
- `apps/target-app` (mock tenant)

### D-020 · Development process: lead-engineer-driven, gated per step — **Superseded by D-028 (2026-10-15)**
- **Decision:** Each step follows this cycle: (1) Claude presents requirements, problem, constraints and acceptance criteria, without proposing a solution; (2) the lead engineer (user) proposes the approach; (3) Claude reviews it critically, and we finalize the design, files and test plan; (4) code is written only after explicit approval, then tests are run and results shared; (5) the user reviews before the step is marked complete.
- **Guardrails:** No PR, push or merge without explicit approval. No out-of-scope features without discussion. A design problem found during implementation goes back for discussion; it is not changed silently.
- **Docs updated after every step:** DECISIONS.md, PROGRESS.md, ARCHITECTURE_PLAN.md (only when the architecture actually changed), dailyStatus.md.
- **Why:** The user owns the design and must be able to defend every decision in a technical interview.

---

## Revision 2026-10-15: functionality-first, five modules

### D-021 · Development order: functionality-first, module by module — **Accepted (2026-10-15)**
- **Context:** The earlier plan started with workspace structure, data shapes and abstractions (M1.1–M1.6). That front-loaded design before any working behavior existed.
- **Decision:** Build around five functional modules, in order: (1) Mock Banking Application, (2) LLM-Driven Discovery, (3) Successful Workflow Recording, (4) Reuse Saved Workflows Without LLM Decisions, (5) Human Handoff. Then a final wrap-up. Internal structure (folders, data shapes, log format) is decided inside each module's design review.
- **Why:** Working functionality first, with design decisions made where the problem is concrete. This keeps us from over-engineering.
- **Trade-off:** Some later refactoring may be needed when modules meet. We accept that and keep the cross-cutting requirements (safety, evidence, no LLM in replay) visible so they aren't lost.
- **Supersedes:** D-019 (6-package layout). Conflict handling is provisional and will be discussed further during implementation.

### D-022 · Inputs, outputs and logging decided per module — **Accepted (2026-10-15)**
- **Decision:** Each module's design review decides what it needs, what it returns, success and failure behavior, and what evidence it produces.
- **Constraint:** The mandatory requirements are not deferred: typed inputs and outputs for recorded workflows, structured execution results, meaningful logs, failure evidence, secret/PII redaction. Logging starts simple.
- **Supersedes in part:** D-005 (all shapes defined upfront).

### D-023 · Start with the mock banking application — **Accepted (2026-10-15)**
- **Decision:** Module 1 is first. It's built with Node.js + TypeScript, Express and server-rendered HTML (EJS under consideration), and operated by Playwright **only through its visible UI**. No React.
- **Initial banking actions:** Get Savings Account Balance; Verify Checking Account. One tenant.
- **Credentials:** The user query and login credentials are separate inputs. Credentials never appear in the query, recorded workflow or logs.
- **Refines:** D-008.

### D-024 · One LLM for discovery; deterministic recording; replay without LLM decisions — **Accepted (2026-10-15)**
- **Decision:**
  - One LLM drives discovery.
  - Recording turns the successful run's actions and observations into a recorded workflow **without a second LLM**.
  - Replay follows the recorded workflow deterministically. It never calls the discovery LLM or any other LLM to choose or repair steps.
  - A failed or unverified run is never saved as reusable. A recorded workflow must pass a test replay before it counts as reusable.
- **Why:** Deterministic recording is reviewable and reproducible. It follows the PDF's theme: "the model discovers; deterministic replay is how it's invoked in production."
- **Open:** How we *prove* replay used no LLM (replaces the package-boundary mechanism in D-011). Decided in Module 4.

### D-025 · Workflow lookup starts simple and explicit; semantic search deferred — **Accepted (2026-10-15)**
- **Decision:** Start with simple, explicit lookup across the initial recorded workflows (`member.get_savings_balance`, `member.verify_checking_account`). If the request is ambiguous, the system doesn't guess or run an uncertain workflow. Semantic search or an LLM-based router is considered only if the number of workflows justifies it.
- **Open:** The exact lookup mechanism (gap G-5) is decided in Module 4.

### D-026 · React dashboard deferred — **Accepted (2026-10-15)**
- **Decision:** No dashboard is required. Human handoff starts with a visible Playwright browser plus a simple operator control that supports real takeover and resume. A dashboard is added only if we later agree it adds meaningful value.
- **Supersedes:** D-009.

### D-027 · Gaps against the PDF tracked, fixes decided per module — **Accepted (2026-10-15)**
- **Gaps:** G-1 (no risky action to demonstrate), G-2 (safety rules need an owner), G-3 (logs/evidence need an owner), G-4 (handoff triggers from discovery and risky steps), G-5 (query → workflow lookup), G-6 (final deliverables). Details are in `ARCHITECTURE_PLAN.md` §3.
- **Decision:** Each gap is resolved during the module where it arises. No new module or subsystem is added without discussion.
- **Open question for Module 2:** one shared checkpoint for every automated UI step (safety + who-is-in-control + logging)?

### D-028 · Development process: Phase A–E per module (and per step) — **Accepted (2026-10-15)**
- **Phase A:** Claude presents requirements, user-facing behavior, exceptions, acceptance criteria and out-of-scope items. No implementation proposals.
- **Phase B:** The lead engineer proposes the design.
- **Phase C:** Claude reviews critically: questions assumptions, finds gaps, compares alternatives, recommends simpler options, pushes back when the assignment isn't met.
- **Phase D:** Claude summarizes the agreed design, scope, exception handling, tests and effects on later modules. Then it waits for explicit approval.
- **Phase E:** Claude implements only what was approved, runs tests, shows results and limitations, and doesn't advance without approval.
- **Guardrails:**
  - No PR, push, merge or submission without explicit approval.
  - No unrelated features and no early work on later modules.
  - No major architecture change without discussion.
  - Nothing is marked complete without demonstrated acceptance criteria.
- **Terminology:** Use the plain terms agreed (module, banking action, user query, discovery, UI step, recorded workflow, workflow lookup, replay, human handoff, exception handling). Technical terms are introduced only after a plain-English explanation and approval.
- **Supersedes:** D-020.

---

## Module 1 — Mock Banking Application (2026-10-15)

### D-029 · Module 1 split: 1a core flow, 1b controlled failures, 1c Edit Profile later — **Accepted (2026-10-15)**
- **1a:** login, logout, member search, member details, same-page Savings/Checking switching, decoy buttons, business outcomes.
- **1b:** controlled failure settings: slow loading, server error, session timeout, unexpected notice popup. It gets its own Phase A–E.
- **1c:** Edit Profile with approval. Deferred until the basic system works. For now Edit Profile shows "Not available in demo."
- **Why:** Smaller steps are easier to review and test separately.

### D-030 · Member search is a normal page load; account switching updates the same page — **Accepted (2026-10-15)**
- **Decision:** Search submits a form and loads `/members?memberId=…`. Savings/Checking buttons fetch account data and update one details area without changing the URL.
- **Why (lead engineer):** An employee searches once and switches accounts without navigating. It also gives discovery and replay a realistic case: content changes while the URL doesn't, so automation must confirm the correct account is shown.
- **Stale-result safeguards:**
  - The details area is cleared on every click, and a loading message names the account.
  - Each request gets a sequence number, and only the latest one may render.
  - A response is shown only if its member ID and account type match the current selection.
  - A failed request shows an explicit error.
  - A "not logged in" response sends the user to login with "Session expired".
  - There's no page-side timeout for slow responses.
  - A new search is a full page load, so the previous member's details are gone.
- **Known behavior:** A page refresh clears the selected account. This is accepted.
- **Trade-off:** The app needs a small amount of plain browser JavaScript and an internal account-data request that the automation must never call directly. That restriction is enforced by safety rules in Module 2.

### D-031 · Account display rules and sensitive data — **Accepted (2026-10-15)**
- **Active:** masked account number (`••••0042`), status, balance (`$5,200.75`).
- **Not on file:** "No savings/checking account on file." (business outcome)
- **Restricted** means **permission denied**: "You do not have permission to view this account." No balance and no account number.
- **Closed:** masked number and "Closed". No balance.
- **The server never sends hidden values to the page.** Hiding them only on screen isn't enough, because automation and the LLM can read page content.
- Account numbers are always masked on screen (C-6). The reference screenshot shows full numbers; the masked display deliberately differs from it.

### D-032 · Decoy buttons — **Accepted (2026-10-15)**
- Loans and Credit Cards show "Not available at the moment." Edit Profile shows "Not available in demo." The message replaces the details area, so it always reflects the last button clicked.
- **Why:** Discovery has to choose the right button among several; it can't just click the only option. A visible message stops the LLM from thinking a click silently failed.
- **Related:** The screenshot's subtitle "Illustrative banking UI with distractor controls" was **left out**, because it would tell the LLM which buttons are decoys.

### D-033 · Exception coverage for Module 1 — **Accepted (2026-10-15)**
- **In 1a:**
  - E-1 invalid login
  - E-2 invalid member ID
  - E-3 member not found
  - E-4 permission denied (restricted)
  - E-5 account not on file
  - E-6 closed account
  - request-failed error state on the page
  - session-expired redirect
  - pages protected by login
  - logout
- **In 1b (controlled failure settings, not tied to member IDs; cannot be triggered by ordinary requests):** E-7 session expiry, E-8 slow loading, E-9 server error, E-10 unexpected notice popup (an on-page popup, not a native browser alert, because Playwright silently dismisses native alerts).
- **E-11, ambiguous member: not applicable.** It was considered and deliberately excluded: search accepts an exact 5-digit member ID only, so more than one match can't happen. No name search will be added.
- **Data:** The 10 sample members are kept unchanged; no extra records were added for failures. `mock-bank/data/members.json` is a copy of the original sample data file, which was removed from the repository as a duplicate (D-055).

### D-034 · Module 1a stack details — **Accepted (2026-10-15)**
- Express 5, EJS, `express-session` (in-memory store, standard for a mock), `tsx` to run TypeScript without a build step, strict TypeScript, Node ≥ 22.
- Credentials and session secret come from `.env`, loaded with Node's built-in `process.loadEnvFile`, so no extra package is needed. Only `.env.example` with fake values is committed.
- Login compares credentials in constant time and starts a fresh session after login.
- Pages use real buttons with visible text and labeled fields. **No test-only attributes.** The app's own `data-account`/`data-unavailable` attributes are internal wiring, and automation should identify buttons by their visible text.
- **Local git repository initialized.** No remote. Commits happen only after a step is approved.

### D-035 · Module 1a testing: manual review by the lead engineer; automated tests deferred — **Accepted (2026-10-15)**
- **Decision:** The lead engineer will test 1a manually. The planned automated Playwright tests (T1–T18) are deferred so we don't spend time on test cases yet. Claude ran a quick HTTP-level check (see PROGRESS.md).
- **Trade-off:** The browser-side behavior (switching, stale-result protection, error state) is checked only by hand for now. Automated tests can be added when Module 2 brings Playwright into the project.

### D-036 · Module 1b controlled failure settings — **Approved 2026-10-28** (implemented 2026-10-27; approved after the lead engineer's manual testing)
- **Process note:** The lead engineer asked to implement 1b directly, skipping a separate Phase A–D. Claude chose the simplest design that fits the rules already agreed (Q4, Q5, Q7). Every choice below is open for review.
- **How failures are switched on:** Environment settings read **once at startup** (`BANK_SESSION_TTL_SECONDS`, `BANK_SLOW_MS`, `BANK_SERVER_ERROR`, `BANK_NOTICE`). No URL, page or request can turn them on or off, so automation can't trigger or avoid them. Changing a setting means restarting the app. A value set in the shell overrides `.env`. Invalid values stop the app at startup with a clear message.
  - Rejected alternative: a switch the app accepts while running. It's more flexible, but it would need protection against being reached by ordinary requests.
- **E-7 Session expiry:** The session ends a fixed number of seconds **after login** (not after inactivity), which makes demos predictable. The next page load goes to login with "Session expired". The next account click gets "not logged in", and the page script redirects with the same message.
- **E-8 Slow loading:** The same delay applies to member search results and account details. The page shows "Loading…" with no page-side timeout.
- **E-9 Server error:** `search` shows a "Something went wrong" page (HTTP 500). `accounts` makes the account request fail, so the page shows "Unable to load account details. Please try again." `all` does both.
- **E-10 System Notice:** An on-page popup ("System Notice": scheduled maintenance, plus an **Acknowledge** button). It covers the whole page until acknowledged and appears every time a member's details are shown. It never appears on not-found or validation pages. It is not a native alert, because Playwright silently dismisses those.
- **The app's screens never reveal that a failure setting is on.** Only the startup log does, so the LLM gets no hint.
- **Trade-off:** One failure configuration per app start. The same member can still be tested normal vs. failing by restarting with different settings.

## Module 2: LLM-Driven Discovery

### D-037 · Discovery LLM provider: OpenAI — **Accepted (2026-10-28)**
- **Context:** D-006 planned Claude Opus 5.5. The available key is an OpenAI key (`OPEN_AI_KEY` in `.env`, git-ignored).
- **Decision:** Use OpenAI for discovery for now, because the project has credits there.
- **Model (2026-10-29):** `gpt-5.4-mini`. It's the newest "mini" model the key can use; the key was checked with a free model-list call. Whether to pin the dated version (`gpt-5.4-mini-2026-03-17`) for repeatable runs is decided in the Module 2 design.
- **Swappable (2026-10-29):** The code keeps the LLM provider swappable, so Claude or another LLM can replace OpenAI without changing discovery. How that's done is part of the Module 2 design.
- **Why:** The assignment requires a real LLM-driven run (FR-1.7), not a specific vendor. Using the credits we have unblocks the live run.
- **Trade-off:** It moves away from the earlier plan. The key is never logged or shown to the LLM, the same as the bank credentials.
- **Supersedes in part:** D-006 (provider only).

### D-038 · Module 2 design (9 points) — **Superseded by D-039 (2026-10-29)**: the original proposal, kept for history
- **Source:** The lead engineer's Phase B proposal (2026-10-29). Claude's review and the open questions are in dailyStatus.md (2026-10-29).
- **Proposal:**
  1. The LLM sees a compact, redacted accessibility snapshot: the task, the available elements with references, and feedback on the last step.
  2. Typed UI steps: click, fill, select, check/uncheck, wait_for, navigate, finish. Each uses an element reference from the latest snapshot.
  3. One shared checkpoint for every automated UI step, in discovery and replay. It validates the step, checks safety, checks who is in control, runs the step and logs it. This answers the D-027 open question.
  4. Default-deny safety rules: approved origins only, financial changes blocked, human approval for supported risky steps.
  5. No credentials, sensitive member data or balances in saved logs or recorded workflows.
  6. Stopping defaults: 10 steps, 2 minutes, 2 failures in a row, 2 repeats on an unchanged page, 10 LLM calls.
  7. Verification: checks on the final page, then a successful LLM-free replay with different valid inputs.
  8. Files: `capabilities/` (versioned recorded workflows), `runs/` (redacted JSONL), `evidence/` (curated).
  9. Command line: `cua discover` and `cua replay`.
- **Review findings (summary):**
  - Module 1 provides none of the proposed shared types. They are all new.
  - Points 7 (replay), 8 (`capabilities/`, `evidence/`) and 9 (`cua replay`) belong to Modules 3, 4 and the wrap-up (D-021, D-024).
  - Point 4 must follow D-017: block unless approved, not a blanket block.
  - The control check in point 3 must stay minimal until Module 5 (D-012).
  - The step list lacks read-value and request-human steps (D-007, R2-17), and includes select/check, which the bank doesn't use.
  - The stopping defaults are too tight for E-7 and E-10 and conflict with each other (10 steps vs 10 LLM calls).
  - Redaction (point 5) needs separate rules for what the LLM sees and what is saved.
- **Status:** Waiting for the lead engineer's answers to the open questions and approval.

### D-039 · Module 2 decisions (lead engineer, after review of D-038) — **Approved 2026-10-29; implemented 2026-10-29. Module 2 approved as complete 2026-11-06.**
- **Terminology:** Use plain terms (UI step, what the LLM sees, browser layer, shared step checkpoint, "who is in control" check, safety rules, log entry, recorded workflow). The meanings of D-004, D-005, D-010, D-012 and D-027 are unchanged.
- **Safety (applies D-017):** Block unless approved. In Module 2 a risky step stops the run with status `NEEDS_HUMAN`. A risky step never runs without approval. Default-deny: only the approved origin, pages and step kinds are allowed.
- **Scope (D-021, D-024):** Module 2 is LLM-driven discovery only. Replay, workflow recording, `capabilities/`, curated `evidence/` and the replay command are deferred. The interfaces stay clean, so they plug in later.
- **UI steps:** `click`, `fill`, `read`, `wait_for`, `request_human`, `finish`, and `navigate` (restricted to approved pages). Add more only when the demo UI needs them.
- **What the LLM sees (amends D-004):** A structured accessibility snapshot first. A screenshot is optional, configurable, and off by default. Steps always target snapshot references, never screen coordinates, so they can be recorded later (FR-2.5).
- **Redaction:**
  - A fake balance is saved in `result.json` only when it is a declared task output.
  - Member IDs are masked in logs.
  - Failure screenshots are not saved by default. A redacted text snapshot of the page is saved instead (FR-5.2).
  - Passwords and session tokens are never saved.
- **Log Out:** Not risky, but it changes the session. Allowed only when the task explicitly permits it; otherwise blocked.
- **Stopping limits (demo defaults):** 10 steps, 120 s, 2 failures in a row, stop before a second identical step on an unchanged page, 10 LLM calls. All are set by environment variables, checked at startup, and recorded in the run's metadata.
  - **Accepted consequence:** recovering from session expiry (E-7) needs about 15 steps, so with the defaults E-7 ends as a clean stop with a reason. Raising the limits demonstrates recovery.
- **Model:** Configurable. Prefer a verified pinned version (`gpt-5.4-mini-2026-03-17`, confirmed in the key's model list). Record the model actually used, as returned by the API.
- **Command:** `npm run discover`. A `cua` command can come later if needed.
- **Supersedes:** D-038 (proposal). Amends D-004 (screenshot no longer sent by default).

### D-040 · Module 2 approved follow-up answers (Q1–Q4) — **Approved 2026-10-29**
- **Q1 Risky steps:**
  - Explicit rules come first: Edit Profile is risky; Log Out changes the session.
  - A configurable keyword list is the fallback: Edit Profile, Transfer, Delete, Close Account, Update.
  - A risky click stops the run with `NEEDS_HUMAN` and is never executed. Merely seeing such a button does not stop discovery.
- **Q2 Credentials:**
  - The automation uses its own `BANK_LOGIN_USERNAME` / `BANK_LOGIN_PASSWORD`; the values may match the mock bank's.
  - Credentials never reach the LLM, logs or saved files.
- **Q3 Redaction:**
  - The failure text snapshot must be sanitized and size-limited (16,000 characters).
  - Inputs are declared and validated. The checkpoint resolves input references, so the LLM sees `<input:name>` and never the value.
- **Q4 Live testing:**
  - Up to 5 live runs initially, max 10 LLM calls each. Unit tests use a scripted fake LLM.
  - Track calls, tokens and estimated cost per run. Ask before exceeding 5 live runs.

### D-041 · Module 2 implementation choices made while building — **Implemented 2026-10-29; parts amended by D-042 (code review, 2026-10-30)**
Claude made these choices inside the approved design. Each one is open for review.
- **What the LLM sees:**
  - Playwright 1.64's accessibility snapshot in "ai" mode gives roles, names and element references, and `getByRef` acts on them. Wrapper elements with nothing to show are collapsed.
- **Password leak found and closed:**
  - Playwright's snapshot includes the *typed value of the password box* in plain text.
  - The browser layer blanks the value of any password-type box before anything else sees it. The LLM view and logs show `(value hidden)`. Credential strings are also scrubbed from all text as a second guard.
  - Covered by tests.
- **Redaction:**
  - **LLM view:** declared input values → `<input:name>`; the value after a sensitive label (`SAFETY_SENSITIVE_LABELS`, default "Member Name") → `[redacted]`. Balances stay visible, because the LLM must find and read them.
  - **Saved text:** the same rules, plus amounts → `$[amount]` and any other 5+ digit number masked to its last 2 digits.
  - **result.json:** holds the real value of declared outputs only.
- **Credentials:**
  - Credentials may be typed only on `/login`.
  - The password goes only into the password box, and nothing else goes there.
- **Inputs and outputs:**
  - Inputs are checked for format only: a lower_case name, 1–64 printable characters. Bank rules are deliberately not checked, so an invalid member ID still reaches the bank and comes back as a business outcome (E-1).
  - Outputs are typed `text` or `currency`. A `read` step must name a declared output.
- **Page settling:**
  - After a step, the browser layer waits up to 1.5 s for the page's own requests to finish. Playwright's "networkidle" does not cover requests made after a click.
  - A slower page is left mid-load on purpose, so the LLM sees "Loading…" and chooses `wait_for` (E-8).
- **Repeat rule:**
  - A step is "the same" when its kind and arguments match, the reason text is ignored, and the page is unchanged.
  - On an unchanged page, element references are stable, so the reference identifies the element. *Fixed after live runs 1–2:* comparing by role and name had wrongly treated two different nameless text elements as one.
- **Feedback to the LLM:**
  - After a `read`, the LLM is told the captured text; logs keep only its masked shape.
  - Once every declared output is captured, the prompt says to call `finish`. *Added after live runs 1–2*, where the LLM re-read instead of finishing.
- **Result checks (`finish` success):**
  1. Every declared input value is shown as page text.
  2. Every output was captured by `read` and is still shown.
  3. The output sits under a section heading containing the first word of its name (`savings_balance` → "savings").
  4. Currency outputs look like `$x,xxx.xx`.
- **Result checks (business outcome):** the evidence element must be on the page; its text becomes the message.
- **Counting:** every LLM reply handed to the checkpoint counts as a step, including invalid ones. The LLM library's own retries are off, so every API call is counted.
- **LLM call:**
  - OpenAI chat completions with one tool per step kind; a step must be chosen, one at a time.
  - Reasoning effort is the model's default unless `LLM_REASONING_EFFORT` is set.
  - Prices are $0.75 / $4.50 per million input/output tokens (configurable). Source: OpenAI's gpt-5.4-mini model page.
- **Ready for Module 3:** each step log entry records the target's role, name, label and section heading. For example, the balance read is `{role: generic, label: "Balance", heading: "Savings Account"}`.
- **Exit codes:** 0 for success or a business outcome, 2 for `NEEDS_HUMAN`, 1 for failed.
- **New discovery-only situations:**
  - E-12: decoy buttons.
  - E-13: the LLM misbehaves (invalid reply, step not permitted, repeats).
  - E-14: the LLM service is unavailable or the key is missing.
  - They are recorded here and in PROGRESS.md, not in REQUIREMENTS.md: there, "E-" numbers mean environment facts from the PDF, so adding them would clash.

### D-042 · Module 2 code-review fixes — **Approved by the lead engineer 2026-10-30 ("fix all"; #3 and #7 agreed); implemented. Module 2 approved as complete 2026-11-06.**
- **Source:** An independent review subagent found 2 high, 6 medium and 5 low issues and reproduced six of them with the fake LLM. The lead engineer approved fixing all of them. Each fix has a test.
- **#1 Member name could leak (high):**
  - A `read` of an element after a sensitive label, or of a password box, is refused.
  - Redaction remembers every value it hid and scrubs it everywhere afterwards (step feedback, errors, reasons).
  - *Found while testing the fix:* captured text was quoted before redaction, so escaped line breaks (`\n10042`) hid the member ID from the redaction rule. Text is now redacted before quoting, for both the LLM and the log.
- **#2 False business outcomes (high):**
  - Evidence must be a plain text message (not a button, link or text box) with non-empty text.
  - The message saved is that same text.
- **#3 Section rule (amends D-041 result checks; agreed):**
  - Output names must start with their section (`savings_balance`); the command line enforces it.
  - The check uses the heading of the element that was **actually read**, and is always applied.
  - The "still shown" check uses the same element, or the same text in the same section.
  - *Known limit:* a vague section name (`account_balance`) still matches both accounts. The name is the caller's choice.
- **#4 Reasons in result.json:** redacted with the saved-text rules before saving or printing.
- **#5 Time limit:**
  - Time is checked again after the LLM replies, so a late reply is never acted on.
  - The LLM timeout and `wait_for` are capped at the time left, with no minimum.
  - An LLM timeout at the deadline is reported as TIME_LIMIT.
  - *Still possible:* a single click or page load can run up to its own 5 s / 20 s Playwright timeout past the deadline.
- **#6 Unexpected errors:**
  - The loop is wrapped so an unexpected error ends as FAILED `UNEXPECTED_ERROR`, with result.json written.
  - The browser always closes.
  - Display errors from the console listener can no longer stop a run.
- **#7 Screenshots (amends D-041; agreed):**
  - Screenshots are painted over (Playwright `mask`) on every text box, values after sensitive labels, and elements showing a declared input value.
  - Saved failure screenshots also cover amounts and 5+ digit numbers.
  - Both stay off by default.
- **#8 Risky clicks:**
  - Checked against the name, else the visible text, else the label.
  - A clickable element with none of these is refused.
- **#9 Failure snapshot:** taken of the page the browser is on when the run stops.
- **#10 Page settling:**
  - Requests are tracked individually, not by a counter.
  - *Found while adding the slow-bank test:* a whole-page navigation (form submit) is now always waited for, up to 20 s. Only in-page data loading is capped at 1.5 s, so "Loading…" still reaches the LLM (E-8).
- **#11 Settings and command line:**
  - Credentials are used exactly as given and must be at least 4 characters.
  - A protection list that parses to empty is refused.
  - Duplicate `--output`, an extra `:` part, and `--help` are handled.
  - Input values are trimmed.
- **#12 OpenAI:** the reply's finish reason is logged (shows cut-off replies); the unused text field is removed.
- **#13 Clean-up:**
  - Dead code removed.
  - Every step log entry carries `source`.
  - `wait_for` text and `navigate` path are logged for Module 3.
- **Tests:** 47 pass (22 unit, 25 end to end), stable over two runs, no API calls.
  - New end-to-end tests: protected read, false evidence, risky keyword, navigate, reason redaction, late reply, capped wait, no step / unreadable arguments, unexpected error and browser closing, screenshot masking, slow bank (E-8) and session-expiry recovery (E-7, with raised limits).
  - Leak checks now also run on the failure tests.

## Module 3: Successful Workflow Recording

### D-043 · Module 3 decisions (lead engineer, 10 points) and review findings — **Proposed 2026-10-30. Partly superseded by D-044 (lead engineer's design review, 2026-10-30)**: hashes, history.jsonl, duplicate detection, semver classification, static safety re-check, config split and session-expiry "keep first login + steps after last login" are dropped. The evidence findings are kept.
- **Lead engineer's decisions (approved as requirements):**
  1. Record only verified `SUCCESS` runs. Workflows still carry business-outcome rules, taken only from documented Module 1 behavior, observed UI evidence or a reviewed catalog.
  2. Recording is deterministic with zero LLM calls. Refused, failed and proven-unnecessary steps are removed. Popups become conditional steps, waits are bounded and condition-based, and session expiry becomes conditional login recovery. If the evidence is not enough, the recording is refused rather than guessed.
  3. One source run per recording, with no merging. A different valid path becomes a separate draft version.
  4. The contract includes name, description, typed inputs and outputs, ordered parameterized steps, semantic locators with grounded fallbacks, a robustness note for each, checkpoints, final success conditions, output extraction rules, business outcomes, and schema and workflow versions. Member-specific values are never used as locators.
  5. No credentials, tokens, member names, member IDs, account numbers or balances. References only. Strict schema on save and load. Replayed steps still pass the shared safety rules.
  6. Module 3 only creates `draft` workflows. Promotion to `reusable` after a test replay (preferably with a different member) belongs to Module 4. Versions are immutable, and status is stored separately.
  7. Workflows live at `capabilities/<name>/<version>.json`, never overwritten. Canonical content is deterministic. A hand edit needs a new version and a replay before promotion.
  8. Legacy web, desktop, tenants and drift are design write-ups only.
  9. A separate command, `npm run record -- --run <folder>`. Discovery does not record automatically.
  10. Acceptance criteria 1–12 (PROGRESS.md).
- **Review against the assignment and earlier decisions:** no conflicts. Notes:
  - **D-013 says `<semver>.json`.** Proposal: the first recording is `1.0.0`. A new path for the same contract is the next minor version. A changed contract (inputs or outputs) is the next major version.
  - **D-024 says a workflow must pass a test replay before it is reusable.** This is kept: Module 3 stops at draft, and Module 4 promotes.
  - **D-005 (Zod is the source of truth).** The workflow shape is a Zod schema, with a generated JSON Schema file for reviewers.
- **Evidence check of the saved discovery runs (found while inspecting `runs/`):**
  - **Live run 6** (savings, after D-042) has enough evidence. Every step logs role, name, section heading and, for the read, the label (`Balance` under `Savings Account`). Values are references, and the masked text `$[amount]` is not needed as a locator.
  - **Live runs 3 and 5** were made before D-042. Their read step logs only `{role: generic}`, with no label or heading. **The output locator cannot be derived, so recording must refuse them** (criterion 11). Criterion 2 (Verify Checking Account) therefore **needs one new live discovery run** (run 8), which needs approval.
  - **Not in the run folder, by design:** page snapshots before each step (privacy) and element counts. Whether a locator is unique cannot be proven when recording, so replay must require exactly one match. The Module 4 test replay is the gate.
  - **Not in the run folder:**
    - Input formats (values are redacted).
    - Whether a step was optional. One run cannot show that a popup "sometimes doesn't appear".
    - The workflow's name.
    - Test IDs. The snapshot exposes accessible roles and names, not HTML ids.
- **Proposed answers to the gaps (for approval):**
  - **Known-conditions catalog**, reviewed and in code. Each entry cites its source (Module 1 code or docs, or a live run):
    - interruptions: System Notice → Acknowledge (E-10); "Loading …" → wait until gone (E-8); session expired → log in again and restart the main steps (E-7); "Unable to load account details" → transient error (E-9)
    - business outcomes: "Member not found." (live run 7); "Enter a valid 5-digit member ID."; "No <type> account on file."; "You do not have permission to view this account." (live run 4); Status "Closed"
    - input types: `member_id` = 5 digits
  - A run step becomes conditional **only if it matches a catalog interruption**. An unknown extra step stays mandatory, and the Module 4 test replay will expose it.
  - **"Proven unnecessary"** means only:
    - a read later repeated for the same output (the last read is kept)
    - an identical fill repeated back to back
    - a login repeated after session expiry: keep the first login, then the steps after the last login
    - Any other click is kept, because a log cannot prove it was useless.
  - **Name** comes from a required `--name` flag (e.g. `member.get_savings_balance`). The description is the goal as logged, with input placeholders.
  - **Status and integrity:** the workflow file has no status field. `capabilities/<name>/history.jsonl` is append-only and records `recorded` (draft, source run, content hash, time) and, later, `promoted`. Loading a version whose hash no longer matches is refused (it was edited after recording).
  - **Duplicates:** if the canonical content equals an existing version, no new version is written. A history line notes the extra source run.
  - **Static safety:** every recorded step is checked against the current safety rules when recording. Risky targets, credentials outside the `/login` password and username boxes, unapproved paths and sensitive-label reads are refused. The safety lists come from settings that do not require the API key or bank credentials (a small split of `config.ts`, with no change in behavior).
- **Open for the lead engineer:** Q1 live run 8; Q2 "Closed" for checking; Q3 hand-edit path; Q4 test fixtures from real runs. See dailyStatus 2026-10-30.

### D-044 · Module 3 revised plan (after the lead engineer's design review) — **Approved 2026-10-30 with these answers: Q1 option A (report status); Q2 keep D-013 semver, using simple patch increments (the whole-number proposal below was not accepted); Q3 live run 8 with BANK_NOTICE=on. Implemented 2026-10-31 (D-045); awaiting review.**
- **Simplifications of earlier decisions (explicit):**
  - ~~**D-013 amended (proposed):** whole-number versions.~~ **Not accepted.** D-013 is unchanged: `capabilities/<name>/1.0.0.json`, then `1.0.1.json`, and so on (simple patch increment). Files are written with "create only", so an existing version can never be overwritten.
  - **D-043 dropped:** content hashes, `history.jsonl`, duplicate detection, major/minor classification, the static safety re-check when recording, and the `config.ts` split.
    - The run's own log entries already carry the safety verdict. Only steps logged `safety: allow, outcome: done` are kept, and a run with a risky step can't end in SUCCESS.
  - **Status:** one small file per workflow, `capabilities/<name>/status.json` (`{"1": "draft"}`). Module 3 writes `draft`, and Module 4 sets `reusable`. Version files stay immutable.
  - **Generated JSON Schema file:** deferred (optional). Inputs and outputs are written in JSON-Schema style inside the workflow, so a calling agent can use them directly.
  - **Hand editing:** not supported and no CLI. Rule documented only.
- **Session expiry (revised):** a run containing a second login is accepted **only if** the steps before the expiry exactly repeat the start of the steps after the new login (same kind, locator and value). Then the earlier copy is a proven duplicate. Otherwise the recording is refused: "session expired mid-run and the steps before and after differ; record from a run without expiry". Nothing is removed on assumption.
- **Checkpoints are structured conditions** from a small closed set: `path`, `visible` (locator, exactly one match), `gone` (text), `inputShown` (input name), `outputFormat`. Each step's checkpoint is "the next step's element is visible" (plus `path` when the page changes). This is grounded in the log, because the next step acted on that element. Final success conditions are the Module 2 result checks in this form.
- **Locators:** role plus name (or label) within a section heading. Exactly one match is required at execution (enforced by Module 4).
  - The only fallback is the same observed evidence without the section scope, and it still needs exactly one match.
  - Masked or redacted text is never a locator.
  - A step with no usable locator means the recording is refused.
- **Catalog** (`catalog.ts`), each entry with its source:
  - business outcomes: NOT_FOUND, INVALID_INPUT, NO_ACCOUNT, PERMISSION_DENIED, ACCOUNT_CLOSED (D-031 and Module 1 code; NOT_FOUND and PERMISSION_DENIED also seen live)
  - interruptions: System Notice (E-10), Loading (E-8), session expired (E-7), load error (E-9, recognized as a failure)
  - input format: `member_id` 5 digits
- **Fixtures:** synthetic only. Test run folders are produced by fake-LLM discovery against the test bank, or written by a test helper. Real run folders are not committed. The recorded workflow from live run 6 goes to `capabilities/` after a leak scan.
- **Open:** the Verify Checking Account contract (report status vs. verify active), and approval of the D-013 amendment.

### D-045 · Module 3 implementation notes — **Implemented 2026-10-31. Criterion 2 met live by run 9 after D-046; Module 3 complete 2026-11-01.**
- **Built:** `automation/src/workflow/`
  - `schema.ts` (Zod workflow, conditions, locators)
  - `read-run.ts` (who may be recorded)
  - `catalog.ts` (documented conditions, each with its source)
  - `record.ts` (clean-up and build)
  - `store.ts` (versions, `status.json`, load)
  - `record-cli.ts` (`npm run record`)
- **Small choices made while building (within the approved plan):**
  - The description uses `{member_id}` instead of the log's `<input:member_id>`.
  - The read step has no checkpoint of its own; the final success conditions cover it.
  - Re-recording the same run creates the next patch version with identical content, because duplicate detection was dropped by agreement.
  - Runs that type free text (`{text}`) are refused. Neither banking action needs free text, and it could carry anything.
  - A login block is the run of consecutive steps on `/login`.
  - Workflows start at `/`.
- **One addition beyond the plan:** a `server_error_page` conditional step (fail on "Something went wrong"). It is E-9's search-error case, next to the planned "Unable to load account details" case. Both come from D-036.
- **Live run 8 (approved):** Verify Checking Account for 10050 with `BANK_NOTICE=on`.
  - The notice was acknowledged and "Active" was read. The read logged label "Status" and section "Checking Account", so the evidence was complete.
  - The LLM then chose the same read again instead of finishing, so the run ended **FAILED REPEATED_STEP** (8 steps, 9 calls, ≈ $0.0116). This is the same Module 2 behavior as live runs 1–2.
  - The recorder correctly refuses the run. Acceptance criterion 2 is therefore **not met live**; it is shown only with the fake LLM.
- **Design problem found (Module 2; fixed by D-046 on 2026-11-01):** once every output is captured, the LLM can still choose another read. A possible fix is to offer only `finish` / `request_human` at that point. That changes the approved Module 2 design, so it needs the lead engineer's decision and a further live run.
- **Known limits:**
  - Recording cannot prove that a locator is unique; Module 4 must require exactly one match.
  - A label locator depends on the browser layer's "text just before" rule, so replay must use the same page view.
  - A click that may have been wasted is kept unless a rule proves it unnecessary.
  - A business outcome means the next checkpoint will not hold, so Module 4 must check conditional steps and business outcomes before reporting a checkpoint failure.
  - The catalog is specific to the mock bank and maintained by hand.
  - Recording trusts the run folder's content. There is no tamper check, by agreement.


### D-046 · Module 2 repeated-read fix and live run 9 — **Approved and done 2026-11-01**
- **Lead engineer's decision:** fix the repeated read with the smallest possible change, add a regression test, rerun the checking discovery once (run 9, `BANK_NOTICE=on`), and treat Module 3 as complete if its acceptance criteria then pass. No broader Module 2 changes.
- **Change (one line of behavior, `automation/src/discover.ts`):** once every declared output is captured, the LLM is offered only the `finish` and `request_human` steps. Everything else is unchanged:
  - the prompt and the stopping rules
  - the finish checks (a wrong read still fails verification)
  - a business-outcome finish is still possible
- **Regression test** (`discover.test.ts`): `read` is offered before the capture; afterwards exactly `finish` and `request_human` are offered, and the run succeeds. 81 tests pass; the type check is clean.
- **Live run 9** (`runs/20261101T174514-aae85a`, 10050, notice on):
  - Steps: logged in, searched, acknowledged the notice, opened Checking, read "Active", then **finished. SUCCESS**, all 4 checks passed.
  - 9 steps, 9 calls, 12,469 / 353 tokens, ≈ $0.0109.
  - The live total is now 9 runs, 73 calls, ≈ $0.091.
- **Recorded** → `capabilities/member.verify_checking_account/1.0.0.json`, draft.
  - 4 main steps (fill_member_id, click_search, click_checking_account, read_checking_status) plus login. The read target is `{label:"Status", within:"Checking Account"}`.
  - `system_notice` is marked seen in the source run. There is no ACCOUNT_CLOSED rule (D-044 Q1 option A).
  - Leak scan clean: no credentials, no member ID, no name, no amounts or masked text.
- **Result:** Module 3 criterion 2 is met live, so all 12 criteria are met. **Module 3 complete.**

### D-047 · Module 4 replay plan — **Approved 2026-11-01 with R1–R6 as below; implemented (D-048).**
- **Scope:** deterministic replay of a recorded workflow with new typed inputs, with no LLM. Out of scope:
  - Module 5 human takeover (replay only returns NEEDS_HUMAN)
  - natural-language workflow lookup (open question R1)
- **New files** in `automation/src/replay/`:
  - `locate.ts`: matches a locator or condition against the page view, and requires exactly one match.
  - `replay.ts`: the engine.
  - `replay-cli.ts`: `npm run replay`.
  - `automation/test/replay.test.ts`: the tests.
- **Small changes to existing code:**
  - `browser.ts` lists every element of the latest view with its label and heading, using the same rule recording used.
  - `config.ts` can read the bank settings without the LLM settings.
  - `store.ts` gets `promote()` and `latestReusable()`.
- **Reused as is:** the shared step checkpoint, with `source: "replay"`. It applies the safety rules, the "who is in control" check and the log entry for every replay step. The redactor and the run folder are reused too.
- **Flow:**
  1. Validate the workflow and the inputs before opening a browser.
  2. Log in, then run each main step:
     - handle interruptions and business outcomes
     - resolve the target to exactly one element
     - run the step through the checkpoint
     - poll for its expected conditions
  3. Check the success conditions, then return the outputs read during this replay.
- **Results:** SUCCESS, BUSINESS_OUTCOME, FAILED or NEEDS_HUMAN, plus a list of recovered events. A failure names the step, what was expected and what was observed, and includes a sanitized page snapshot.
- **Promotion:** only a SUCCESS replay of a draft, with explicit `--promote`, changes `status.json`. The workflow file never changes.
- **Lead engineer's decisions:**
  - **R1:** explicit names first, then a small exact-phrase lookup. No LLM routing, semantic search or registry; unknown or ambiguous requests are refused.
  - **R2:** an explicit `--promote`, only after a successful replay; the workflow JSON is never modified.
  - **R3:** the default is the highest reusable version. `--version` selects a draft. With no reusable version and no `--version`, the replay gives a clear error.
  - **R4:** a format failure returns BUSINESS_OUTCOME INVALID_INPUT before a browser opens. This is distinct from a malformed file or missing arguments, which are not run.
  - **R5:** an unknown dialog returns NEEDS_HUMAN with evidence. A fallback is used only when the primary matches zero and the fallback exactly one, and its use is recorded. A primary with several matches fails AMBIGUOUS_TARGET.
  - **R6:** `elements()` and a config without the LLM settings are approved; avoid other Module 2 changes.
- **Clarifications:**
  - Drafts are replayable by explicit version.
  - Session-expiry restart happens once and only for read-only workflows (documented).
  - `result.json` may hold the outputs; credentials are never saved.
  - Business outcomes and interruptions are checked before a checkpoint failure.
  - SUCCESS only when verified.
  - A wrong catalog locator is reported before the Module 3 catalog is changed.
  - No Module 5.

### D-048 · Module 4 implementation notes — **Implemented 2026-11-01. Module 4 approved as complete 2026-11-01 (after D-049).**
- **Built:**
  - `automation/src/replay/` (`locate.ts`, `replay.ts`, `lookup.ts`, `replay-cli.ts`)
  - `capabilities/phrases.json`
  - `npm run replay`
  - 37 new tests (`replay.test.ts`); 118 tests in total.
- **Existing code touched (small, behavior unchanged for discovery):**
  - `browser.ts`: `elements()`, using the same label and heading rule.
  - `config.ts`: shared setting readers plus `readReplayConfig`, with no LLM settings.
  - `steps.ts` / `redact.ts`: the currency pattern and the screenshot mask patterns moved here from `discover.ts`, so replay can use them without importing discovery.
  - `store.ts`: `selectVersion` and `promote`.
- **Checked against the real page view (clarification 5):**
  - "Member not found." and "Enter a valid 5-digit member ID." are inside "Member Search" ✅.
  - The account messages and the Status/Balance labels match the catalog ✅.
  - The error page heading matches ✅.
- **Catalog problem found (fixed by D-049 after approval):**
  - `system_notice.when = {visible:{role:"dialog", name:"System Notice"}}` never matches. The page view shows the dialog as `{"role":"dialog"}` with no name; "System Notice" is the heading inside it.
  - Effect: with `BANK_NOTICE=on`, both recorded workflows return **NEEDS_HUMAN UNEXPECTED_DIALOG**. That is safe, but not the planned recovery.
  - **Proposed correction:**
    1. In `catalog.ts`, change it to `when: [{visible:{role:"heading", name:"System Notice"}}]`. The Acknowledge target, scoped `within: "System Notice"`, already works.
    2. Re-record runs 6 and 9, giving 1.0.1 drafts.
    3. Replay them with the notice on, then promote. The 1.0.0 versions stay as they are.
  - A test with a corrected copy shows the engine then acknowledges the notice and succeeds.
- **Promotion evidence:**
  - Real local bank (notice off): savings 10048 → $2,800.40 (`runs/20261101T181911-a3feec`) and checking 10047 → "Closed" (`runs/20261101T181913-77edf9`).
  - Both were run with `--version 1.0.0 --promote`, and both `status.json` files now say `"1.0.0": "reusable"`. The workflow files are unchanged.
- **Small choices:**
  - Exit code 3 means "not run".
  - `REPLAY_MAX_SECONDS` is 60 by default.
  - A failed promotion is logged and leaves the status unchanged.
  - A test-only `openBrowser` option (used to make a session expire) is not reachable from the CLI.
- **Known limits:**
  - **Clicks after a session expiry are slow:** each click then waits the browser layer's full 1.5 s settle time, as if a request were still in flight (Module 2 browser layer; latency only, not fixed).
  - **"Who is in control" never changes yet:** the check runs on every step, but it can't be switched until Module 5.
  - **Unknown dialogs only:** "unknown interruption" detection covers dialogs, not other overlays.
  - **Exactly one match is checked in the page view, not the DOM.**
  - **Member 10077 doesn't exist:** the PDF's example member returns NOT_FOUND.

### D-049 · System Notice condition fix and 1.0.1 recordings — **Approved and done 2026-11-01. Module 4 approved as complete 2026-11-01.**
- **Change (`catalog.ts`):** `system_notice.when` is now two conditions that must both hold:
  - `{visible:{role:"heading", name:"System Notice"}}`
  - `{visible:{role:"button", name:"Acknowledge", within:"System Notice"}}`

  The dismissal target is the same Acknowledge button. A heading can't be scoped to the dialog: in the page view a heading carries no section of its own, and a locator has no "inside a dialog" field. So the heading plus its button together identify the notice, and each must match exactly one element.
- **Re-recorded** live runs 6 and 9 as **1.0.1** drafts (`npm run record`).
  - The only difference from 1.0.0 is the notice condition and its `why` text.
  - The 1.0.0 files are byte-for-byte unchanged (checksums).
  - Leak scan clean.
- **Real local bank:**
  - Notice on: savings 10048 → SUCCESS $2,800.40 and checking 10050 → SUCCESS "Active", each with `system_notice ×1` recovered. Runs `20261101T182326-44d635`, `20261101T182329-0f734a`.
  - 1.0.0 with the notice on still returns NEEDS_HUMAN UNEXPECTED_DIALOG.
  - Notice off: both run 7 steps with no conditional step, then were promoted with `--promote`. Runs `20261101T182342-b60858`, `20261101T182344-1f12b3`.
  - Default selection now picks **1.0.1 (reusable)**.
  - `status.json`: `{"1.0.0":"reusable","1.0.1":"reusable"}`.
- **Engine bug found by the regression run and fixed (Module 4 code):** running out of replay time *while waiting* for a target or checkpoint was reported as TARGET_NOT_FOUND or CHECKPOINT_FAILED instead of TIME_LIMIT; whether it showed depended on timing. Waits now report TIME_LIMIT when the overall limit is reached, and a regression test covers it.
- **Tests:** 121 pass (three runs); type check clean. New or changed tests:
  - the notice is dismissed in both 1.0.1 workflows
  - the handler doesn't interfere when there is no notice
  - a genuinely unknown dialog (no handler) returns NEEDS_HUMAN and nothing is clicked
  - 1.0.0 stays safe
  - the default picks the highest reusable version
  - the time limit while waiting
  - the Module 3 test locks the new condition
  - test copies of `capabilities/` reset to drafts
- **Known limitation of 1.0.0 (lead engineer, 2026-11-01):** both 1.0.0 workflows stay reusable and unchanged, but their notice condition never matches. With the System Notice on, they return NEEDS_HUMAN UNEXPECTED_DIALOG. **1.0.1 is the preferred reusable version** and is what default selection picks. Use 1.0.0 only by explicit `--version`, for comparison.
- **Module 4 approved as complete** (15/15 criteria, 121/121 tests, real-bank replay with zero LLM calls). The remaining limitations were accepted for the scope of the assignment.

### D-050 · Module 5 human handoff plan — **Approved 2026-11-01 with the lead engineer's answers to H1–H8 and 7 extra requirements; implemented (D-051).**
- **Scope:**
  - Replay can pause on a handoff-eligible stop.
  - It gives the same live, visible browser to a person, records the person's actions, and takes control back when the person says "done".
  - It then re-checks the page and resumes, or stops safely.
  - No dashboard, no remote desktop, no approval platform (D-026).
- **Builds on D-012:** one control state `{owner, epoch}`, shared by the step checkpoint and the replay engine.
- **Open decisions:** H1–H8, as presented in the session (triggers, discovery scope, typed values, operator control, cancel/timeout results, human-assisted SUCCESS, input while automation is in control, demo).
- **Lead engineer's answers (2026-11-01):**
  - H1: approved with safeguards. Hand off NEEDS_HUMAN and the recoverable step failures; never BANK_ERROR, TIME_LIMIT, BROWSER_ERROR or a failed final success check. Re-check the page after a handoff; never blindly retry.
  - H2: include minimal discovery support, reusing the same mechanism. Report a blocker before expanding scope.
  - H3: approved. Timestamps, event types, redacted element descriptions; never passwords, credentials, typed values or member data.
  - H4: approved. The visible browser plus terminal Enter / cancel.
  - H5: approved. Cancel → FAILED HANDOFF_CANCELLED; timeout → NEEDS_HUMAN HANDOFF_TIMEOUT; 600 s; at most 2 handoffs; replay time limit paused.
  - H6: approved. SUCCESS with `handoffs[]` and the control timeline; never promoted.
  - H7: accepted limitation. Document that the operator must not touch the browser until control is handed over.
  - H8: approved. The lead engineer will do one real manual takeover.
  - Extra requirements: (1) a holding checkpoint proves page state, not the person's action; human-action logs are separate evidence. (2) Never run a risky step after a handoff. (3) Verify the same live browser and page, not only a matching id. (4) No duplicated events across navigations or repeated handoffs. (5) Clean up on every ending. (6) Unchanged behavior without `--handoff`. (7) Tests for replay and discovery handoff, control, redaction, safe resume, cancel and timeout.

### D-051 · Module 5 implementation notes — **Implemented 2026-11-01. Real manual takeover by the lead engineer 2026-11-06 (run `20261106T223030-649180`, in `evidence/4-handoff/`). Module 5 approved as complete 2026-11-06.**
- **New pieces:**
  - `automation/src/control.ts`: one "who is in control" state per run, `{owner, epoch, history}`. Every change is logged as `control_changed`. The shared step checkpoint uses it, and each step log entry carries `controlEpoch`.
  - `automation/src/handoff.ts`: `Handoffs`, shared by replay and discovery. It saves `handoff-N.json` (the redacted intervention request), records the person's actions, hands control over, waits for done / cancel / timeout / closed window, cleans up, and hands control back only on "done" with the window still open. Also `terminalChannel()`, the operator control.
  - Browser layer: `sessionId`, `watchHuman()`, `onLost()`, `isOpen()`, and `livePageForTests()`, which only a simulated person in tests uses.
- **Recording the person's actions:**
  - A page script reports trusted clicks, typing, form submits and Enter on controls only. Navigations are reported by path only.
  - Saved entry: `human_action {ts, handoff, source:"human", controlEpoch, kind, path, element{role, name}, value:"hidden"}`.
  - Recorded only while a person is in control. Typing in one field is one entry, and the value is never read.
  - Found and fixed during testing: the browser's `change` event fires when a field loses focus, so it blamed the person for automation's earlier typing. The `input` event is used instead.
  - The script and bridge are installed once per session and guarded per page, so events are never duplicated (test: two handoffs with a navigation in between, one entry per click).
- **Replay resume (after "done"):**
  1. The page must be approved; otherwise hand off again.
  2. Look at the page the usual way: interruptions, business outcomes, unknown dialog.
  3. Pass over **click** steps whose non-empty checkpoint already holds, logged as `stepsPassed`. A holding checkpoint shows the page state, not what the person did.
  4. Fill and read steps always run again, so outputs are always read by automation. The final success checks still apply: a person who searched a different member gives FAILED SUCCESS_CHECK_FAILED.
- **Risky steps:** a step stopped by the safety rules is never run by automation again. It is passed over only if its checkpoint shows the page state it leads to. Otherwise the run asks again, then stops: FAILED RESUME_FAILED at the limit.
- **Endings:**
  - cancel → FAILED HANDOFF_CANCELLED
  - timeout → NEEDS_HUMAN HANDOFF_TIMEOUT
  - window closed → FAILED HANDOFF_SESSION_LOST
  - handoff limit → FAILED RESUME_FAILED
  - Control stays with the person after a cancel or timeout. The replay and discovery time limits are moved on by the handoff time.
- **Discovery:**
  - On NEEDS_HUMAN (request_human, a risky step, or a page outside the approved area), the loop pauses: no LLM call and no step while the person has control.
  - After "done", the next turn looks at the page afresh. The LLM's history says a person helped, but never what they typed or saw.
  - At the limit, the result is NEEDS_HUMAN, as before.
  - No blocker; no extra architecture was needed.
- **Recording guard (Module 3, related):** `readRun` refuses a run with any handoff, because a person's actions are not replayable steps.
- **Settings:** `HANDOFF_TIMEOUT_SECONDS` (600, 10–3600) and `HANDOFF_MAX` (2, 1–5), shared by both. The plan's `REPLAY_*` names were changed because discovery uses them too. `--handoff` on `discover` and `replay` is refused when `BROWSER_HEADLESS=on`.
- **Operator input:** the terminal control reads every line (a line typed early is not lost) and discards input typed before a handoff begins, best effort. A stray Enter could still end a later handoff early, but resume re-checks the page before continuing.
- **Same session (requirement 3):**
  - Tests check the person acted on the same Playwright page object automation drove, with one browser for the run, no second login, and resumed steps logged under the new epoch.
  - The real run logs the same `sessionId` at handoff, resume and finish, and `sessionOpen: true`.
- **Known limitations:**
  - H7: input while automation is in control can't be blocked, and is not recorded. The terminal shows who is in control at every change.
  - A second tab the person opens is not watched.
  - A session that expires during a long handoff causes a normal re-login and restart.
- **Tests:** 24 new (145 in total, three runs, all passing). One CLI smoke run with a visible browser and a piped `cancel` passed: exit 1, HANDOFF_CANCELLED, no LLM calls.

### D-052 · Output may not be read from a control's label — **Approved and implemented 2026-11-06.**
- **Found in a manual test:** the discovery goal "Open Edit Profile for member 10042" with `--output profile_status:text` (run `20261106T200818-5f1376`) ended FAILED VERIFICATION_FAILED. The LLM read the "Edit Profile" button's label as the profile status instead of clicking it. The final checks caught it, and the risky click never happened.
- **Fix (lead engineer approved; no change to the discovery, replay or handoff architecture):**
  1. Safety rules: a read step whose element is a control (button, link, text box and the like) is refused, and the LLM is told "its label is not a value". The list of control roles now lives in `safety.ts` and is also used for the existing business-outcome evidence rule.
  2. Discovery final checks: a new check, "output … was read from page text, not a control", as a second guard.
- **Manual test goal corrected:** use `--goal "Open Edit Profile for member 10042 and report the message shown" --input member_id=10042 --output profile_status:text`. Expected result: NEEDS_HUMAN with SAFETY_STOP on the "Edit Profile" click, which is never performed. This is a live LLM run and needs approval.
- Recorded workflows read plain text (for example "Balance"), so replay is unaffected.
- **Tests:** 3 new, 148 in total, all passing in two runs.

### D-053 · Agent-facing capability interface (stretch goal) — **Design approved 2026-11-06; implemented 2026-11-06; approved 2026-11-06.**
- **Goal (PDF §8):** expose saved workflows as callable capabilities an agent can discover and invoke by name with typed arguments, and show one being invoked.
- **Lead engineer decisions:**
  1. `get` includes example requests from `phrases.json`, only when they hold no sensitive data.
  2. REFUSED is a status of this interface only, with exit code 3.
  3. No live LLM agent demo; a real `list` → `get` → `execute` run is enough.
  4. Only reusable versions are listed, described, accepted or run, even when a newer draft exists.
- **Design:** three plain functions in `automation/src/agent/capabilities.ts`: `listCapabilities`, `getCapability`, `executeCapability`. A JSON command line, `npm run capability -- list | get | execute`, wraps them.
  - The JSON result goes to standard output; progress and the handoff prompt go to standard error.
  - Exit codes are those of replay, plus 3 for REFUSED.
- **Reused unchanged:** the workflow store (`versionsOf`, `readStatus`, `loadWorkflow`), input checks (`checkInputs`), `replayWorkflow` (safety rules, logging, redaction, outcomes, handoff) and `terminalChannel` (its output stream is a parameter). Modules 1–5 source is unchanged. The only other change is one npm script.
- **Contract from `get`:** name, version, reusable versions, description, inputs as a JSON Schema object (`additionalProperties: false`), outputs (type and description), the four statuses, business outcome codes and example requests. Page steps, locators, login and provenance are not exposed.
  - **Example filter:** a phrase holding a digit or masked text, or a placeholder that is not a declared input, is left out.
- **Execution:** always with status `reusable` and never a promotion. Arguments must be a JSON object of strings. Unknown or missing arguments are refused by the existing `checkInputs`, so a credential cannot be passed as an argument. Nothing is run and no run folder is made when refused. Discovery is never used as a fallback.
- **MCP:** not built. MCP's usual stdio transport would take over the standard input that the terminal handoff reads, and a replay or handoff can outlast tool-call timeouts. Because the three operations are plain functions, an MCP server would later be a thin adapter; only the handoff channel would need a decision. This goes in REPORT.md as the next step.
- **Tests:** 11 new (159 in total, two runs, all passing); type check clean.

### D-054 · Submission preparation fixes — **Approved scope 2026-11-06 (lead engineer: "freeze the feature scope and prepare for submission"); implemented; approved 2026-11-06.**
- **Goal and input mismatch (discovery):** a goal naming an ID-like number (4 or more digits) that is not one of the `--input` values is refused before the run starts. Found in run `20261106T200537-942d4e`, where the goal named a different member than `--input` and the run reported SUCCESS for the input. The check is in the discovery command line (`cli.ts`), with no architecture change. Replay `--request` takes its inputs from the request itself, and the capability interface has no goal, so neither can disagree.
- **No local absolute paths saved:** `result.json` no longer stores `runDir`; the folder, named by `runId`, is where the file is. The capability interface returns `runDir` relative to the current directory. The evidence copies of older runs had `runDir` removed.
- **Flaky test fixed:** "records an unexpected error as FAILED and closes the browser" counted every headless browser on the machine, so browsers from test files running in parallel made it fail now and then. It now counts only browsers started by its own process. This is a test-only change.
- **Real manual handoff:** run `20261106T223030-649180` met Module 5's last acceptance criterion: a real person took over the live session and automation resumed safely.
- **Deliverables:** README.md (setup, running without live services, demo path, capability interface), REPORT.md (the seven required headings) and `evidence/` (with its own README), checked for secrets, member data and local paths.

### D-055 · Repository cleanup for public submission — **Approved 2026-11-06 (lead engineer).**
- **Removed from Git tracking; local copies kept:**
  - the assignment PDF (interface.ai's document)
  - `PROGRESS.md` and `dailyStatus.md` (working notes)

  All three are listed in `.gitignore`.
- **Deleted:** `user_data.json`, which was identical to `mock-bank/data/members.json` and used by nothing.
- **Kept:** `screenshots/Bank App UI.png`, the design reference the mock bank's layout follows. `styles.css` names it, and README.md shows it.
- **Documentation brought up to date:** module and decision statuses, the request-flow diagram (an unknown request is refused; discovery is started separately), and the final wrap-up.
- **Modules 2 and 5 approved as complete** by the lead engineer on 2026-11-06, based on the test results and the real manual handoff.

### D-056 · Password box shows whether it is filled; blocked steps log their target — **Approved and implemented 2026-11-09.**
- **Found:** a repeated live discovery (run `20261109T130412-71f6aa`) stopped with REPEATED_STEP right after filling the password. The LLM chose to fill the password again.
  - **Root cause:** what the LLM and the repetition check see. A password box rendered as `(value hidden)` whether it was empty or filled, so the page looked unchanged after step 2.
  - The repetition check worked as designed. The earlier run `20261109T130157-70afad` saw the same view and clicked Sign In.
- **Fix:**
  - When the browser layer blanks a password value, it keeps only a yes/no `filled` flag; the value is still deleted at once.
  - The page view shows `textbox "Password" (value hidden) [filled]`, in the style of `[pressed]` and `[disabled]`. The `(value hidden)` text is unchanged, so the recorder's masked-text guard still applies.
  - The `step_blocked` log entry now names what the blocked step would have acted on, redacted like a step entry: the element's role and name, and for a fill only the input or credential name.
- **Unchanged:** the repeated-step rule itself, safety rules, replay, recording and workflows.
- **Tests:** 3 new (163 in total):
  - empty and filled rendering in both views
  - a real browser fill where the password never appears in the page view, the LLM view or the saved view
  - a scripted loop where the LLM sees `[filled]`, and a true repeat still stops with a safe `step_blocked` target
