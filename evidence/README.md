# Evidence

These are real runs against the local mock bank. Each run folder is copied from `runs/<runId>/`:
- `run.jsonl` is the structured log, one entry per line.
- `result.json` is the result.
- `failure-snapshot.txt` is a redacted page snapshot, saved when a run stops.
- `handoff-N.json` is an intervention request.
- `terminal.txt` is the command typed and what the terminal printed.

| Folder | What it shows | LLM |
|---|---|---|
| `1-artifact/` | The two recorded workflows (version 1.0.1) and their status (`reusable`). These are the saved capability artifacts. | none (recorded deterministically) |
| `2-discovery/savings-20261030T184107-1c8c20` | Real LLM discovery: "Get the savings balance for member …" → SUCCESS, 8 steps, 8 LLM calls (gpt-5.4-mini-2026-03-17), about $0.01. The savings workflow was recorded from this run. | yes |
| `2-discovery/checking-20261101T174514-aae85a` | Real LLM discovery: "Verify the checking account …" → SUCCESS, 9 LLM calls. The checking workflow was recorded from this run. | yes |
| `3-replay/replay-success` | Replay by request: SUCCESS with the balance | 0 calls |
| `3-replay/replay-checking` | Checking workflow: SUCCESS `Active` | 0 calls |
| `3-replay/replay-notice-recovered` | Bank with the System Notice on: the popup is dismissed as a known interruption (`recovered: system_notice ×1`), then SUCCESS | 0 calls |
| `3-replay/replay-not-found` | Member 99999: BUSINESS_OUTCOME NOT_FOUND | 0 calls |
| `3-replay/replay-invalid-input` | Member `1234`: BUSINESS_OUTCOME INVALID_INPUT, no browser opened | 0 calls |
| `3-replay/replay-permission-denied` | Restricted savings account: BUSINESS_OUTCOME PERMISSION_DENIED | 0 calls |
| `3-replay/replay-bank-error` | Injected server error: FAILED BANK_ERROR, with a redacted failure snapshot | 0 calls |
| `3-replay/replay-unknown-dialog-1.0.0` | Version 1.0.0 cannot handle the notice: NEEDS_HUMAN UNEXPECTED_DIALOG | 0 calls |
| `4-handoff/manual-takeover-20261106T223030-649180` | A real person took over (see below) | 0 calls |
| `5-capability/` | Agent-facing interface: `list`, `get`, `execute` (SUCCESS and NOT_FOUND), and a REFUSED call with an extra `password` argument | 0 calls |

## The manual takeover (`4-handoff/`)
The replay was started as `npm run replay -- --workflow member.get_savings_balance --version 1.0.0 --input member_id=10048 --handoff`, with the bank's System Notice on.

In `run.jsonl`:
1. Five automated steps run under control epoch 0.
2. `handoff_requested`, with `handoff-1.json` holding the reason, the step, the expected and observed state, and a redacted page snapshot.
3. `control_changed` to `human`, epoch 1.
4. `human_action`: the person clicked "Acknowledge".
5. `control_changed` back to `automation`, epoch 2.
6. `resumed` at `click_savings_account`, with `click_search` passed over because the page already showed its result.
7. The last two steps run under epoch 2, followed by SUCCESS.

The same `sessionId` appears in the request, the resume and the finish: it is the same live browser session.

## Redaction
These files were checked for:
- the `.env` credentials and API key
- member names and full account numbers
- local absolute paths
- amounts outside the declared outputs

None were found. Logs and snapshots show inputs as `<input:member_id>`, IDs as `***48`, amounts as `$[amount]` and names as `[redacted]`. Amounts appear only as declared outputs, in `result.json` and the terminal result.

Two things the check allows:
- **Member IDs** appear only in the commands typed in `terminal.txt`. They are fake test data from the mock bank.
- **`runDir`**, the local absolute path of the run folder, was removed from the `result.json` copies of runs saved before 2026-11-06. Newer runs no longer save it.
