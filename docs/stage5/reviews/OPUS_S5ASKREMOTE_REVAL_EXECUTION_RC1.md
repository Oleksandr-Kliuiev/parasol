# Opus independent acceptance — S5ASKREMOTE-REVAL-EXECUTION-rc1

**Verdict: CHANGES_REQUIRED**

- Artifact: `S5ASKREMOTE-REVAL-EXECUTION-rc1`, packageHash `d23084ec0f7e9cd55823e7a0484b6f9425559e6d27e20ed65829f63260418f77`, HEAD `916a4d6`.
- Reviewer: assigned native `claude-opus-5-5` / `xhigh`. This is a new clean read-only session; its ID `4a5dbfbb-d680-4c38-83b7-cb3f643b6857` matches `…RC1_OPUS_PREFLIGHT.json`.
  - Self-identification is not provider proof.
  - Backend telemetry (effective per-response model, usage, quota attribution) is not observable from inside this session: UNAVAILABLE.
- Isolation:
  - I received no author or implementer history and no other verdict.
  - `/tmp/atlas-reval-execution/sol-rc1-report.md` appeared during the review. I did NOT open it.
- Writes: none to the checkout. This report is the only file I wrote.

Scope: this verdict covers engineering acceptance only. Even an approval would not:
- admit data, budget, human labels or a live run;
- measure model quality.

## Identity and invariance (independently reproduced)

- **Package hash:** recomputing it from the manifest (sorted entries, compact JSON) gives exactly `d23084ec…8f77`.
  - All 110 entries match the working tree and the ZIP.
  - The ZIP has no extra entries.
  - Hashes: manifest `7724b5f1…`, ZIP `9761932a…`, CHECKS `b939c928…` (equals STATUS `checksSha256`).
- **Baseline:** all 1431 entries of `/tmp/atlas-reval-execution/baseline.json` are byte-identical before and after my test runs.
  - `original-baseline.json` differs only on `docs/AI_CONTEXT_MAP.md` and `docs/DEVELOPMENT_WORKFLOW.md`, with exactly the declared ADMIN_DELTA before/after hashes.
  - Diffing against `ADMIN_BEFORE.zip` shows routing-only additions.
- **New paths:** only `scripts/ask-remote-eval-execution/**`, `docs/stage5/ask/remote/execution/**`, three focused tests and `verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_*`.
  - `…EXECUTION_STATUS.json` and `…RC1_SOL_ASSIGNMENT.json` were created by root at 10:34, during this review. They are outside the manifest.
- **`artifact-check`:** exit 0, drift none, 1589 hashes.
  - Pinned offline RC3 `d706a437…`, R-C `9ae0c2b8…` (equals the RC6 accepted R-C identity), dataset `e31aa1c2…`, order `9deaa3c5…`, tool `c6fa8874…`.
- **Admin overlays:** the tool pins six overlay paths, while RC6 names a closed list of two. All six are traceable:
  - the 3 Stage 5 status files appear in `S5ASKREMOTE_RC_CLOSURE_VERIFICATION.json` `administrativeOnlyDeltas` (after-hashes equal the pins);
  - `AGENTS.md` `760214a5…` is in the accepted offline RC3 manifest;
  - the other two are this checkpoint's declared deltas.
- **File sizes:** all new active files are ≤273 lines (hard limit 700, aim 500).

## Checks run (read-only; no write flags)

- Focused suite (CHECKS command: execution ×3, offline corpus/fixtures/supervisor/offline, context-budget): **59/59 pass**.
- `tsc --noEmit` (no incremental/tsbuildinfo): **exit 0**.
- `cli.ts rehearse` (no `--write-receipt`): exit 0, 30/30, `DETERMINISTIC_REHEARSAL_REPLAY_VERIFIED`, scan CLEAN. stdout sha256 `1ea04722…` is byte-identical to the committed receipt.
- In-memory probes using the session/rig and a throwaway pty (no files) for the findings below. Dataset checks printed counts and groups only.
- Not run (justified because there are no product changes): full `npm test`, PG17, browser/Playwright, API build.
  - Actual browser/DB/server behaviour under this procedure therefore remains UNVERIFIED.

## Conforming (verified in code/tests)

- **Startup and submission gates:**
  - Network guard is installed first. There is no live/key/env/network/child/worker path (static test plus reading).
  - Fixed-code `ExecError` with no content echo.
  - Exact receipt allowlist plus the accepted offline scan plus a rationale scan.
  - `liveAcceptanceEligible:false` and `BLOCKED` are schema constants; all safety rows have `countsAsVerifiedZero:false`.
  - Named proof-gap blockers and an `UNVERIFIED` list (including `PUBLICATION_UNDER_CURRENT_AUTHORITY`, `LIVE_PER_CASE_REPLAY`).
  - Live per-case replay is marked `UNVERIFIABLE_UNDER_PRIVACY_CONTRACT`, separate from the deterministic offline replay.
  - Identity is re-hashed at start and before every `submit`; drift → TERMINAL_FAILED.
  - Strict in-memory question equality and requested-focus gate at `stage`. Post-submit request deviation → consumed CASE_FAIL.
  - One-use consent challenge plus checkbox.
  - The accepted supervisor's semantics are reused unchanged: absorbing terminals, consume-first, pacing over preflight+submit, MONTH/expiry/unknown-commit/loss-of-authority/inactive terminal, UNAVAILABLE always stops, INVALID fails, known vs unknown settlement, 24/25, 100/100, ≥190, denominator 200, nearest-rank with n, censored separate.
- **Transient answer validation:**
  - Whole-answer accepted browser V2 validator (requestId, scope, provenance, header correlation) before any boolean.
  - Then the accepted independent comparator against the OBSERVED intent. A grounded wrong intent is a semantic failure only (X14 and a unit test).
- **Evidence handling:**
  - Ledger is bound to the reply correlation and reconciled against pre-submit counters; otherwise UNKNOWN → TERMINAL_INCOMPLETE.
  - The fake V2 is labelled SIMULATED and `operator.ts` never imports it.
  - The 15 cases where `hasFocus` ≠ "focus requested" are requested-but-missing fixtures, and they are handled correctly.

## Required findings

### P2-1 — Stale-fence closure after a voluntary pause is accepted; run resumes and the receipt shows nothing

- **Where:**
  - `scripts/ask-remote-eval-execution/session.ts:230-238`: the voluntary branch raises only wrapper floors (`#raiseFloors`, :240-242). The supervisor's fence/version floor is never raised.
  - On a later supervisor closure, `!wrapperOk` returns `CONFIRMED_SUPERVISOR_ONLY`, but `#sup.close` has already set the supervisor closure to `CONFIRMED`.
  - `resumeDay` (:245-252) and `receipt.ts:65` (`closure: r.closure`) rely on the supervisor's value.
- **Trigger (reproduced):**
  1. Pause voluntarily; close with fence 41.
  2. Reactivate; DAY cap → RESUMABLE_DAY.
  3. Close with `{paused:true, policyVersion:newer, fenceEpoch:41}`, i.e. not strictly newer than the last (voluntary) closure.
  4. Result: `CONFIRMED_SUPERVISOR_ONLY`, supervisor closure `CONFIRMED`, `resume-day` → `RESUMED`, the next case dispatches. The receipt shows `closure: NOT_REQUIRED` with no trace.
  - The same path can report a terminal closure `CONFIRMED` and `procedureThresholdsMet:true`.
- **Impact:** this violates the RC6 rule that each interval closure must be fence-first and strictly newer, and that anything else means CONTAINMENT_UNCONFIRMED with no continuation. It also contradicts `IMPLEMENTATION_REPORT.md:69`, which says closure typos fail closed.
- **Repair:**
  - When `wrapperOk` is false, force supervisor containment (e.g. `this.#sup.close(null)` before or instead of the real receipt), or route the voluntary closure through supervisor floor-raising.
  - Report the wrapper-effective closure in the receipt.
  - Add a scenario: voluntary closure → later stop → stale-fence receipt must give CONTAINMENT_UNCONFIRMED and `resumeDay` must be denied.

### P2-2 — The TTY paste reader corrupts multi-byte UTF-8 split across read chunks, causing false deviations that fail the run

- **Where:** `scripts/ask-remote-eval-execution/operator.ts:46-47`.
  - Each raw `data` Buffer is decoded independently with `chunk.toString('utf8')`.
  - The bracketed-paste marker regex is also applied per chunk.
- **Trigger (measured on this host):**
  - In a pty, a 5040-byte Cyrillic paste arrived as `[1022,1022,1022,1022,8,944]` byte chunks. Per-chunk decoding produced 4 U+FFFD characters.
  - The frozen corpus has 102 non-ASCII questions. At 512, 1022 or 1024-byte chunking, the request-body paste (`outcome`, :116) of one ADVERSARIAL case is corrupted. At 256 bytes, 5 cases are affected, plus one `stage` paste.
- **Impact:**
  - `checkRequest` sees `question !== frozen` → `REQUEST_DEVIATION` → consumed refusal CASE_FAIL → THRESHOLD_UNREACHABLE → TERMINAL_FAILED. This is caused by the tool's own transport, not the server.
  - A corrupted `stage` paste blocks that case permanently, and the fixed order cannot advance.
  - The operator TTY path has no automated test. The implementer's pty smoke used an ASCII marker only.
- **Repair:**
  - Accumulate Buffers and decode once at Ctrl-D with `new TextDecoder('utf-8', {fatal:true})` (or a `StringDecoder`).
  - Strip bracketed-paste markers on the joined text.
  - Add a pty or injected-stream test with multi-byte characters straddling chunk boundaries, for both the question and the request body.

### P2-3 — The procedure tells the operator to click Ask *at the same moment* as `submit`, so the pre-send gates are only advisory

- **Where:**
  - `operator.ts:33`: "press Enter at the moment you click Ask".
  - `docs/stage5/ask/remote/execution/README.md:38`.
  - `session.ts:141-158`: `submit` can return BLOCKED_NO_COUNTERS, NO_CONSENT, NO_PREFLIGHT, PACING or NOT_STAGED; STOPPED (MONTH, DAY, expiry); or INTEGRITY_ARTIFACT_DRIFT, all without consuming the case.
- **Trigger:**
  1. The operator follows the instruction; the tool prints e.g. `BLOCKED_NO_COUNTERS` after the browser request has already been sent.
  2. The operator fixes it and runs `submit` again with another simultaneous click.
  3. Two real server submissions exist for one case. Only the second is recorded as attempt 1. Ledger `attempts` is per correlation, so `≥2` never fires.
  - The same applies to cap, expiry and drift stops: an unrecorded paid submission.
- **Impact:**
  - Defeats the RC6 requirement that the supervisor stops on headroom "БЕЗ отправки следующего case".
  - Breaks consumed-first.
  - An undetectable duplicate paid case gets recorded as the original result.
  - The liability of the first submission is hidden.
- **Repair:**
  - Make `submit` an explicit go/no-go gate: the operator may click Ask only after the tool prints `DISPATCH` (e.g. `GO_CLICK_ASK_NOW`); any other output means do not click. State this in the README, HELP and banner.
  - Add an `unrecorded-click <caseId>` command that consumes the case and stops it as an integrity failure.
  - Latency stays operator-bracketed, as already disclosed.

### P2-4 — Crash, Ctrl-C or quit with a case in flight persists a receipt that hides the consumed case and its UNKNOWN liability

- **Where:**
  - `operator.ts:49`: Ctrl-C calls `process.exit(130)` with no save.
  - `operator.ts:111`: no save after `DISPATCH`.
  - `operator.ts:138`: `quit` saves state `ACTIVE`, closure `NOT_REQUIRED`, and an in-flight case with no record. The warning goes to the terminal only.
  - `receipt.ts:65-67` / schema: no in-flight or abandoned field.
- **Trigger:** `submit` → `DISPATCH`, then Ctrl-C, a crash, or `quit` before `outcome`.
- **Impact:**
  - The only persisted evidence of a paid attempt omits it. After a crash, even `consumed` reflects the previous outcome.
  - State stays non-terminal. This contradicts RC6 "все200 учтены" and "charged/reserved/UNKNOWN не скрыты".
  - README:40 places this on operator memory instead of the evidence.
- **Repair:**
  - Write the receipt immediately after `DISPATCH`, with an allowlisted `inFlight` caseId and liability `UNKNOWN`.
  - On SIGINT, `quit` or a fatal error with a case in flight, record an `ABANDONED_IN_FLIGHT` / UNKNOWN-commit outcome (TERMINAL_INCOMPLETE, closure PENDING) before exiting.

### P3-1 — A dispatched ANSWER can be recorded with zero liability

- **Where:**
  - `session.ts:181-184,188`.
  - `validate.ts:100-101`: `NO_RESERVATION`/`NO_DISPATCH` are accepted for any reply.
- **Trigger (reproduced):** a validated V2 ANSWER with ledger `{attempts:0, NO_RESERVATION, charged 0, counters unchanged}` gives `liability NO_RESERVATION, BOUND/RECONCILED, casePass:true`, and the run continues.
- **Impact:** a remote answer necessarily implies a reservation and a dispatch. An early or mistaken attested read hides a paid liability. This is not the "conservative unknowns" behaviour required.
- **Repair:**
  - For ANSWER, and for error codes that imply an upstream response (INVALID, MODEL_MISMATCH, USAGE_INVALID), require settlement ∈ {CONFIRMED, RETAINED_KNOWN, RETAINED_UNKNOWN_COMMIT} with attempts ≥1. Anything else → UNKNOWN commit.
  - Add a test.

### P3-2 — Local wall-clock gates are not disclosed as unverified, and admission start is not enforced

- **Where:**
  - `operator.ts:89`: `Date.now()` drives the expiry, next-UTC-day and same-month decisions.
  - `receipt.ts:17-21,40-46`: provenance and `UNVERIFIED` cover only the latency clock.
  - `session.ts:142-158` (via `supervisor.ts:188`): only `now ≥ expiry` is checked; `now < start` is never refused.
- **Impact:**
  - The brief requires that local process-clock values be stated as non-production observation. Skew against the server/DB UTC clock is not disclosed.
  - A submission before the admitted window is not blocked by the tool (the server may still refuse).
- **Repair:**
  - Add provenance `utcClock: LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED` and an `UNVERIFIED` entry, and say this in the README and banner.
  - Return `BLOCKED_BEFORE_ADMISSION_START` (unconsumed) when `now < startUtcMs` at preflight and submit.

### P3-3 — A replayed or stale capability paste satisfies the per-submission preflight

- **Where:** `session.ts:93-101`, `transient.ts:94-103`. There is no freshness or uniqueness check on the capability correlation ID.
- **Trigger (reproduced):**
  1. Paste the capability reply captured once.
  2. The server revises the policy version.
  3. Paste the same reply again → `OK`.
- **Impact:** the RC6 "before EVERY submission" capability/version check becomes paste-replayable. The server-side recheck still applies.
- **Repair:**
  - Keep the set of seen correlation IDs (capability, answer and error). Reject a repeat with a fixed code (re-prompt).
  - Optionally clear `preflightOk` after a bounded interval.

### P3-4 — Local handoff or transcription failures are counted as observed SCHEMA safety violations

- **Where:**
  - `transient.ts:76`: `requestId === null`, i.e. the pasted request failed the accepted parser, makes any 200 reply `LOCAL_V2_ANSWER_INVALID`.
  - `transient.ts:83` and `:85-89`: a correlation-header typo has the same effect.
  - `session.ts:189,210`: these become `ASK_REMOTE_INVALID` and a SCHEMA safety hit → TERMINAL_FAILED.
- **Impact:**
  - An operator paste or typo is recorded as an observed zero-tolerance server violation, with reason `ASK_REMOTE_INVALID`. This is misattributed provenance and an irreversible failure.
  - P2-2 makes it more likely.
- **Repair:**
  - Classify validator failures of operator-pasted transients as `LOCAL_HANDOFF_UNVERIFIED`: TERMINAL (incomplete or failed, per owner rule), with evidence "unattributed".
  - Do not increment `violationsObserved`.
  - Never use the public `ASK_REMOTE_INVALID` reason for a local failure.

## Advisory (non-blocking)

- **A1. Threshold and publication labels:**
  - `procedureThresholdsMet` can be `true` in UNADMITTED receipts while AUTHORITY, EGRESS and PRIVACY are unknown.
  - `publication:'CURRENT'` is inferred, not observed (`session.ts:188`).
  - Both are qualified globally, but consider adding a constant `verifiedPass:false` per case and per run.
- **A2. Pacing scope:** pacing counts only events reported to the tool. Browser-initiated capability fetches are not counted; document this.
- **A3. Corpus/identity binding:** `corpus.ts:16-18` loads the corpus before `verifyArtifact()`. Bind the in-memory corpus digest to `Identity` to close the (tiny) TOCTOU window.
- **A4. Overlay citations:** the README should cite the source records of the 4 overlays beyond RC6's two-path list (R-C closure deltas and offline RC3).

## Residual qualifications

- No real V2 server, browser, DB, ledger, closure, fixture-provisioning, egress or privacy behaviour was observed.
- Every live proof gap stays a blocker.
- Labels remain DRAFT_MODEL_ASSISTED with human attestation PENDING. Data and budget are NOT_ADMITTED. Paid calls: 0.

Required: P2-1…P2-4 and P3-1…P3-4. After repair, a new frozen identity, a regenerated rehearsal receipt and updated checks are needed for a bounded re-review.
