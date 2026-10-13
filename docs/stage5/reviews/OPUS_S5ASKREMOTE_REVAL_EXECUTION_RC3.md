# Opus bounded re-review — S5ASKREMOTE-REVAL-EXECUTION-rc3

**Verdict: APPROVE_LOCAL_EXECUTION_PREPARATION**

## Scope and identity

- **Artifact:** `S5ASKREMOTE-REVAL-EXECUTION-rc3`, packageHash `c9f84e82fb3be9b00c7f7b7595047e62a376fd630c1c958e2fe31e45c0ba8ca4`, HEAD `916a4d6`.
- **Reviewer:** native `claude-opus-5-5` / `xhigh`, in the same independent session `4a5dbfbb-d680-4c38-83b7-cb3f643b6857`.
  - Self-identification is not provider proof.
  - Backend telemetry is UNAVAILABLE in-session.
- **Independence:** I did not open any `sol-rc*-report.md`.
- **Writes:** none to the checkout, and no regeneration or write flags.
  - The PTY probe used an existing directory without entering an admission, so nothing was written (directory listing hash unchanged).
  - This report is my only file.
- **Approval scope:** engineering acceptance of LOCAL execution preparation only.
  - It does not admit data, budget, human labels, accounts or a live run.
  - It does not measure model quality.

## Identity and invariance (reproduced)

- **Package hash:** recomputes to exactly `c9f84e82…a8ca4`.
  - All 117 manifest entries match the working tree and the ZIP; the ZIP has no extra entries.
  - Manifest `a650a4ed…`, ZIP `0bd22889…`, DELTA `844b76f5…`, CHECKS `80339e9a…`.
- **Delta:** RC3_DELTA (12 changed, 1 added test, 0 removed) exactly equals the RC2→RC3 manifest diff.
  - Changes cover local execution source, docs, receipt and tests only.
- **Prior archives:** RC1 (manifest `7724b5f1…`, ZIP `9761932a…`) and RC2 (`90abee43…`, `8d1fbcfa…`) are unchanged.
- **Baseline:** 1431/1431 files are byte-identical before and after my checks.
- **`artifact-check`:** ok, drift none, 1589 hashes, tool `7df70b16…`, live `BLOCKED`.
- **Context budget:** the largest active file is `session.ts` at 393 lines (hard limit 700).

## Checks run (read-only)

- CHECKS focused command: **78/78 pass, 0 skipped**, exit 0. The real-PTY test actually ran on this host.
- `tsc --noEmit`: **exit 0**.
- `cli.ts rehearse` (no write flag): exit 0. stdout sha256 `bd07eb1d…` is byte-identical to the stored receipt and to CHECKS.
- **Rehearsal scenarios (RC2→RC3):**
  - The only changed expectation is X37. It now reports the earlier `counters:BLOCKED_BEFORE_ADMISSION_START` gate, and the submit-level start block is still asserted.
  - X45–X48 were added.
  - No repair or operator test assertion was weakened; the harness only gained raw-mode tracking.
- In-memory probes of every branch of the R2-1 fix and of the counters gate.
- An independent real-pty probe of the actual CLI.

## Closure of my findings

| Finding | Status | Evidence in actual code |
|---|---|---|
| **R2-1** truth failure masked by contradictory ledger | **CLOSED** | `session.ts` computes MATCH/MISMATCH for a contradicted ANSWER; only the enum persists, the intent stays transient. It then escalates via `#stopLocal('TERMINAL_FAILED', …)` (see probes below). |
| A-1 kernel echo / SIGINT gap | **CLOSED** | `cli.ts` arms raw mode before the dynamic imports and the banner, and fails closed (`TTY_RAW_MODE_UNAVAILABLE`, nothing displayed) if raw mode is unavailable. `operator.ts` keeps raw mode for the whole session and restores the prior mode only at exit, signal or fatal error. Ctrl-C is now a byte read as ABORT and finalized. A SIGINT handler is also registered. Type-ahead is retained (`tty-input.ts` `remainder`). |
| A-2 pre-start counters poisoning the floor | **CLOSED** | `counters()` returns `BLOCKED_<window>` and records nothing outside the admission window. Probe: pre-start entry → `BLOCKED_BEFORE_ADMISSION_START`; at start, lower values → `RECORDED`, state ACTIVE. Scenario X48. |
| RC1 P2-1…P2-4, P3-1…P3-4 | Remain closed | Not affected by this delta except the operator I/O, which was re-verified below. |

R2-1 probe results (all receipts replay `VERIFIED_SAVED_ARITHMETIC`):
- **Truth failure + contradiction:** `TERMINAL_FAILED`, `SAFETY_VIOLATION_UNDER_CONTRADICTORY_LEDGER`, CLAIMS=1.
- **Refusal mismatch + contradiction:** `TERMINAL_FAILED`, `THRESHOLD_UNREACHABLE_UNDER_CONTRADICTORY_LEDGER`.
- **Second supported mismatch in a group + contradiction:** `TERMINAL_FAILED`. The prior-failure count is taken before the supervisor records the current case, so `priorFails + 1 > 1` is correct for the 24/25 rule.
- **First supported mismatch + contradiction:** `TERMINAL_INCOMPLETE`.
- **MATCH + contradiction:** `TERMINAL_INCOMPLETE`, `casePass:false`, no validated-answer credit, liability `RETAINED_UNKNOWN_COMMIT`.

Real-PTY evidence for A-1:
- **The included `tests/ask-remote-eval-execution-pty.test.ts` passed.** It runs the real CLI under `script`, with markers injected during startup verification, as type-ahead and during processing, plus a Ctrl-C byte.
- **My independent pty probe of the actual CLI also passed.** I sent a Cyrillic marker as soon as the banner appeared, then a command plus a type-ahead marker plus a command plus Ctrl-C in one write.
  - No marker was echoed.
  - Both markers were consumed as `UNKNOWN_COMMAND`, and both queued commands ran.
  - The session ended with `SESSION_ENDED_BY_CTRL_C`.
- **Not reproduced by me:** the claim that the PTY test fails on RC2 with `MARKER_ECHOED`. Checking it would require writing extracted RC2 code outside the report path. It is consistent with my own RC2 pty observation that the RC2 cooked-mode window echoes.

## Required findings

None.

## Advisory (non-blocking)

- **Unread input at exit.** Bytes still unread in the kernel queue when the session restores cooked mode at exit go to the parent shell, where they are echoed and may be executed. This only happens if text is typed or pasted after `quit` or Ctrl-C. Optionally drain or discard pending input before restoring.
- **Out of this delta's scope (accepted offline supervisor, unchanged).** In the accepted `scripts/ask-remote-eval/supervisor.ts`, `#thresholdCheck` returns early once the state is no longer ACTIVE. So an unknown-commit outcome on a refusal case (e.g. a timeout) ends the run INCOMPLETE rather than FAILED, although that case is also a certain failure. This is pre-existing accepted behaviour, mentioned for owner awareness only; I did not re-review it here.

## Residuals (unchanged; they block any live claim)

- No real V2 server, browser, DB, ledger read, closure receipt, fixture provisioning, server process identity, egress or privacy proof. All named contracts and blockers remain.
- Operator identity and all typed values are ATTESTED.
- Labels remain DRAFT_MODEL_ASSISTED with human attestation PENDING. Data and budget are NOT_ADMITTED. Paid calls: 0.
- Receipts carry `liveAcceptanceEligible:false`, `liveAdmissionReadiness:BLOCKED` and `verifiedPass:false`. No flag in this version can admit a live run.
