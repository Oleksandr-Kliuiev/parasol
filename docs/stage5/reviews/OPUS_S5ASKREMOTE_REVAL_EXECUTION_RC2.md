# Opus bounded re-review — S5ASKREMOTE-REVAL-EXECUTION-rc2

**Verdict: CHANGES_REQUIRED**

All eight of my RC1 findings are fixed in the actual code. One small regression introduced by the P3-1 repair is required (R2-1).

## Context

- **Artifact:** `S5ASKREMOTE-REVAL-EXECUTION-rc2`, packageHash `9db596d556571e8e705b835eecd7d3daa0973ba16a74984fcf64a048650242f3`, HEAD `916a4d6`.
- **Reviewer:** native `claude-opus-5-5` / `xhigh`, in the same independent session `4a5dbfbb-d680-4c38-83b7-cb3f643b6857`.
  - Self-identification is not provider proof.
  - Backend telemetry is UNAVAILABLE in-session.
- **Independence:**
  - I did not open `sol-rc1-report.md` or `sol-rc2-report.md`.
  - `S5ASKREMOTE_REVAL_EXECUTION_STATUS.json` `history` lists the RC1 verdicts. I saw that historical field incidentally; it did not inform these findings.
- **Writes:**
  - This report is the only file I created.
  - I briefly wrote a test-output log in `/tmp` and deleted it.
  - Nothing was written to the checkout. No write flags or regeneration.
- **Scope:** engineering acceptance only. Even an approval would not admit data, budget, human labels or a live run.

## Identity and invariance (reproduced)

- **Package hash:** recomputed as `9db596d5…42f3`.
  - All 116 manifest entries match the working tree and the ZIP (ZIP `8d1fbcfa…`). The ZIP has no extra entries.
  - Manifest `90abee43…`, CHECKS `bc5b4d86…`, which equals STATUS `checksSha256`.
- **Delta:** `RC2_DELTA.json` (13 changed, 6 added, 0 removed) exactly equals the RC1→RC2 manifest diff.
  - All changes are local execution source, docs, receipt and tests. `validate.ts` and `artifact.ts` are unchanged.
- **RC1 artifacts:** RC1 manifest (`7724b5f1…`) and RC1 ZIP (`9761932a…`) are unchanged.
- **Baseline:** 1431/1431 files are byte-identical before and after my checks.
- **`artifact-check`:** ok, drift none, 1589 hashes, tool `71ca4d20…`, live `BLOCKED`.
- **Context budget:** largest active file is `session.ts` at 373 lines (aim 500, hard limit 700).

## Checks run (read-only)

- CHECKS focused command: **74/74 pass**, exit 0.
- `tsc --noEmit`: **exit 0**.
- `cli.ts rehearse` (no write flag): exit 0.
  - stdout sha256 `104a3095…` is byte-identical to the committed receipt and to CHECKS.
- Rehearsal scenario expectations:
  - X01–X12 and X14–X30 are unchanged from RC1.
  - X13 was intentionally re-expected (P3-4 repair).
  - X31–X44 were added.
- My RC1 probes re-run in memory against RC2 code.
- A real pty test of the new input collector and of the gap between prompts.
- A new probe for a nearby regression (R2-1).

## Closure of my RC1 findings

| RC1 | Status | Evidence in actual code |
|---|---|---|
| **P2-1** stale-fence closure after voluntary pause | **CLOSED** | One `ClosureFloor` (`closure.ts`) for voluntary, DAY and terminal closures: exact 4 keys, signed-64-bit, strictly newer, absorbing containment. On failure, `session.ts:324-328` forces `sup.close(null)`. Re-running my RC1 trigger now gives `CONTAINMENT_UNCONFIRMED` → `RESUME_DENIED_CONTAINMENT`. The receipt `closures` history shows `CONFIRMED:41` then `CONTAINMENT_UNCONFIRMED:41`. Regression scenario X38. |
| **P2-2** UTF-8 chunk corruption | **CLOSED** | `tty-input.ts` accumulates raw bytes until a single-byte terminator (CR/LF or 0x04), then decodes once with fatal UTF-8 and strips bracketed-paste markers from the joined text. Real pty: a 5040-byte Cyrillic paste arrived in 5 chunks and reassembled hash-exact. The test covers 25 RU questions at chunk sizes 1/2/3/1022. |
| **P2-3** click/submit ordering | **CLOSED** | `submit` is a go/no-go gate. `operator.ts:134-138` prints `GO_CLICK_ASK_NOW` only after `save()` persisted the in-flight receipt; every other result prints `DO_NOT_CLICK`. If the save fails, the case is abandoned and later commands are blocked. `unrecorded-click` consumes the case with UNKNOWN liability and a permanent integrity failure. README, banner and help are updated. |
| **P2-4** in-flight evidence lost | **CLOSED** | The receipt is persisted right after DISPATCH with `run.inFlight {caseId, policyVersion, liability:UNKNOWN}`, so even a hard kill leaves the attempt visible. quit, Ctrl-C (raw), SIGTERM, SIGHUP and uncaughtException call `abandonInFlight()`, giving consumed, censored, UNKNOWN, TERMINAL_INCOMPLETE and closure PENDING. Numeric replay checks `consumed = cases + inFlight`. |
| **P3-1** ANSWER with no-dispatch ledger | **CLOSED** (see R2-1) | `book.ts` `ledgerMatchesReply`: an answer needs exactly one attempt and CONFIRMED (≥1 µ$) or retained. My RC1 probe now gives `LEDGER_REPLY_CONTRADICTION`, `RETAINED_UNKNOWN_COMMIT`, `casePass:false`, TERMINAL_INCOMPLETE. |
| **P3-2** wall clock / start window | **CLOSED** | `#window` enforces start ≤ now < expiry in the admitted month at preflight, submit and resume. Provenance `utcClock: LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED`; `UNVERIFIED` gains `LOCAL_WALL_CLOCK_VS_SERVER_UTC`, `CAPABILITY_FRESHNESS…` and `BROWSER_FETCHES_OUTSIDE_REPORTED_PACING`. Disclosed in the banner. |
| **P3-3** capability replay | **CLOSED** | Session-wide set of seen correlation IDs across capability and replies → `CORRELATION_REUSED` (fixed code, no state change). Re-running my probe throws `CORRELATION_REUSED`. Disclosed as `UNSEEN_IN_SESSION_ONLY_NOT_SERVER_BOUND`. |
| **P3-4** handoff misattributed as SCHEMA | **CLOSED** | `LOCAL_HANDOFF_UNVERIFIED` with a fixed `handoffDetail`, counted separately (`unattributedHandoffFailures`), TERMINAL_INCOMPLETE. It never hits the SCHEMA row or `ASK_REMOTE_INVALID`. An authentic validated `ASK_REMOTE_INVALID` still fails (X09). |
| A1/A3 advisories | Addressed | `verifiedPass:false` constants at run, case and receipt level. The corpus is parsed from the same cached bytes that are hashed; the accepted loaders accept the injected reader. |

Other nearby invariants hold:
- Liability floors (DAY resets at the UTC boundary; MONTH never resets).
- Counters must come from the same UTC day as the submission.
- `thresholdsMet` requires: no local stop, closure CONFIRMED, no unrecorded click, no handoff failure.
- `replay --receipt` is read-only, schema-checks before replaying, and prints fixed codes.
- Static guard and import boundaries are unchanged.

## Required finding (new, introduced by the P3-1 repair)

### R2-1 (P3) — A truth-failing answer with a contradictory ledger is downgraded from TERMINAL_FAILED to TERMINAL_INCOMPLETE

- **Where:** `scripts/ask-remote-eval-execution/session.ts:257`.
  - When `observed.kind === 'ANSWER' && contradiction`, the validated answer reaches the supervisor as `{kind:'ERROR', code:'LEDGER_REPLY_CONTRADICTION'}`.
  - The supervisor therefore never sees `truthPass:false`, and records UNCLASSIFIED_ERROR, which is INCOMPLETE.
- **Trigger (reproduced):**
  - Setup: a SUMMARY case, an answer with an altered observation summary (the comparator flags CLAIMS), and an attested `NO_RESERVATION` ledger for the same correlation.
  - Result: `state TERMINAL_INCOMPLETE`, `reason UNCLASSIFIED_ERROR`, `localReason LEDGER_REPLY_CONTRADICTION`.
  - The same answer with a consistent ledger gives `TERMINAL_FAILED / SAFETY_VIOLATION`.
  - In both runs the receipt shows `truth.claims:false` and the CLAIMS row `violationsObserved:1`.
- **Impact:**
  - This breaks the RC6 rule that a safety violation means TERMINAL_FAILED, which an owner correction cannot cure.
  - It is internally inconsistent: X44 keeps an authentic MODEL_MISMATCH with a contradictory ledger at TERMINAL_FAILED. Only ANSWER truth failures are masked.
  - The same path downgrades a refusal semantic mismatch, which would otherwise be THRESHOLD_UNREACHABLE (FAILED), to INCOMPLETE.
  - The evidence row survives, so nothing is hidden. But the run state and reason misreport a safety failure as an incomplete run.
- **Repair:**
  - For a contradicted ANSWER, still apply the answer's validated truth and semantic result. Either:
    - pass `{kind:'ANSWER', truthPass, publication:'CURRENT', settlement:'RETAINED_UNKNOWN_COMMIT'}` and force the case to fail; or
    - when `!observed.truth.pass`, additionally escalate the local state to TERMINAL_FAILED.
  - Add a scenario: tampered answer plus contradictory ledger must give TERMINAL_FAILED with CLAIMS=1.

## Advisory (non-blocking)

- **A-1. Cooked-mode window between prompts.** Raw mode is turned off between prompts (`operator.ts:65`).
  - In a pty I confirmed the kernel echoes bytes that arrive in that window. Measured windows: about 50–60 ms during the `submit` artifact re-hash, plus each fsync'd save.
  - There is no `SIGINT` handler, so a Ctrl-C landing in that window skips finalization. The persisted `inFlight` record still keeps the evidence.
  - Suggest keeping raw mode on for the whole session (and/or handling SIGINT), and qualifying "ALL input is echo-off" in the README.
- **A-2. Counters before admission start.** `counters` is not gated by the admission window. Counters entered before start in the previous UTC month later trip `MONTH_BUCKET_CHANGED`, which is terminal. This fails closed, but a `#window` gate would avoid a spurious stop.

## Residuals (unchanged)

- No real V2 server, browser, DB, ledger, closure, fixture provisioning, egress or privacy proof. All named blockers remain.
- Labels remain DRAFT_MODEL_ASSISTED with human attestation PENDING. Data and budget are NOT_ADMITTED. Paid calls: 0.
- Receipts carry `liveAcceptanceEligible:false`, `BLOCKED` and `verifiedPass:false`.

After R2-1 is repaired, a new frozen identity, regenerated rehearsal and updated checks are needed for a bounded re-check.
