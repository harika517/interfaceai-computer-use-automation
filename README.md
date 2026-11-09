# Computer-Use Automation System

An LLM discovers how to do a task in a mock bank's back-office UI. The successful run is recorded as a typed, versioned workflow, and the workflow is replayed with no LLM. A person can take over the same live browser when a run cannot continue safely. Recorded workflows are also exposed to AI agents as callable capabilities.

- **Design write-up:** [`REPORT.md`](REPORT.md)
- **Run evidence:** [`evidence/`](evidence/README.md)
- **Decision log:** [`DECISIONS.md`](DECISIONS.md)
- **Known limitations:** [`REPORT.md` §6 Safety → Limits](REPORT.md#6-safety) and [§7 Cuts](REPORT.md#7-cuts)

## Quick verification

No API key, `.env` or running bank needed:

```bash
npm ci
npx playwright install chromium      # only if Playwright's browser is not installed yet
npm run typecheck
npm test                             # 163 tests; starts its own test banks, uses a scripted stand-in for the LLM
```

## The target application

`mock-bank/` is a local stand-in for a credit-union back-office app:
- employee login
- member search
- a Member Details page with Savings, Checking, Loans, Credit Cards and Edit Profile
- fake data only

It is operated only through its visible UI. Its layout follows this design reference:

![Member Details design reference](screenshots/Bank%20App%20UI.png)

## Setup

Requires Node 22 or later.

```bash
npm install
npx playwright install chromium      # only if Playwright's browser is not installed yet
cp .env.example .env                 # then fill in the values (fake demo values only)
```

`.env` settings:

| Setting | Used by |
|---|---|
| `MOCK_BANK_USERNAME`, `MOCK_BANK_PASSWORD`, `SESSION_SECRET`, `PORT` | the mock bank's own login and session |
| `BANK_URL`, `BANK_LOGIN_USERNAME`, `BANK_LOGIN_PASSWORD` | the automation's login to the bank |
| `OPEN_AI_KEY` | discovery only |

**For the demo, `BANK_LOGIN_USERNAME` / `BANK_LOGIN_PASSWORD` must equal `MOCK_BANK_USERNAME` / `MOCK_BANK_PASSWORD`.** The automation signs in to the mock bank with them; `.env.example` already uses the same fake values for both.

Credentials are never typed into a goal or a command. Every other setting has a default and is explained in `.env.example`.

## Running without live services

- **Tests:** `npm run typecheck` and `npm test` need no API key and no running bank. The tests start their own banks on spare ports and use a scripted stand-in for the LLM.
- **Recording** is fully offline: it reads a finished run folder and needs no bank, browser, LLM or API key.
- **Replay, handoff and capability execution** never call an LLM and need no API key, but they drive the browser, so the local mock bank must be running. (`capability list` and `get` only read files.)
- **Discovery** is the only part that calls OpenAI. It uses the real OpenAI API with your key, which may incur charges.

## Demo path

Start the mock bank in one terminal (http://localhost:4000). Run the rest in a second terminal.

```bash
npm run bank
```

**1. Discover a task with the LLM.** The browser window is visible by default.
```bash
npm run discover -- --goal "Get the savings balance for member 10042" --input member_id=10042 --output savings_balance:currency
```
The last line prints the run folder, e.g. `Run folder: runs/20261030T184107-1c8c20`.

**2. Record the successful run as a new draft version.** This step is offline: no LLM, browser or bank is needed.
```bash
npm run record -- --run runs/<run-folder-from-step-1> --name member.get_savings_balance
```
This writes `capabilities/member.get_savings_balance/<next version>.json` as a draft, for example 1.0.2.

**3. Replay the draft with new inputs and promote it.** No LLM is used; the bank must be running.
```bash
npm run replay -- --workflow member.get_savings_balance --version <version-from-step-2> --input member_id=10048 --promote
```
A successful replay marks the version `reusable` in `status.json`.

**4. Replay the reusable workflow by request, including error and outcome cases.**
```bash
npm run replay -- --request "Get the savings balance for member 10048"     # SUCCESS
npm run replay -- --request "Get the savings balance for member 99999"     # BUSINESS_OUTCOME NOT_FOUND
npm run replay -- --request "Get the savings balance for member 1234"      # BUSINESS_OUTCOME INVALID_INPUT
npm run replay -- --request "Verify the checking account for member 10050" # SUCCESS Active
```
To inject failures, restart the bank with a setting, for example:
- `BANK_NOTICE=on npm run bank`: a popup that replay dismisses
- `BANK_SERVER_ERROR=search npm run bank`: FAILED BANK_ERROR
- `BANK_SLOW_MS=3000 npm run bank`: slow loading
- `BANK_SESSION_TTL_SECONDS=20 npm run bank`: the session expires

**5. Human handoff: a person takes over the live session.**
1. Start the bank with `BANK_NOTICE=on npm run bank`.
2. Run:
   ```bash
   npm run replay -- --workflow member.get_savings_balance --version 1.0.0 --input member_id=10048 --handoff
   ```
3. Version 1.0.0 does not know the popup, so the terminal says **A PERSON IS NOW IN CONTROL OF THE BROWSER**.
4. Click **Acknowledge** in the browser window, then press **Enter** in the terminal.
5. Automation takes control back, re-checks the page, continues, and returns SUCCESS.

Type `cancel` instead to stop the run. `--handoff` also works with `npm run discover`.

**6. Agent-facing capability interface.** See below.

### Exit codes
- **replay, discover:** 0 SUCCESS or BUSINESS_OUTCOME, 1 FAILED, 2 NEEDS_HUMAN, 3 not run (bad arguments, settings or workflow).
- **record:** 0 recorded, 1 refused (for example, the run did not succeed).

### Run folders
Each run writes `runs/<runId>/`:
- `run.jsonl`: the log
- `result.json`: the result
- a redacted page snapshot when a run stops
- `handoff-N.json` for each handoff

Credentials never appear. Member IDs, names and amounts are masked in logs, and only declared outputs appear in `result.json`. `runs/` is not committed; curated copies are in `evidence/`.

## Agent-facing capability interface

AI agents can find and call recorded workflows by name, with typed arguments. Only workflows marked **reusable** are listed, described or run. Drafts are never exposed, even when a newer draft exists. Execution uses the same deterministic replay engine and makes no LLM calls.

The result is one JSON document on standard output. Progress and the handoff prompt go to standard error.

```bash
# 1. List the reusable capabilities
npm run capability -- list

# 2. Get one capability's contract: description, input JSON Schema, outputs,
#    possible outcomes and example requests
npm run capability -- get member.get_savings_balance
npm run capability -- get member.get_savings_balance --version 1.0.0

# 3. Execute it (the bank must be running)
npm run capability -- execute member.get_savings_balance --args '{"member_id":"10048"}'
npm run capability -- execute member.verify_checking_account --args '{"member_id":"10050"}'

# Optional: a specific reusable version, or let a person take over if the run gets stuck
# (needs a visible browser, which is the default)
npm run capability -- execute member.get_savings_balance --version 1.0.1 --args '{"member_id":"10048"}' --handoff
```

`--capabilities <dir>` uses a different capabilities folder.

| Result `status` | Meaning | Exit code |
|---|---|---|
| `SUCCESS` | Outputs returned in `outputs` | 0 |
| `BUSINESS_OUTCOME` | A valid answer such as `NOT_FOUND`, `INVALID_INPUT`, `NO_ACCOUNT` or `PERMISSION_DENIED` | 0 |
| `FAILED` | Stopped with `stopReason` and `failure` (step, expected, observed) | 1 |
| `NEEDS_HUMAN` | A person must decide or help | 2 |
| `REFUSED` | Nothing was run: unknown name, a draft or unknown version, or missing, extra or non-string arguments | 3 |

`list` and `get` return exit code 0, or 3 when refused.

## Test members (fake data)

| Member ID | Situation |
|---|---|
| 10042, 10048, 10050, 10051 | Active savings and checking |
| 10043 | No savings account |
| 10044 | Checking restricted (permission denied) |
| 10045 | No checking account |
| 10046 | Savings restricted (permission denied) |
| 10047 | Checking closed |
| 10049 | Neither account |
| 99999 | Not found |

## Repository layout

| Path | Contents |
|---|---|
| `mock-bank/` | The mock credit-union back office (Express + EJS) and its fault settings |
| `automation/src/` | Browser layer, safety rules, step checkpoint, redaction, discovery (`discover.ts`, `llm/`), recording (`workflow/`), replay (`replay/`), handoff (`control.ts`, `handoff.ts`), capability interface (`agent/`) |
| `automation/test/` | Automated tests (`npm test`) |
| `capabilities/` | Recorded workflows, `status.json` per workflow, `phrases.json` for lookup by request |
| `evidence/` | Real discovery, replay, handoff and capability runs |
| `screenshots/Bank App UI.png` | Design reference for the mock bank's Member Details page |
| `REPORT.md` | Design write-up (the seven required headings) |
| `DECISIONS.md` | Decision log: every design decision with its reasons and trade-offs |
| `ARCHITECTURE_PLAN.md` | Module-by-module description of what was built |
| `REQUIREMENTS.md` | The assignment's requirements as worked from |
