# Requirements: Computer-Use Automation System

**Source:** *Assignment A — Computer-Use Automation System.pdf* (interface.ai Engineering Team)
**Status:** v0.1 (2026-10-13), used as the requirements baseline for the whole build. The open questions in §12 were settled by our own decisions, listed at the end of §12.
**Date:** 2026-10-13

> This document only describes **what** the system must do. Implementation choices, scope cuts, and test plans are left out on purpose and will be covered after this document is reviewed.

---

## 1. Business Context

| # | Context item | Source |
|---|---|---|
| C-1 | The customer builds AI agents for **US banks and credit unions**. This system is the **backend integration layer** that lets those agents operate an institution's back-office applications. | §1 |
| C-2 | The system targets applications that have **no API**, such as core banking screens, servicing tools, and admin consoles. If an app has an API, the API is used instead, and that path is not covered here. | §1 |
| C-3 | **Core principle:** *The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.* | §2 |
| C-4 | The agent-facing product decides **what** to do. This system decides **how** to do it reliably and safely. | §1 |

### 1.1 Environment Characteristics (constraints that shape all requirements)

| # | Characteristic | Implication for requirements |
|---|---|---|
| E-1 | **The UIs are stable, but runtime errors happen.** Apps change slowly, so recording once and replaying many times is viable. | Replay must handle validation errors, record-not-found, permission denial, unexpected dialogs, session/timeout expiry, transient slowness, and app errors. Handling only the happy path is not enough. |
| E-2 | **The surfaces are mixed and often legacy:** modern web, legacy web (server-rendered, framesets, nested tables, non-semantic markup, no test IDs), and native desktop apps. | The system cannot assume a clean DOM, stable selectors, or an API. Often the only reliable surface is what a human operator sees and does. |
| E-3 | **Many tenants at scale:** hundreds of institutions with about 20 apps each, so thousands of app instances. Many tenants run the **same vendor product** with different configuration, branding, and version. | Automation built for one tenant should generalize to others, or degrade gracefully, without being rebuilt per tenant. |
| E-4 | **The data is regulated financial data.** | Sensitive data must not leak or be persisted. |

---

## 2. Actors

| Actor | Description |
|---|---|
| **AI Agent (caller)** | The upstream agent product. It sends goals for discovery and invokes saved capabilities, with typed inputs, during production replay. |
| **LLM (discovery model)** | Drives the live surface during discovery. It must not be in the decision loop during replay. |
| **Human Operator** | Receives intervention requests, takes control of the live session, performs manual steps, and hands control back. |
| **Human Reviewer** | Reads and understands saved artifacts: what each one does, what it needs, and what it returns. |
| **Target Application** | The UI surface being automated. Here it is a proxy or stand-in, never a real bank system. |

---

## 3. Functional Requirements

### FR-1 Goal-Driven Agent Loop (Discovery) — *§2.1–2.2, §3.1*

| ID | Requirement |
|---|---|
| FR-1.1 | The system shall accept a **natural-language goal** as input. Examples: "look up member 12345 and read their current savings balance", "open a new sub-account and reach the confirmation screen", or "add item to cart and reach checkout review". |
| FR-1.2 | The system shall accept a **target** as input: an app, URL, or entry point. |
| FR-1.3 | The system shall run an **LLM-driven observe → decide → act loop** against a **live** surface. |
| FR-1.4 | The loop shall continue until the **goal is met** or a **stopping condition** is hit. At minimum, the stopping conditions are **max steps**, **timeout**, and **dead-end**. |
| FR-1.5 | The agent shall **actually interact with a real UI**: click, type, navigate, and read state. |
| FR-1.6 | The perception and action mechanism should **favor approaches that still work when there is no clean DOM**, such as an accessibility tree, screenshot plus coordinates, or OS-level automation. A browser is only one case of the general computer-use problem. |
| FR-1.7 | At least **one genuine LLM-driven discovery run against a live surface** is mandatory. A described or simulated run does not satisfy this requirement. *(§4: "not your call")* |

### FR-2 Structured Capability Artifact — *§2.3, §3.2*

| ID | Requirement |
|---|---|
| FR-2.1 | After a **successful** discovery run, the system shall emit a **typed, serializable artifact** that captures the reusable flow. |
| FR-2.2 | The artifact shall be **decoupled from the raw model transcript**. |
| FR-2.3 | The artifact shall work as an **agent-invocable capability** with a clear **contract**, not just a list of steps. |
| FR-2.4 | The artifact shall express the **ordered steps / actions**. |
| FR-2.5 | The artifact shall express **how each target element or control is identified**, along with the **reasoning about robustness** for that identification. |
| FR-2.6 | The artifact shall declare **typed input parameters**, meaning the values the caller supplies per invocation (for example, a member ID). |
| FR-2.7 | The artifact shall declare **typed outputs / data to extract** and their **shape**, meaning what the caller gets back. |
| FR-2.8 | The artifact shall define a **checkpoint and/or success condition**. |
| FR-2.9 | The artifact shall be **versioned**. |
| FR-2.10 | The artifact shall be **reviewable**. Both a human reviewer and a calling agent must be able to understand what the capability does, what it needs, and what it returns. |
| FR-2.11 | The artifact schema shall be **designed deliberately**. It is a focal point of the evaluation. |

### FR-3 Deterministic Replay (Production Execution Path) — *§2.4, §3.3*

| ID | Requirement |
|---|---|
| FR-3.1 | Given a **saved artifact** and a **set of input parameters**, the system shall replay the flow. |
| FR-3.2 | Replay shall **not invoke the LLM for decisions**. |
| FR-3.3 | Replay shall use **stable element/control targeting**. |
| FR-3.4 | Replay shall **verify the checkpoint/success condition** and must not assume that actions succeeded. |
| FR-3.5 | Replay shall **return the declared outputs** to the caller. |
| FR-3.6 | Replay shall **detect** these runtime and exceptional states and respond deliberately instead of proceeding blindly: validation error, record not found, permission denial, unexpected dialog, session timeout, and slow or failed load. |
| FR-3.7 | UI drift is a **secondary** concern. The main focus is runtime conditions. |

#### FR-3A Result Contract & Outcome Taxonomy — *§3.3*

| ID | Requirement |
|---|---|
| FR-3A.1 | The result contract shall clearly separate three classes of outcome. |
| FR-3A.2 | **Expected business outcomes** are legitimate results the caller needs to know about, such as "no such member". They shall **not** be reported as crashes or failures. |
| FR-3A.3 | **Recoverable conditions** are handled inside replay, for example by dismissing a known interstitial or by waiting and retrying a transient load. |
| FR-3A.4 | **Hard failures** shall stop execution and surface a clear, debuggable error. |
| FR-3A.5 | Every replay shall return a **structured result** in one of these forms: **success** with outputs, a **known business outcome**, or a **failure** with debug detail. |
| FR-3A.6 | A failure result shall include, at minimum, **which step** failed, **what was expected**, and **what was observed**. |

### FR-4 Safety & Policy Guardrails — *§2.6, §3.4*

| ID | Requirement |
|---|---|
| FR-4.1 | The system shall enforce an **explicit, configurable allowlist** that covers at least permitted **domains/routes** and permitted **action types**. |
| FR-4.2 | The agent **must not act outside the allowlist**. This applies to both discovery and replay. |
| FR-4.3 | The system shall classify actions as **safe/reversible** or **risky/irreversible**. |
| FR-4.4 | Risky or irreversible actions shall be handled **conservatively** by blocking them, requiring confirmation, or flagging them. The chosen approach must be **justified**. |
| FR-4.5 | **Secrets and raw sensitive data** (credentials, tokens, full PII) shall **never be persisted** into artifacts or logs. |
| FR-4.6 | Sensitive data shall be **redacted** wherever it would otherwise appear. |
| FR-4.7 | Guardrails shall apply **throughout** every phase, including discovery, replay, and human handoff. |

### FR-5 Evidence & Observability — *§3.5*

| ID | Requirement |
|---|---|
| FR-5.1 | Every run shall produce a **structured log** of what the agent did **and why**. |
| FR-5.2 | On failure, the system shall capture **at least one richer signal**, such as a screenshot, DOM snapshot, or trace. |
| FR-5.3 | Evidence shall be good enough to **understand and debug** a run. |
| FR-5.4 | Evidence shall follow the redaction rules in FR-4.5 and FR-4.6. |

### FR-6 Human-in-the-Loop Escalation & Handoff — *§2.5, §3.6*

| ID | Requirement |
|---|---|
| FR-6.1 | **Detect:** the system shall identify stuck or blocked states in three situations: (a) the agent is stuck during discovery, (b) replay hits an unrecoverable condition, and (c) a risky or irreversible step needs a human decision. |
| FR-6.2 | **Route:** the system shall raise an **intervention request** to a human operator. |
| FR-6.3 | The intervention request shall carry this context: **which capability or goal**, the **current step**, the **current state or screenshot**, and **why it stopped**. |
| FR-6.4 | **Take control:** the human shall operate the **same live session** the automation was using, **not a fresh one**. |
| FR-6.5 | The human shall be able to perform manual steps in that session. |
| FR-6.6 | **Hand back:** the human shall be able to **hand control back** so the run can **resume or complete**. |
| FR-6.7 | **Context and evidence shall be preserved** across the handoff. |
| FR-6.8 | **The human's actions shall be recorded.** |
| FR-6.9 | The automation shall support **pause, cede control, and resume** on the same session. |
| FR-6.10 | There shall be a clear way to know **who is in control, or who should be**, at any moment. |
| FR-6.11 | The handoff mechanism and the control-transfer model must be **real and well-reasoned**. The operator UI itself may be minimal or mocked. |

### FR-7 Heterogeneity & Multi-Tenant Design — *§3.7*

*These are design requirements. The design must exist, and the core abstractions must not paint the system into a corner. Building them is not required.*

| ID | Requirement |
|---|---|
| FR-7.1 | **Surface abstraction:** the design shall explain how the artifact schema and replay engine extend from the chosen surface to a **legacy web app** and/or a **desktop app**. |
| FR-7.2 | The design shall define the **seam between "how we perceive/act on a surface" and "the recorded flow"**. |
| FR-7.3 | **Multi-tenant reuse:** the design shall describe how an artifact is represented so it can be **reused across tenants** running the same vendor app, or **safely specialized/overridden** per tenant, without re-recording it for each tenant. |
| FR-7.4 | **Drift management:** the design shall explain how **per-tenant and per-version drift** is detected and managed. |

---

## 4. Non-Functional Requirements

| ID | Category | Requirement | Source |
|---|---|---|---|
| NFR-1 | Determinism | Same inputs produce the same steps and the same outputs on replay. | §3.3, Glossary |
| NFR-2 | Reliability | Capabilities must handle the runtime exceptions listed in E-1. Happy-path-only is not acceptable. | §1 |
| NFR-3 | Cost | Replay must be **cheap**, with no per-invocation LLM reasoning. | §1 |
| NFR-4 | Surface-agnosticism | Core abstractions must not assume a clean DOM, stable selectors, or test IDs. | §1, §3.1 |
| NFR-5 | Security / compliance | Regulated financial data must be protected: no leakage, no persistence of secrets or full PII. | §2.6, §3.4 |
| NFR-6 | Simplicity | A small, correct, well-argued system is preferred. Building scaling infrastructure early (queues, clusters, multi-tenant plumbing) is **not** rewarded. | §7 |
| NFR-7 | Code quality | The code must be readable, reasonably typed, tested where it counts, and easy to run. | §7 |
| NFR-8 | Explainability | Every design decision must be defensible. Where the brief is silent, the team **makes a decision and explains why**. | §1, §5, §9 |
| NFR-9 | Ethics / ToS | No real bank systems, real credentials, or real PII. If a public target is used, its terms and rate limits must be respected. | §4, §9 |
| NFR-10 | Secrets hygiene | Secrets must stay out of the repository. | §9 |

---

## 5. End-to-End Flow Requirement (Vertical Slice) — *§5*

The system must show one continuous working thread that touches **every** functional area above:

```
NL goal
  → LLM-driven discovery run that completes the goal       (FR-1)
  → saved capability artifact                               (FR-2)
  → deterministic replay with input params, outputs,
    and error/outcome handling                              (FR-3, FR-3A)
  → human-escalation path that takes over the live session  (FR-6)
  → evidence for both runs                                  (FR-5)
  [guardrails enforced throughout]                          (FR-4)
```

A thin version of **every** capability is required. A polished subset of capabilities does not meet this requirement.

---

## 6. Proxy Target Application Requirements — *§4*

| ID | Requirement |
|---|---|
| T-1 | The target is a **stand-in** for a real bank back-office app. A real bank system must not be accessed or obtained. |
| T-2 | The target must support a **non-trivial multi-step flow**, such as search → detail → action, or a multi-field form with a confirmation step. |
| T-3 | The target must make it possible to exercise the interesting problems: runtime errors, business outcomes like not-found, and risky actions. |
| T-4 | Acceptable options include a public demo or sandbox site, a local sample or mock app, an intentionally hostile legacy-style surface (iframes, framesets, table layouts, no test IDs), or a simple desktop app. |

---

## 7. Deliverable Requirements — *§6, §11*

These deliverables must use the **exact paths and headings** below.

| ID | Deliverable | Required content |
|---|---|---|
| D-1 | **Public GitHub repository** | All source code |
| D-2 | **`/README.md`** | (a) How to set up and run, including the keys and config needed and how to run **without live services** if applicable. (b) A **demo path** with the exact commands to run the agent on a goal and then **replay** the resulting artifact. |
| D-3 | **`/REPORT.md`** (about 1–3 pages) | Exactly these 7 headings: **1. Architecture**, **2. Artifact schema**, **3. Determinism & error handling**, **4. Heterogeneity & multi-tenant**, **5. Escalation & handoff**, **6. Safety**, **7. Cuts** |
| D-4 | **`/evidence/`** | A saved **example artifact**, plus logs from a **discovery run** and a **replay run** |
| D-5 | `/evidence/` (strongly desired) | At least one **replay that hits an error or exceptional state**, such as bad input, a not-found result, or an injected failure, showing how it is detected and reported |
| D-6 | `/evidence/` (optional) | A short screen recording |
| D-7 | Documentation of stubs | Anything mocked or stubbed (operator UI, desktop surface, and so on) must be **documented: what was mocked and why** |
| D-8 | Submission | Email the repo URL **on its own line** to assignments@interface.ai **from the applying address**. **No zip files.** |

---

## 8. Decisions Delegated to Us (must be made and defended) — *§4*

The customer has deliberately left these open. Each one needs a decision and a written justification:

1. Language, runtime, and frameworks
2. LLM provider and model, prompting approach, and agent-loop structure
3. Computer-use technology (Playwright, Puppeteer, Selenium, CUA/agent SDK, screenshots, accessibility APIs, OS automation)
4. Proxy target application
5. Artifact schema and its storage/serialization format
6. How determinism is achieved: locator strategy, fallbacks, waiting
7. Architecture and boundaries: single process vs. services, sync vs. queued
8. How risky or irreversible actions are treated: block, confirm, or flag (FR-4.4)
9. Which richer failure signal to capture (FR-5.2)

---

## 9. Optional Requirements (Stretch) — *§8*

These apply only once the core is solid, and at most one or two should be picked.

| ID | Optional requirement |
|---|---|
| OPT-1 | **Agent-facing capability interface:** a catalog of callable capabilities, discoverable and invocable by name with typed args, shown being invoked |
| OPT-2 | **Code generation:** emit a runnable test or automation snippet, such as a page object or test file, from an artifact |
| OPT-3 | **Confidence & approval:** a replay reliability score, with unattended replay gated on an approval state (draft → approved) |
| OPT-4 | **Assisted fallback:** a bounded, policy-checked LLM recovery for a single step on replay failure, never open-ended, recorded as evidence |
| OPT-5 | **Canonicalization / cross-tenant reuse:** parameterize routes and values (`/item/12345 → /item/:id`) and/or apply a base artifact to a variant app with per-variant overrides |
| OPT-6 | **Multi-run stability:** replay N times and report a flakiness signal |

---

## 10. Customer Evaluation Priorities — *§7 (ordered by weight)*

1. **System design:** boundaries, data models, trade-offs, simplicity. *The artifact schema and replay contract are central.*
2. **Correctness of the core loop:** the agent completes a real goal, and the artifact replays deterministically and verifies success.
3. **Robustness & error handling:** runtime error detection; separation of business outcomes, recoverable conditions, and hard failures; locator, wait, and checkpoint strategy.
4. **Human-in-the-loop escalation:** real detection, routing with context, live-session transfer, and resume.
5. **Generalization:** a credible story for mixed surfaces and cross-tenant reuse.
6. **Safety & data handling:** allowlist, risky actions, redaction.
7. **Code quality**
8. **Communication:** reasoning, trade-offs, and cut lines are clear.

**What is not rewarded:** feature breadth, framework name-dropping, and building scaling infrastructure early.

**Load-bearing areas where depth is expected:** the artifact schema, deterministic replay plus error handling, and the safety/escalation model.

---

## 11. Glossary (customer-defined terms)

| Term | Definition |
|---|---|
| Computer use | An LLM operating a UI the way a person would (read the screen, click, type) instead of calling an API |
| DOM | The browser's structured page representation. Legacy apps often lack a "clean" DOM. |
| Accessibility tree | The representation exposed for screen readers. It is often more stable than raw markup and is available on desktop too. |
| Locator / selector | How automation identifies which control to act on |
| Test ID | An attribute added specifically for automation. Legacy apps essentially never have them. |
| Deterministic replay | Re-running a flow identically with no model decisions: same inputs, same steps, same outputs |
| Checkpoint | An asserted condition that confirms the expected state was actually reached |
| Business outcome vs. failure | "No such member" is a legitimate answer, not a crash. Mixing these up is the most common design mistake. |
| Tenant | One customer institution |

---

## 12. Open Questions for the Customer

1. **Risky-action policy:** is there a preferred default (block, confirm, or flag) for irreversible actions, or is a justified choice from us enough?
2. **Sensitive data in outputs:** if a capability's declared output is itself sensitive (for example, a balance or account number), should it be returned unredacted to the caller and redacted only in logs and artifacts? What counts as "full PII" versus acceptable partial data, such as the last 4 digits?
3. **Credentials during replay:** how should login credentials reach a replay, as invocation inputs or as an external secret reference? Is authentication part of each capability or a separate pre-condition?
4. **Operator notification channel:** for intervention requests, is any routing channel acceptable (console, webhook, file/queue), or is there a preferred one?
5. **Handoff timeout:** if no human responds to an intervention request, what should happen: wait indefinitely, time out to a hard failure, or something else?
6. **Discovery failure artifacts:** should a discovery run that only partly succeeds, or that succeeds after human intervention, still produce an artifact? Should the human's recorded steps be merged into it?
7. **Artifact versioning semantics:** does "versioned" mean schema version, capability version, or both? Is there an expected lifecycle (draft → approved)?
8. **Evidence retention:** are there constraints on how long screenshots and logs (even redacted ones) may be kept?

### Answers adopted (no customer answer was available; decisions in `DECISIONS.md`)
1. **Risky actions:** blocked unless a person approves. A risky step stops with NEEDS_HUMAN and is never automated; with `--handoff`, a person decides in the browser (D-017, D-040, D-051).
2. **Sensitive outputs:** declared outputs are returned to the caller and saved in `result.json` only. They are masked everywhere else: logs, snapshots, and what the LLM sees in later turns (D-039).
3. **Credentials:** they come from settings (`BANK_LOGIN_*`) and are never invocation inputs. Login is part of each workflow's `login` steps, which may only refer to credentials by name (D-040, D-044).
4. **Operator channel:** the terminal (`HumanChannel` is the seam for a console or webhook later) (D-050).
5. **Handoff timeout:** 600 s by default, then NEEDS_HUMAN HANDOFF_TIMEOUT. Cancel gives FAILED (D-050).
6. **Partial or assisted discovery:** only a SUCCESS run with every final check passed can be recorded. A run with a human handoff is refused, and the person's actions are evidence, not steps (D-044, D-051).
7. **Versioning:** both. `schemaVersion` for the format, and a semantic version per workflow, with a draft → reusable lifecycle (D-013, D-044, D-047).
8. **Evidence retention:** not addressed. Run folders are local and not committed; curated, redacted copies are in `evidence/`.
