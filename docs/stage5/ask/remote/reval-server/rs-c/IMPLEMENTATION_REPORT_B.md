# RS-C implementation report — part B (instrument revision), rc3 (S5ASKREMOTE-REVAL-SERVER-RSC-B)

rc2 repairs the rc1 review (`docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCB_RC1.md`, CHANGES_REQUIRED F1–F6). rc3 repairs the
rc2 re-review's N1–N3 (same file, rc2 section). See §0 and brief §8. Artifacts:
`verification/stage5/S5ASKREMOTE_REVAL_RSCB_RC3_{MANIFEST,CHECKS}.json`. The rc1 text below is kept, and it is corrected where
§0 says so.

## 0. rc2 closure
| Finding | Repair | Proof |
|---|---|---|
| F1 P2 build identity | One ordered expected map: the R-C built inventory comes before RS-A, whose `dist/` pins supersede it. Only the outputs of RS-B/RS-C-A-changed `apps\|packages` sources are recorded (no enumerated list), so `runtime-role.js` is pinned at RS-A's hash. The recorded digest is folded into `executionToolSha256`, so the pre-GO check and the RC5 pre-submit `sameIdentity` both refuse a change after start | identity test: `runtime-role.js` and `channel.js` tamper → BUILD_DRIFT; a rebuilt output changes the identity (`sameIdentity` false); mutation M6 detected |
| F2 P2 faults/coverage | `terminal.ts` + `run.ts#accept`: any non-NONE fault in any revision → sticky `TERMINAL_FAULT`, NO-CREDIT outcome and `effective` TERMINAL_FAILED. A case without a FINAL record or with a contradicting publication → NO-CREDIT (`creditBlock`) and `effective` ≥ TERMINAL_INCOMPLETE | run tests: coverage, fault precedence (USAGE_INVALID, UPSTREAM_AUTH, MODEL_OR_TIER_MISMATCH at finish and in a later revision), mismatch; mutations M1, M2, M7 detected |
| F3 P3 | The COMMIT(FAILED) after a REJECTED ACK is drained in the 2 s window; COMMIT and READY_ACK are capped at 4 KiB | units: drained (inbox empty); mutation M5 detected |
| F4 P3 | ARM_ACK fixture/admission, READY_ACK registration/boot, the record's whole Binding (+ correlation) and the POST snapshot's consistency are checked | run tests: foreign READY_ACK boot → ARM_FAILED_PROTOCOL_INVALID; foreign record pairId or correlation → not stored, `OBSERVATION_INVALID`; mutation M3 detected |
| F5 P3 | Exact `effective` (one reason per stricter state, null ⇔ base state), typed revision anchors and hashes, ISO `armExpiresAt`; the RS-A seal is pinned and bound | identity test: RS-A seal tamper → RSA_SEAL_DRIFT; every receipt in the tests passes `assertReceiptV3` |
| F6 P3 | `handoff` waits ≤5 s (`HANDOFF_PENDING`); `finish` refuses `BLOCKED_HANDOFF_PENDING`; `abandonedByOperator`; `armIssued` persisted before ARM; arm details persisted before the GO line; END_PAIR after an armed failure; the previous record is re-collected before every PRE; runbook corrected (manual button; a non-COMMITTED handoff ends the RC5 run) | run tests: arm phase (persist order, END_PAIR; mutation M4 detected), slot gate (`BLOCKED_HANDOFF_PENDING`, abandonment); E2E asserts `armIssued`/`abandonedByOperator`/`creditBlock`/`effective` |

rc3 closure (rc2 re-review):

| Finding | Repair | Proof |
|---|---|---|
| N1 P2 no-credit substitution erased failures | A COMMITTED handoff always gives RC5 the exact values. A blocked ANSWER loses only its ledger binding (`ledgerWithheld`, RC5 unknown-liability path); an ERROR keeps its measured ledger. `replyUnparseable` is used only for UNVERIFIED transfers. `effective` INCOMPLETE applies only while coverage is still missing or after a refused record | run test "rc3 N1", with a SUPPORTED case first: model/tier ERROR with a latched fault, or not FINAL, equals the FINAL control (FAILED, safety row, 0 handoff failures); a claims-failing ANSWER not FINAL stays FAILED and tallied; a valid uncovered ANSWER gets INCOMPLETE, no pass, `ledgerWithheld`. Mutation M8 detected |
| N2 P3 untested repairs | New detecting tests: POST snapshot `consistent:false` / another admission → UNAVAILABLE; ARM_ACK foreign fixture / admission → PROTOCOL_INVALID; READY_ACK over 4 KiB → `FRAME_TOO_LARGE` (the decoder alone gives PROTOCOL_INVALID); persist of the arm details after READY_ACK and before the GO line | mutations M9a, M9b, M10, M11a, M11b, M12 detected (`mutations-rc3.txt`). The RS-A seal-binding check stays undetectable by design (hash-pinned) |
| N3 P3 POST check on the mutable run tuple | The POST check uses the case's own PRE tuple (`b.ready.admissionId`) | a `confirm` typed mid-case (BLOCKED, run tuple null) still yields CONTROLLER_POST_SNAPSHOT and a pass. Mutation M13 detected |

The rc2 re-review residual stands: once a FINAL record has been collected, a later OBSERVATION_UNAVAILABLE counts as "swept". S
returns the same code for a record that expired uncollected, so the result is fail-closed (the next ARM gives OBSERVATION_GAP after
consumption). Telling the two apart needs a protocol distinction (RS-C-C/RS-D).

Not done (optional): binding the receipt to C's IDENTITY `buildManifestSha256`. C itself binds every SNAPSHOT to it, so a tamper
before C's launch already fails PRE. The 4 KiB caps are defence in depth: the exact-key decoders already bound a valid READY_ACK or
COMMIT well below that size.

Implementer: native `claude-opus-5-5` (Claude Code session `d0382327-d726-4375-8d23-49e794437702`), 2026-10-12. Not an approval.
Gate (owner's direct instruction): ONE independent native Opus 5.5 `max` review in a clean session (fresh for this checkpoint).
Brief: `IMPLEMENTATION_BRIEF_B.md` (in the baseline). Baseline: `verification/stage5/S5ASKREMOTE_REVAL_RSCB_BASELINE.sha256` (after the
RS-C-A seal). Manifest/checks: `verification/stage5/S5ASKREMOTE_REVAL_RSCB_RC1_{MANIFEST,CHECKS}.json`. No paid/provider call,
activation, account, customer data, deployment or commit.

## 1. Delivered (brief §1)
| Item | Where |
|---|---|
| Instrument revision driving the UNCHANGED RC5 `ExecutionSession` | `scripts/reval-instrument/` (`run.ts`, `operator.ts`, `cli.ts`) |
| Chained identity (RC3 → R-C → RC5 → RS-A → RS-B(+seal) → RS-C-A(+seal); admin overlays; rebuilt outputs recorded) | `identity.ts` |
| Measured IPC (principal I → C; S↔I handoff), expected producer/kind per operation, sequences | `ipc.ts` |
| 04 GO: PRE (no consumption on failure) → counters(PRE) + RC5 submit → ONE ARM → READY → GO inside PRE+30 s / expiresAt | `run.ts` `go` |
| 06 I side: READY-bound TRANSFER, accepted validators → SafeResult, PENDING before ACK, COMMITTED/UNVERIFIED | `transfer.ts` |
| Ledger/counters from C snapshots (accepted R-B outcome → RC5 settlement mapping) | `ledger.ts` |
| Terminal observation collection; outcome recorded once | `run.ts` `finish` |
| Receipt v3 (`base` = exact RC5 v2; measured `provenance`; flags constant; stricter-only `effective`) | `receipt.ts` |
| Network guard: only the owner's two unix sockets, named once | `net-guard.ts` |
| Carried: N2 (brief §4 gates before consumption), TRANSFER≠READY → REJECTED WRONG_BINDING, T2 stated | `run.ts`, `transfer.ts`, §4 |

## 2. Decisions inside the brief (for review)
- **No chain file is modified** (the delta vs the baseline is additions only): the identity pins every accepted manifest, so any edit
  of `docs/RUNBOOK.md`, `packages/reval/AGENTS.md`, `rs-c/AGENTS.md` or accepted tests would make this revision refuse itself. The
  operator procedure therefore lives in the new `rs-c/INSTRUMENT_RUNBOOK.md`; RUNBOOK/AI_CONTEXT_MAP routing waits for a part whose
  identity names this revision (RS-C-C).
- **RC5 manifest in the chain.** The revision imports RC5 modules (`session`, `transient`, `validate`, `receipt`, `corpus`,
  `tty-input`); their 120 files are pinned through the RC5 execution manifest (its own acceptance remains a separate gate).
- **Built outputs** (corrected in rc2, F1). `dist/` paths compiled from RS-B/RS-C-A changed/added sources are recorded in
  `rebuiltOutputsSha256` over the whole derived set (new modules included), and the digest is part of the RC5-compatible identity.
  Every other built entry must match exactly (RS-A pins supersede R-C).
- **Network guard.** The accepted offline guard blocks all connects (no allowlist), so the revision installs its own fail-closed
  guard with a one-shot allowlist of exactly the owner's two absolute unix socket paths; TCP/fetch/DNS/http/tls/dgram stay blocked.
- **Abandon handoff.** If the browser never hands the response off, `abandon-handoff` ends the wait as UNVERIFIED (`RAW_EXPIRED`)
  unless a TRANSFER already arrived; a late frame is drained, never ACKed or saved.
- **N2 gates (brief §4), all BEFORE the PRE snapshot, so a refusal consumes nothing:** (1) unless the previous handoff COMMITTED,
  the next GO waits until 125 s past the previous GO AND until that case's background reader ended plus 5 s (S settles a TRANSFER
  within its 2 s handoff deadline). The reader's own bound is the arm's `expiresAt` + 125 s, past any raw slot S can still open
  (claim ≤ `expiresAt`, slot ≤ 120 s), so no late frame can reach the next READY; (2) the previous case's terminal observation
  must be FINAL and collected (C's next ARM requires it; `finish` polls ≤ 7.5 s, then `go` re-collects it). Without that gate the
  ARM after consumption would fail `OBSERVATION_GAP` and stop the run. An arm S never claimed has no record: once it has expired,
  C stops arming (NB9) and so does this run (`ARM_EXPIRED_UNUSED`).
- **Durability.** Receipt v3 (which carries the PENDING summary saved before the ACK) is written to a temp file, fsync'd, renamed,
  then the directory is fsync'd. As with the controller journal, macOS fsync is not `F_FULLFSYNC`; that remains a residual.
- **Network guard parity.** It covers the same entry points as the accepted offline guard, including the `dns.Resolver` /
  `dns.promises.Resolver` classes, plus the unix-socket allowlist.
- **Outcome inputs** (rc2, F2). The RC5 outcome input depends on the transfer and the terminal record:
  - COMMITTED with an authenticated FINAL, fault-free and agreeing record → the exact transferred values.
  - Any other received transfer → RC5 `replyUnparseable` (LOCAL_HANDOFF_UNVERIFIED, no credit, with v3 `creditBlock`).
  - No transfer → RC5 `TIMEOUT`. The server's safe record stays in v3 `cases.terminal`.
- **Admission** stays operator-entered (ATTESTED) and is cross-checked with a C snapshot (admission ID, caps, expiry ≤ policy
  expiry, opening fence ≤ current fence); `capability` stays a browser paste (RC5) and every PRE must equal the confirmed tuple.

## 3. Checks (receipt `S5ASKREMOTE_REVAL_RSCB_RC1_CHECKS.json`)
See the receipt. New coverage: `tests/reval-instrument-run.test.ts` (GO state machine with fake C/S ports on the unchanged RC5 session: a
non-FINAL previous terminal blocks the next GO with no PRE/ARM and nothing consumed; after collection GO proceeds to PRE; an
uncommitted handoff blocks until 125 s past GO AND reader end + 5 s; an expired arm with no record → sticky `ARM_EXPIRED_UNUSED`;
both gates mutation-checked), `tests/reval-instrument-units.test.ts` (ledger mapping accepted by the RC5 validator; transfer:
PENDING-before-ACK, SafeResult, WRONG_BINDING, foreign READY echo, persist failure, invalid answer, FAILED/forged/missing COMMIT,
semantic MISMATCH/NOT_EVALUATED), `tests/reval-instrument-identity.test.ts` (chain: source/build/seal/manifest/overlay/RC5 tamper,
missing file, rebuilt output recorded; guard in a child process incl. both Resolver classes), `tests/pg/reval-instrument-e2e.pg.test.ts` (real CLI under a
live PTY with O/C/S/browser: COMMITTED case with casePass, PRE failure before consumption + ARM failure after it, abandoned
handoff + N2 block, no echo of the pasted question), `tests/pg/reval-native-instrument.pg.test.ts` (production chain + instrument:
no-key ERROR handed off COMMITTED, ledger NO_DISPATCH, charged 0).

## 4. Residuals and open decisions
- Provider key pass-through: PENDING owner decision (tentatively Azure environment variables); every case is NO_DISPATCH.
- T2 (06 "the same I process"): C and S prove their peers separately; this revision opens both sockets from one process and
  presents both IDs for the owner's `pair`, but neither C nor S can compare the two peers to one pid.
- `admission`, `capability`, `stage` and `consent` stay ATTESTED operator inputs (unchanged RC5 model); receipt v3 says so.
- N1 (header on unknown routes → 400 vs 404), the browser pane, the sealed console build, RUNBOOK/context-map routing for the
  revision, the 200-path E2E and NB7 target-platform rehearsal → RS-C-C. PROCESS_CENSUS/DRAIN/POST census, privacy proofs → RS-D.
- Pre-existing RS-C-A defect (P3), found by this run and carried to RS-C-C because RS-C-B changes no accepted file. In
  `eval-handoff-socket.ts` `nextAck`, the ACK wait timer is armed with `deadline - performance.now()`, and `eval-runtime.ts`
  `respond` then classifies a null wait as `DEADLINE` only if `mono() >= deadline`. Node timers fire up to ~1.9 ms early
  (`timer-probe.txt`: 881/2000 early), so a timed-out ACK is sometimes reported `503 IPC_LOST` instead of `504 DEADLINE`. The
  result is fail-closed either way (the slot is burned and the handoff stays UNVERIFIED), but the code is wrong. It was seen
  once in the full run, in `reval-eval-handoff.pg.test.ts`, and the file then passed 3/3 focused runs. The fix is to resolve
  the timer path as an explicit timeout instead of re-reading the clock.
- The RC5 tool's own `artifact-check` keeps refusing (enumerated drift since RS-A/RS-C-A); its 8 identity-only unit failures are unchanged.
- A throwaway database leaked once when the first E2E draft failed at module level before its `after` hook (the setup now
  verifies identity before creating any database); dropping leaked databases remains blocked by this session's permission policy.
