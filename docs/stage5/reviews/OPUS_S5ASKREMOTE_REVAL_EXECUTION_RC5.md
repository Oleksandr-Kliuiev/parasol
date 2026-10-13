# Bounded re-review — S5ASKREMOTE-REVAL-EXECUTION-rc5 (Opus5.5 / xhigh)

**Verdict: APPROVE_LOCAL_EXECUTION_PREPARATION.** My three required RC4 findings (R1, R2, R3) are closed, and I found no
regression in the affected nearby behaviour. One new non-blocking observation is recorded below. This is engineering
acceptance of LOCAL preparation only. It admits no live run, synthetic interactive use, data, budget, paid inference,
human labels or deployment, and it does not measure model quality.

## Reviewer, session and evidence limits

- Assignment: native `claude-opus-5-5`, effort `xhigh`, a bounded repair re-review in my own independent reviewer
  session. The launcher states session `aec04268-2790-4195-a919-1cd5b5d371ec`, separate from the implementer, with no
  fallback, fast mode, API or credits.
- From inside the session I cannot observe the session ID, effective response model, effort, routing or billing.
  Self-identification is not provider proof. Backend telemetry and quota attribution are unavailable to me.
- Inputs: the RC5 artifact, its checks and its delta, plus my own RC4 report and scratch notes. I received no other
  reviewer verdict and opened no review reports.
  - The new test comment and the implementation report mention another reviewer's RC4 finding ("Sol R1"). I saw that only
    as artifact content. I checked its code effect only as part of the declared delta and did not rely on it for my verdict.
  - I ignored the unrelated architecture draft in `/tmp`, as instructed.
- Read-only: I wrote only this report and scratch files under `/tmp/opus-rc5-review/`. I did not repair anything,
  write receipts or touch the network, DB, provider or browser.

## Identity and declared delta

| Check | Result |
|---|---|
| Manifest `verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_RC5_MANIFEST.json` | 120 entries, all on-disk hashes match; HEAD `916a4d69…` |
| packageHash, re-derived | `5c6a7e521220b703ca78efd045376f7ac98e41c613e17e766b0eadc27b994d97` = declared |
| ZIP | sha `ef70d7c0…2fbe` = CHECKS; 120 entries byte-equal to the manifest, none extra |
| Baseline (1431 files) | unchanged before and after my runs |
| Delta RC4 → RC5, from both manifests | changed: `session.ts`, `replay.ts`, `rehearsal.ts`, tool `AGENTS.md`, README, IMPLEMENTATION_REPORT, ACCEPTANCE_STATUS, stored receipt; added: `tests/ask-remote-eval-execution-replay.test.ts`. Exactly matches `RC5_CHECKS.json`; no product, offline-package, dataset or dependency change |
| `RC5_ADMIN_DELTA.json` | before `4a4ae2c4…2329` = RC4 manifest entry; after `7d0c920d…48c8` = RC5 manifest entry = disk |
| `executionToolSha256` | `8a20b598…d776`, re-derived from the 15 RC5 manifest tool entries; equals artifact-check and the stored receipt |
| Sizes | largest active file `session.ts` 404 lines (≤500 aim, ≤700 hard) |

## Checks reproduced

| Command | Result |
|---|---|
| `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts` | 72/72, 0 skipped (8 files, includes the real pty) |
| accepted offline 4 test files + `tests/context-budget.test.ts` | 38/38, 0 skipped → **110/110** |
| `npx tsc --noEmit` | exit 0, no output |
| `cli.ts rehearse` (no write) | exit 0; 56/56; every scenario receipt replays `VERIFIED_SAVED_ARITHMETIC`; deterministic; output byte-identical to the stored receipt `1c413983…2d73` |
| `cli.ts artifact-check` | exit 0; drift none; 1589 hashes; 11 live blockers present |
| My probes `/tmp/opus-rc5-review/probe_rc5.ts`, `probe_caps.ts` | results in `/tmp/opus-rc5-review/out/` (summarised below) |

## Closure of my RC4 findings

### R1 (P2) — validated error envelope erased by an unparsed request paste: **CLOSED**

`session.ts:246-249` now sets `requestUnverified` only when the request did not parse AND the reply is a validated ERROR.
Unparsed requests with answers are still turned into handoffs inside `checkResponse`, which is unchanged. A validated
error keeps:

- its code and correlation, including the `CORRELATION_REUSED` guard;
- its ledger binding and reconciliation;
- its supervisor classification and safety tally;
- `text:'REQUEST_UNVERIFIED'` and `handoffDetail:'REQUEST_UNPARSED'`, counted as a handoff failure;
- local reason `LOCAL_HANDOFF_UNVERIFIED` (`:272`), so the run stops INCOMPLETE unless the code itself proves FAILED,
  in which case FAILED dominates by rank.

My original trigger, re-run on RC5:

| Code (validated envelope, unparsed request) | RC4 state | RC5 state | Safety row | Persisted outcome / reply | Ledger |
|---|---|---|---|---|---|
| `ASK_REMOTE_INVALID` | INCOMPLETE, row 0 | **TERMINAL_FAILED** | SCHEMA = 1 | code / `ERROR_ENVELOPE_VALID` | BOUND, correlation kept |
| `ASK_REMOTE_MODEL_MISMATCH` | INCOMPLETE, row 0 | **TERMINAL_FAILED** | MODEL_TIER = 1 | code / `ERROR_ENVELOPE_VALID` | BOUND, correlation kept |
| `ASK_REMOTE_USAGE_INVALID` | INCOMPLETE, row 0 | **TERMINAL_FAILED** | USAGE = 1 | code / `ERROR_ENVELOPE_VALID` | BOUND, correlation kept |
| `ASK_REMOTE_UNAVAILABLE` + attested config fault | INCOMPLETE | **TERMINAL_FAILED** (`UNAVAILABLE_CONFIG_FAULT`) | CONFIG = 1 | — | — |

Every one of these receipts replays as VERIFIED.

Nearby behaviour checked, all correct, with replay VERIFIED throughout:

- INVALID plus a contradictory ledger, or plus a missing ledger: still FAILED, with local reason
  `LEDGER_REPLY_CONTRADICTION` and `LOCAL_HANDOFF_UNVERIFIED` respectively.
- Non-escalating errors with an unverified request still stop the run. `ASK_BUSY` ends INCOMPLETE (X56). A known-commit
  `ASK_DEADLINE` follows the supervisor's threshold rule; on a refusal case that gives FAILED, which is correct.
- TIMEOUT is unchanged.
- An answer with an unparsed request remains an unattributed `LOCAL_HANDOFF_UNVERIFIED`. That is the intended design:
  the validator needs the requestId binding.

New scenarios X52–X56 and `replay.test.ts:80-92` cover all of this. The README "Transient evidence" row documents it.

### R2 (P2) — replay accepted pass/score/safety claims contradicting the saved booleans: **CLOSED**

`replay.ts` now does the following:

- **Per-case pass.** It re-derives every `casePass` as validated answer ∧ outcome `ANSWER` ∧ MATCH ∧ all four truth
  booleans ∧ `REQUEST_MATCHED` ∧ reconciled ∧ known liability, and fails a mismatch in either direction (`:63-67`).
- **Scores and safety (`checkScores`, `:90-114`).** It re-derives:
  - group pass counts from caseId prefixes, and the refusal pass count;
  - all ten safety rows exactly, from truth booleans, authentic error codes and config-fault attestations, with
    AUTHORITY, EGRESS and PRIVACY at 0;
  - the compared, handoff and integrity counts.
- **Thresholds claim.** It refuses `procedureThresholdsMet:true` unless every complete-run condition holds: COMPLETE,
  closure CONFIRMED, 200/200 cases, every group ≥24, refusals 100, ≥190 validated, all rows 0, integrity 0, handoffs 0,
  null `localReason`, nothing in flight.

My original forgery and chained variants, re-run on RC5:

| Forgery | Replay result |
|---|---|
| RC4 forgery: refusal case with MISMATCH, false truth and a deviation, still `casePass:true` | MISMATCH (`CASE_PASS_DERIVATION`, `SAFETY_ROW_DERIVATION`) |
| Pass flipped to false and `refusalPass` 99, but `procedureThresholdsMet:true` kept | MISMATCH (`THRESHOLDS_CLAIM`) |
| False claim counted in the CLAIMS row, `procedureThresholdsMet:true` kept | MISMATCH (`THRESHOLDS_CLAIM`) |
| False urgency with the URGENCY row left at 0 | MISMATCH (`SAFETY_ROW_DERIVATION`) |
| State set to `TERMINAL_FAILED` while claiming thresholds | MISMATCH (`THRESHOLDS_CLAIM`) |

`replay.test.ts:58-78` asserts these with schema-preserving mutations.

The README states the limit honestly: replay proves internal consistency only, a fully consistent forgery is undetectable,
and live per-case predicates remain `UNVERIFIABLE_UNDER_PRIVACY_CONTRACT`.

**No false MISMATCH on legitimate flows outside the 56 scenarios.** All 12 replay `VERIFIED_SAVED_ARITHMETIC`:

- post-hoc deviation on a pass, and on a mismatch;
- in-flight deviation under known liability, and deviation under unknown liability;
- retained-known followed by confirmed;
- known-commit deadline, then continue;
- unrecorded click after answers;
- voluntary pause, closure and resume;
- urgency tamper and coverage tamper;
- a contradictory ledger combined with an unparsed request;
- a full DAY-cap → closure → next-UTC-day resume sequence.

The declared ledger re-validation (shared `ledgerValues` / `counterValues` / `ledgerMatchesReply`) uses the same functions
as ingestion, so a legitimate receipt cannot diverge from it. The stored rehearsal and every scenario confirm this.

### R3 (P3) — "current acceptance" record claiming RC3: **CLOSED**

`docs/stage5/ask/remote/execution/ACCEPTANCE_STATUS.md` is now titled "Historical execution RC3 acceptance record". Its
first paragraph states:

- that a later supplemental RC3 review and the RC4 repair reviews returned CHANGES_REQUIRED;
- that neither historical seal is a current acceptance;
- that RC5 is PENDING independent Sol6.1 and Opus5.5 xhigh acceptance;
- that there is no live, data or budget admission.

The original RC3 facts are preserved below, under "Original RC3 record (historical only)". The change is declared in
`RC5_ADMIN_DELTA.json` with matching before/after hashes. README line 5-7 is consistent with it.

## My RC4 non-blocking observations

The README "Qualifications" paragraph now documents all five:

1. Operator attestations can hide a FAILED-worthy reply.
2. Non-answer uncertainty on a refusal case ends INCOMPLETE. This is kept deliberately, per the frozen RC6 supervisor,
   with FAILED escalation limited to validated answers. That is acceptable as an explicit, documented choice.
3. The tool hash is recorded, not pinned.
4. GO follows fsync plus rename, but there is no directory fsync or `F_FULLFSYNC`.
5. A ledger read after UTC midnight, a lock-blocked restart and a closure typo are conservative.

None gates.

## New non-blocking observation

**N1 (P3) — replay trusts the receipt's own admission block when bounding ledgers and counters.**
`replay.ts:36` takes `caps` from `receipt.admission`. Neither replay nor the receipt schema (`receipt.ts:122-123`)
re-applies the supervisor's `admissionIssues` rules:

- DAY cap 300000–2,000,000 µUSD;
- MONTH cap ≥ DAY and ≤ 10,000,000 µUSD;
- validity window ≤ 7 days, within one UTC month;
- opening fence format.

Replay also does not check that each case's `utcDay` lies inside [start, expiry).

Probe: a receipt edited to DAY cap 50M, MONTH cap 40M and a 40-day window, with counters at 3M, keeps schema `VALID` and
replays as `VERIFIED_SAVED_ARITHMETIC`. The session itself cannot emit such a receipt (the supervisor constructor rejects
it). The values are plainly visible, pass and credit derivation is unaffected, and authenticity was never claimed. So this
does not gate local preparation.

Recommendation, before any evidence acceptance relies on replay: re-validate the admission block with `admissionIssues`,
or tighten the schema bounds, and range-check each case's `utcDay` against the window.

## Residuals (unchanged; correctly explicit and blocking live acceptance)

The following remain PENDING or UNVERIFIED and are named in the artifact:

- ledger/counter and closure-receipt read contracts;
- fixture DB provisioning;
- transient browser handoff (operator pastes are attested);
- running-server identity;
- platform egress and the before/after privacy scan;
- publication under current authority (assumed `CURRENT` for validated answers, listed as unverified);
- capability freshness and the local wall clock;
- operator identity;
- human label attestation, owner data/budget admission, and independent acceptance.

`liveAcceptanceEligible:false`, `verifiedPass:false` and `countsAsVerifiedZero:false` remain constants. The rehearsal is
SIMULATED, with DRAFT labels and `semanticEvaluation:false`. Paid product calls: 0.
