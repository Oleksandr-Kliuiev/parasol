# RS-C implementation brief — part B (instrument revision), rc1 (S5ASKREMOTE-REVAL-SERVER-RSC-B)

Status: written by the implementer (native `claude-opus-5-5`, Claude Code session) on 2026-10-12. Not an approval. Gate (owner's
direct instruction 2026-10-11): ONE independent native Opus 5.5 `max` review in a clean session; bounded re-reviews in that session.
No paid/provider call, activation, account, customer data or deployment. The provider key pass-through stays a PENDING owner
decision; the RS-C-A bridge seams never resolve a key, so every measured case here is `NO_DISPATCH` or uses offline test seams.

## 0. Identity and parents
- Architecture SERVER-DESIGN-rc4 (04 "Pairing and arm", "First-current-GO bookkeeping", "Memory, bounds and time"; 06 "Roles,
  channels and sequences", "Exact transient transfer and acknowledgements"; 05 rows RS-C, First arm, GO integration, Handoff).
- Parent code: RS-C-A rc2 (seal `verification/stage5/S5ASKREMOTE_REVAL_RSCA_APPROVED.json`, package `1825c86d…`), its `carriedToRSCB`.
- The accepted RC5 execution instrument (`scripts/ask-remote-eval-execution/**`) and the offline RC3 package stay byte-unchanged and
  are only IMPORTED. Their own artifact check keeps refusing (enumerated drift since RS-A/RS-C-A); this revision supersedes it.

## 1. Scope
IN: (1) a new instrument revision `scripts/reval-instrument/` (TTY CLI + focused modules) that drives the ACCEPTED RC5
`ExecutionSession` (unchanged) with MEASURED inputs; (2) a chained artifact identity; (3) measured IPC to C (principal I) and S
(handoff) on the owner's measured sockets; (4) the 04 GO procedure (consume → PRE → ARM once → READY → GO permission); (5) the
06 I side of the transfer (validation, SafeResult, PENDING/COMMITTED/UNVERIFIED summaries, ACK); (6) ledger/counters from C
snapshots; (7) terminal-observation collection; (8) receipt v3; (9) carried items N2, TRANSFER≠READY rejection, T2 statement.
OUT: browser pane, sealed console build, 200-path E2E, NB7 target-platform rehearsal and N1 (RS-C-C); PROCESS_CENSUS/DRAIN/POST
census and platform/privacy proofs (RS-D); any product/server change (this part changes no RS-A/B/C-A file).

## 2. Chained artifact identity (`identity.ts`)
- Pinned anchors (sha256 of the file): offline RC3 manifest, R-C RC1 manifest, RS-A rc3 manifest, RS-B rc2 manifest + seal, RS-C-A
  rc2 manifest + seal. Each seal must name its manifest hash. The expected tree is the path→sha256 map built in that order (later
  accepted manifests supersede earlier entries; RS-B/RS-C-A seals' `administrativeDeltasAfterAcceptance` apply their `to` hashes).
- Every expected source path must equal the tree, except the RC5 admin overlays pinned at their exact current hashes (as RC5).
- R-C built outputs: an entry equal to its R-C hash passes; the outputs rebuilt by the enumerated accepted deltas (the RC5 guard's
  `ALLOWED_BUILD_DELTAS`) are RECORDED (digest `rebuiltOutputsSha256`), never pinned; any other built difference is drift.
- The revision's own files are hashed into `instrumentRevisionSha256` (recorded, not pinned, like RC5's `executionToolSha256`).
- The result is an RC5-compatible `Snapshot` (same Identity keys; `executionToolSha256` = RC5 tool ⊕ this revision) so the
  accepted session and v2 receipt builder accept it, plus a `revision` record. Checked at start and before every GO.

## 3. Measured versus attested inputs (feeding the unchanged RC5 session)
| RC5 session input | This revision |
|---|---|
| `admission` values | still owner-entered (ATTESTED) and cross-checked with a C SNAPSHOT: admissionId, caps, expiry, fence ≥ opening fence; mismatch refuses |
| `confirm` tuple / `capability` preflight | browser capability paste as RC5 (ATTESTED) + the PRE snapshot tuple must equal it (ACTIVE) |
| `counters` before submit | the PRE SNAPSHOT's DAY/MONTH `chargedMicroUsd` (CONTROLLER-measured), passed in by the GO step |
| `stage` / `consent` | unchanged RC5 (question paste equality, TTY challenge + checkbox) |
| `submit` (consumption) | first step of GO |
| `arrived` | the TRANSFER receipt instant (server-bound), not a keystroke |
| `outcome` request/reply | the COMMITTED transfer's exact request/response (server-bound; held in memory only until `outcome`) |
| `outcome` ledger | the POST SNAPSHOT: attempts with the case correlation, mapped below; DAY/MONTH charged after |
Ledger mapping (accepted R-B vocabulary): no attempt → `NO_RESERVATION`; SETTLED `USAGE_VERIFIED` → `CONFIRMED` (charged =
accounted); SETTLED `NO_DISPATCH` → `NO_DISPATCH`; `MODEL_MISMATCH`/`USAGE_INVALID`/`UPSTREAM_REJECTED` → `RETAINED_KNOWN`;
`DELIVERY_UNKNOWN` or still `EGRESS_COMMITTED` after the bounded wait → `RETAINED_UNKNOWN_COMMIT`; ≥2 attempts keep their count.

## 4. GO procedure (04; NB9 at I)
GO <caseId> requires: RC5 staged+consented case, the pair id typed from O's PAIR_ACK, live control+handoff connections, no case in
flight and the previous case FINISHED (N2: its handoff COMMITTED or UNVERIFIED-final, its terminal observation FINAL and collected,
and — unless COMMITTED — 125 s past its GO so S's 120 s raw slot is gone). Steps: (a) PRE `SNAPSHOT` (ACTIVE, tuple = confirmed,
fixture = the case's) — a failure here is BEFORE consumption: nothing consumed; (b) `counters(PRE)` + RC5 `submit` = irreversible
consumption + currentGO marker {caseId, pair, tuple, PRE id}; (c) `armIssued:true`, then exactly one ARM_CASE; (d) READY on the
handoff socket; (e) only after ARM_ACK and READY_ACK, within PRE+30 s and before `expiresAt`, print `GO_CLICK_ASK_NOW <caseId>
<seconds left>`. Any failure after (b) → RC5 `abandonInFlight()` (consumed, UNKNOWN commit, TERMINAL_INCOMPLETE, closure pending),
the instrument's arm-phase stop is sticky (no later GO in this process). No retry, re-arm or resend anywhere.

## 5. Transfer, summaries, ACK (06 I side)
At most one TRANSFER per READY. I checks the frame (connection, next S sequence, challenge/readySequence = its READY, binding =
every READY field + its pair/arm/case + handoff connection; a binding that differs from its READY → REJECTED `WRONG_BINDING`), reruns
the accepted RC5 validators (`checkRequest`/`checkResponse`) and derives the exact SafeResult (requestMatchesFrozen, semantic vs the
frozen label, truth booleans, publicOutcome/code). It atomically saves the PENDING `RevalHandoffSummaryV1` (receipt v3) BEFORE the
ACK; a save failure → REJECTED `METADATA_PERSIST_FAILED`. COMMITTED is accepted only on the matching COMMIT frame and saved as
COMMITTED; anything else (timeout, FAILED commit, disconnect) → UNVERIFIED with the fixed code. Raw values never reach persistence.

## 6. Receipt v3 (`receipt.ts`)
`{schema:'reval-instrument-receipt-v3', base:<RC5 v2 receipt, exact and unchanged>, revision, connection, cases:{<caseId>:{go, handoff,
terminal, ledgerSource}}, armStop, provenance}`. `base` keeps every RC5 flag (verifiedPass false, BLOCKED, liveAcceptanceEligible
false): NO flag is upgraded. `provenance` supersedes base.provenance field by field (transient SERVER_BOUND_HANDOFF_COMMITTED /
UNVERIFIED, counters/ledger CONTROLLER_SNAPSHOT, arrival SERVER_TRANSFER_RECEIPT). Exact allowlist + the accepted offline scan;
fsync + atomic rename; written before ACK (PENDING), after COMMIT and after every command (as RC5).

## 7. Required checks
Unit: identity chain (tampered source, overlay, rebuilt output, seal/manifest mismatch), GO state machine (before/after-consumption
failures, N2 gating, window), transfer validation (foreign READY/binding, sequence, malformed), SafeResult derivation, ledger mapping,
receipt v3 allowlist + no raw/secret. Process E2E: the REAL instrument CLI under a live PTY with O (live PTY), C, S (offline scripted
provider) and the browser: one case GO → answer → handoff COMMITTED → outcome recorded → receipt v3; an ARM failure after
consumption (abandoned, stop); an UNVERIFIED handoff. Native chain with the production bridge S. Full suite as RS-C-A.

## 8. rc2 amendment (review `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCB_RC1.md`, CHANGES_REQUIRED F1–F6)
This amendment supersedes the parts of §2, §4 and §6 it names. It is written by the implementer and is NOT an approval.
- **§2 identity (F1, F5).**
  - There is ONE expected map in acceptance order: R-C sources, the R-C built inventory, RC5, RS-A (whose `dist/` pins supersede
    R-C's), RS-B, RS-C-A, then the seals' administrative deltas.
  - Only the outputs of `apps|packages` `.ts` sources changed or added by RS-B/RS-C-A are recorded, by presence and digest. There
    is no enumerated list, and `dist/packages/graph/runtime-role.js` is pinned at RS-A's hash.
  - The recorded digest is folded into `Identity.executionToolSha256`. Both the pre-GO `sameIdentity` check and the RC5 session's
    own pre-submit check therefore refuse an output that changed after start.
  - The RS-A seal is pinned and bound: `DUAL_APPROVED_RS_A`, with its manifest path and `manifestSha256`.
- **§4 GO (F4, F6).**
  - ARM_ACK must echo the case, fixture, admission, PRE, generation and policy.
  - READY_ACK must be ≤4 KiB and come from this registration/boot.
  - The consumption and `armIssued:true` are persisted before the ARM. The arm details are persisted before the GO line.
  - After ARM_ACK, any arm-phase failure sends END_PAIR for the instrument's own pair (best effort, no retry).
  - The previous case's record is re-collected before EVERY PRE. A FINAL record that S already swept counts as collected.
  - `handoff` waits at most 5 s and may answer `HANDOFF_PENDING`. `finish` refuses with `BLOCKED_HANDOFF_PENDING` until the handoff
    has settled or been abandoned.
  - An abandonment keeps the fixed code `RAW_EXPIRED` and is marked `abandonedByOperator`.
  - The POST ledger is derived only from a consistent, foreign-free snapshot of the confirmed admission.
- **§5 (F3).** After a REJECTED ACK, the `COMMIT(FAILED)` that S answers is read inside the same 2 s window. COMMIT is capped at 4 KiB.
- **§6 receipt v3 and credit (F2, F5).**
  - A collected record counts only if its whole Binding answers I's own READY on I's handoff connection, plus the handed-off
    correlation. Otherwise it is not stored and arming stops (`OBSERVATION_INVALID`).
  - Any authenticated non-NONE `detectedFault`, in any revision, stops arming (`TERMINAL_FAULT`) and makes `effective`
    TERMINAL_FAILED (`AUTHENTICATED_TERMINAL_FAULT`) whatever the handoff state.
  - In these cases the RC5 session receives a NO-CREDIT outcome (`replyUnparseable`, i.e. LOCAL_HANDOFF_UNVERIFIED), and
    `cases.<id>.creditBlock` records the reason:
    - no FINAL record (`TERMINAL_NOT_FINAL`);
    - a fault (`TERMINAL_FAULT`);
    - a FINAL publication that contradicts the COMMITTED handoff (`TERMINAL_MISMATCH`, which also stops arming).
  - `effective` is at least TERMINAL_INCOMPLETE (`TERMINAL_OBSERVATION_INVALID_OR_UNCOVERED`) whenever a case has a `creditBlock`
    or a record was refused.
  - The v3 allowlist is exact:
    - `effective.reason` is null exactly when the state equals the base state; otherwise it is the state's one fixed reason and the
      state is strictly stricter;
    - the revision anchors and hashes are typed;
    - `armExpiresAt` is an ISO time;
    - the per-case keys add `armIssued`, `abandonedByOperator` and `creditBlock`.
- **rc3 (rc2 re-review N1–N3).** This supersedes the "NO-CREDIT outcome (`replyUnparseable`)" sentence above for COMMITTED
  handoffs.
  - A COMMITTED handoff ALWAYS gives the RC5 session the exact transferred values, so authenticated truth, safety and code evidence
    is never erased (06 failure precedence).
  - When such a case has a `creditBlock`, an ANSWER loses only its ledger binding: `ledger:null`, recorded as v3
    `ledgerWithheld:true`. That is RC5's accepted unknown-liability path: no pass and no credit, the reserve is retained, and a
    truth failure stays FAILED and tallied.
  - An ERROR never earns credit, so it keeps its measured ledger.
  - `replyUnparseable` remains only for a received but UNVERIFIED transfer.
  - `effective` escalates to TERMINAL_INCOMPLETE only for a refused record or for a `TERMINAL_NOT_FINAL` case still without a FINAL
    record. A fault still escalates to TERMINAL_FAILED.
  - The POST check uses the case's own PRE tuple (N3).
  - An oversized READY_ACK or COMMIT is coded `FRAME_TOO_LARGE`, distinct from the decoder's `PROTOCOL_INVALID`.
