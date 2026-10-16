# Independent acceptance review — S5ASKREMOTE-REVAL-SERVER-RSC-B-rc1 (RS-C part B: instrument revision)

- Reviewer: native Claude Opus 5.5 (`claude-opus-5-5`). This is a clean session, with no implementer conversation and no other
  reviewer's verdict. Effort is `max` per the launch request; effort cannot be observed from inside the session. Date: 2026-10-12.
- Provenance note for the seal: this session is an Agent-tool subagent. Its scratchpad path carries the session ID
  `d0382327-d726-4375-8d23-49e794437702`, which is the implementer session named in `IMPLEMENTATION_REPORT_B.md`. The context is
  clean, but the process lineage is the implementer's Claude Code session. The RS-B and RS-C-A reviews used the same owner-chosen
  pattern.
- Normative basis:
  - SERVER-DESIGN-rc4: `04_TRANSIENT_HANDOFF.md` ("Pairing and arm", "First-current-GO bookkeeping", "Memory, bounds and time");
    `06_LOCAL_PROTOCOL.md` ("Roles, channels and sequences", "Original-task terminal observation", "Exact transient transfer and
    acknowledgements"); and the `05_PROOFS_AND_ACCEPTANCE.md` rows RS-C, First arm, GO integration, Handoff and Terminal fault.
  - The RS-C-A rc2 seal and its `carriedToRSCB` items, with notes N1/N2 of the RS-C-A rc2 review.
  - The RC5 execution instrument, which may only be imported.
  - The owner decisions in the request.
  - `IMPLEMENTATION_BRIEF_B.md`, which I judged against 04/06 and did not treat as an approval.
- Boundary:
  - The only repository change is this file.
  - Probes ran in `/private/tmp/rscb-review-opus/copy` (`node_modules` symlinked, `.env` sourced from the repository and never
    copied). The copy was deleted after the review.
  - No network beyond 127.0.0.1 and unix sockets. No provider or account call.
  - Docker and the native cluster `/private/tmp/rsb-pg` were not reconfigured. The `atlas*` database and role census is identical
    before and after on both servers.

Verdict: CHANGES_REQUIRED

There are two required findings (F1, F2) and four optional findings (F3–F6). There is no P1. GO ordering, the I side of the 06
transfer, the ledger mapping, receipt v3 durability, the network guard, the TTY discipline and the absence of a key or provider
path are sound (§3).

## 1. Artifact identity (recomputed)

- **Manifest.** `verification/stage5/S5ASKREMOTE_REVAL_RSCB_RC1_MANIFEST.json` sha256 is `d17432d9…74ca7fee`: **matches**.
- **packageHash.** `5a6676e0…5063597bd`, recomputed with the rule in the file two ways: from the working tree and from the 19
  manifest entries. **Both match.** All 19 per-file hashes equal the tree.
- **Delta against the baseline.** I listed the tree with `git ls-files -co --exclude-standard`: 2018 files against 1982.
  - changed 0, removed 0, added 36.
  - The 36 added files are the 19 package files plus 17 excluded by the rule: the baseline, the checks receipt, 14 logs and the
    manifest.
  - **The delta is additions only.** No RS-A/RS-B/RS-C-A/RC5 file changed. `scripts/ask-remote-eval-execution/**` is
    byte-unchanged, which is also verified through the RC5 manifest inside the chain.
- **Baseline.** sha256 `278993d1…53d0f5` equals `baselineFileSha256`. It contains:
  - the RS-C-A seal (`7e52aae0…`);
  - the `rs-c/AGENTS.md` administrative delta (`57437aa7…`);
  - `IMPLEMENTATION_BRIEF_B.md` (`a50b8900…`).

  The request says the baseline lists itself with a stale hash. It does not list itself (1982 entries). This has no effect on the
  delta.
- **Checks receipt.** sha256 `7ff02443…af02cf19`. All 14 log hashes match.
- **Build.** A fresh `npm run api:build` in the copy gives a `dist/` identical to the repository's (`diff -rq`).
  `artifact-check` then reports `ok:true`, `drift:[]` and 2154 files. `rebuiltOutputsSha256` is `8db21780…` and
  `instrumentRevisionSha256` is `c165f386…`. Both equal `artifact-check.txt`.
- **Import closure.** The instrument's transitive static and dynamic import closure is 68 files. Every one is pinned by an
  accepted manifest or belongs to the revision. The only external imports are `node:` built-ins.

## 2. Findings

### F1 — P2 — Build-output identity is weaker than the accepted chain and than RC5

**(a) An RS-A-pinned output is tolerated with any bytes.**
- `identity.ts:33-34` puts `dist/packages/graph/runtime-role.js` in `REBUILT_OUTPUTS`. `identity.ts:102` and `:110` check
  rebuilt outputs for presence only.
- Its source was changed by RS-A only: the R-C hash is `6aac5e45…` and the RS-A hash is `ac0c6c29…`. Neither the RS-B nor the
  RS-C-A manifest lists `packages/graph/runtime-role.ts`.
- The accepted RS-A rc3 manifest pins the built file at `a63c4723…`.
- Probe I1: I appended bytes to that file in the copy. `artifact-check` then reports `ok:true` and `drift:[]`; only
  `rebuiltOutputsSha256` changes.
- Control probe I2: the same tamper on the RS-A-pinned `dist/packages/reval/channel.js` gives `SOURCE_DRIFT`.
- This breaks "rebuilt outputs only for accepted RS-B/RS-C-A sources" and "no accepted build byte silently tolerated".

**(b) The recorded digest is never compared again.**
- `operator.ts:134` (`identityHolds = sameIdentity(start.snapshot, verify())`) and the RC5 session's own pre-submit check
  (`session.ts:202`) compare only `ok` and the RC5 `Identity`.
- `rebuiltOutputsSha256` lives only in the revision record, and `buildReceiptV3` always writes the START revision
  (`operator.ts:84`).
- Probe I4: I took `start = verifyRevision()`, then made mid-session appends to three files:
  `dist/apps/api/src/main.js`, `dist/packages/reval/eval-runtime.js` and `dist/packages/graph/runtime-role.js`. Each time
  `sameIdentity` stays `true`, `ok` stays `true`, and only the digest changes.
- Under RC5, `artifact.ts:89` pinned the corresponding R-C outputs and re-checked them before every submission. The revision's
  unit test even asserts the weaker behaviour (`tests/reval-instrument-identity.test.ts:33`).

**Existing mitigation (not a substitute).** C binds every SNAPSHOT to the registration's `buildManifestSha256`, measured at C's
launch (`snapshot-reader.ts:58-61`, `controller.ts:93`). So a tamper between registration and C's launch fails PRE before
consumption. This does not cover a tree that was tampered before registration, or the instrument's own evidence claim ("checked at
start and before every GO").

**Required fix.**
- Derive the presence-only set solely from the `apps|packages/**.ts` sources that RS-B/RS-C-A changed or added.
- Put the R-C `builtInventory` into the ordered expected map before RS-A, so that the RS-A `dist/` pins supersede it. This pins
  `runtime-role.js` at `a63c4723…`.
- Compare `rebuiltOutputsSha256` (or the whole revision record) before every GO, and inside the `verify()` handed to the RC5
  session, for example by folding it into `Identity.executionToolSha256`.
- Optionally bind the receipt to C's IDENTITY `buildManifestSha256`.
- Add tests: a `runtime-role.js` tamper must be drift, and a mid-session rebuilt-output change must give
  `BLOCKED_IDENTITY_DRIFT` before PRE and an integrity stop at submit.

### F2 — P2 — Authenticated terminal observations do not gate run state or credit

06 says: "Failure precedence is mandatory: any authenticated non-NONE detectedFault gives TERMINAL_FAILED even when no raw handoff
is possible". 06 also says: "Missing observation coverage blocks credit and further arming".

Where the code falls short:
- `receipt.ts:35-38` escalates `effective` only when `handoffState !== 'COMMITTED'`.
- `run.ts:86-88` and `run.ts:198-205` store the observation but never act on `detectedFault`.
- `finish()` records the RC5 outcome even when the terminal record is not FINAL.
- Brief §6 contains the same narrowing ("an authenticated terminal fault under an unverified handoff is FAILED").

Probe: `tests/probe-fault.test.ts` in the copy. It uses the unit-test rig (fake C/S ports) on the unchanged RC5 session, and
places a SUPPORTED case first so that a single failure does not end the run by threshold. The logic under test is unchanged.

| Scenario | Result |
|---|---|
| MODEL_OR_TIER_MISMATCH latched, public 504 ASK_DEADLINE (the 06 example), handoff COMMITTED | `CASE_RECORDED RE-SUM-001 ACTIVE COMMITTED`; `effective` ACTIVE; the next `go` gives `GO_CLICK_ASK_NOW RE-UNS-051 26` after `SNAPSHOT`, `ARM_CASE` (the next case is consumed and armed) |
| UPSTREAM_AUTH latched, public 503 ASK_REMOTE_UNAVAILABLE, COMMITTED | `effective` TERMINAL_INCOMPLETE. 06 classes this as a known configuration fault, which must be TERMINAL_FAILED |
| Valid ANSWER, USAGE_VERIFIED, terminal record not FINAL at `finish` | base `casePass:true`. When the record later becomes FINAL with USAGE_INVALID, the next `go` collects it and proceeds to `SNAPSHOT`, `ARM_CASE`, GO. `effective` stays ACTIVE and `casePass` stays true |

This is unreachable today, because the no-key bridge seams are NO_DISPATCH. But this instrument is the measurement path for
provider faults.

**Required fix.**
- Any collected non-NONE `detectedFault`, in any revision, must cause a sticky stop before the next consumption, and an `effective`
  TERMINAL_FAILED whatever the handoff state.
- A case recorded without a FINAL terminal record must not count as pass or credit. For example, add a no-credit marker per case
  in v3 and in `effective`, or feed RC5 a no-credit outcome.
- Amend brief §6.
- Add the three probes as tests.

### F3 — P3 — The COMMIT after a REJECTED ACK is never read

- S answers every matching ACK, REJECTED included, with `COMMIT(FAILED, ACK_INVALID)`. See `eval-runtime.ts:185` and the accepted
  RS-C-A test "a REJECTED ACK → COMMIT FAILED".
- `transfer.ts:75-78` returns without reading it. The non-strict instrument channel queues it (`channel.ts:86`) with S's correct
  next sequence, so the next `h.next()` would take it as a READY_ACK.
- This is harmless today only because any non-COMMITTED handoff ends the RC5 run (TERMINAL_INCOMPLETE).
- Fix: read and validate, or explicitly drain, the COMMIT within the 2 s window, or close the handoff connection after a REJECTED
  ACK.

### F4 — P3 — Defense-in-depth checks missing on the I side (06 "every consumer compares…")

- `run.ts:136` does not compare the ARM_ACK `fixtureId` and `admissionId`.
- `run.ts:149` does not compare the READY_ACK `registrationId` and `serverBootId`.
- `run.ts:86` and `:201` do not compare the TERMINAL_OBSERVATION binding (armId, caseId, pairId, registration/boot) with I's own
  arm. C checks only armId, registration and boot (`eval-controller.ts:109`). Its publication is not cross-checked with the
  handed-off status.
- `run.ts:210-215` does not check the POST snapshot's `consistent` and `foreignScopeAttemptCount` before deriving the ledger.
- I applies no per-kind byte caps (READY_ACK/COMMIT ≤4 KiB). They are bounded only by the strict decoders.

### F5 — P3 — The receipt v3 allowlist is looser than "exact"

- `effective.reason` accepts any value, and `effective.state` is not checked to be at least as strict as the base state
  (`receipt.ts:59`).
- The `revision.*` values are untyped (`:56`), and `armExpiresAt` accepts any string (`:64`).
- The RS-A seal is not bound. Only the RS-B and RS-C-A seals are checked; the RS-A seal carries `DUAL_APPROVED_RS_A` and
  `manifestSha256 a356a7d1…`.

### F6 — P3 — Operator procedure and wording

- `handoff` and `finish` (`operator.ts:161-163`) wait for the background reader, whose bound is about expiresAt + 125 s.
  `abandon-handoff` cannot be typed meanwhile, because the session has a single command loop.
- Runbook step 6 says the browser sends RESPONSE "автоматически". 04 requires the manual "Send evaluation evidence" button.
- The runbook and the report imply that a run continues after a non-COMMITTED handoff. In fact RC5 ends it TERMINAL_INCOMPLETE,
  so the 125 s N2 slot gate is defense in depth only.
- An operator abandonment is recorded as `RAW_EXPIRED`.
- Brief §4(c) promises an `armIssued:true` marker, but none is persisted. The armId and READY details are saved only after the GO
  line is printed. The consumption itself is persisted before ARM.
- Optional improvements:
  - On an arm-phase failure after ARM_ACK, send END_PAIR for the instrument's own pair, so that a stray click cannot claim a READY
    arm.
  - Re-collect the previous FINAL record before every PRE. C swallows a lost OBSERVATION_COLLECTED (`eval-controller.ts:123`), and
    the next ARM would then fail OBSERVATION_GAP after consumption.

## 3. What was confirmed

- **Chain.**
  - Six anchors are pinned (the RC5, RS-A, RS-B and RS-C-A manifests and the RS-B and RS-C-A seals), plus RC5's two.
  - The RS-B and RS-C-A seals are bound to their manifest path, hash and accepted status, and their administrative deltas are
    applied.
  - Every expected source path is re-hashed (1910 expected).
  - The RC5 overlay rule is unchanged.
  - The RS-A-pinned dist entries outside the rebuilt set are drift on tamper.
  - `verifyRevision` takes 53–81 ms in process.
- **GO ordering (04).**
  - PRE comes before consumption, and a PRE failure consumes nothing (E2E: `BLOCKED_PRE_TUPLE`, then the case is still next).
  - `counters(PRE)` + RC5 `submit` is the consumption, and it is persisted before ARM.
  - Exactly one ARM_CASE is sent.
  - Any later failure runs `abandonInFlight` and sets a sticky `ARM_PHASE_FAILURE` (E2E: `ARM_FAILED_PAIR_UNAVAILABLE`, then
    `BLOCKED_ARM_STOPPED_*`).
  - GO is shown only after ARM_ACK and READY_ACK, with `left = min(PRE+30 s, expiresAt)` greater than 0.
  - There is no retry, re-arm or resend path.
  - The N2 terminal gate runs before PRE. My mutations of both gates are detected by `tests/reval-instrument-run.test.ts`.
- **06, I side.**
  - TRANSFER must be S's exact next sequence on this connection and must echo THIS READY's challenge and `readySequence`.
  - The binding must equal every READY field and the handoff connection, or the ACK is REJECTED `WRONG_BINDING`.
  - `decodeTransfer` enforces correlation agreement and `publicationAuthority`.
  - RC5 `checkRequest`/`checkResponse` are rerun, and SafeResult follows the 06 rules.
  - PENDING is saved (fsync, rename, directory fsync) before the ACK.
  - COMMITTED requires a matching challenge, ackSequence, transferId and binding, and then a saved COMMITTED summary.
  - UNVERIFIED codes come from FailureCode.
  - Abandoned or late frames are never ACKed.
  - Values stay in memory only, and receipts pass the question/rationale and forbidden-key scan.
- **Ledger.** The mapping follows the R-B decoder vocabulary (`payloads.ts:76-81`). Each mapping is accepted by RC5
  `ledgerValues`, and unknown or pending states are conservative.
- **Receipt v3.**
  - `base` is the RC5 `buildReceipt` output and passes `assertReceipt`.
  - The flags are the constants false/BLOCKED, and the provenance is constant.
  - It is written before the ACK, after COMMIT and after every command.
- **Guard.**
  - It is installed before any other import.
  - It covers the same entry points as the accepted offline guard, plus a two-path absolute unix allowlist that can be set once.
  - The `dgram.Socket` constructor path is blocked in both guards: probe on 127.0.0.1 only.
- **TTY.** Raw mode is set before the dynamic imports and kept for the whole session. The E2E transcript has no echo of the
  pasted question.
- **IPC.**
  - Each operation has its expected kind and original emitter.
  - Envelope checks cover registration, boot, connection, sequence, requestSequence, challenge and databaseInstanceId.
  - There is one outstanding request and a 2 s timeout.
  - The handoff connection is sequenced in both directions.
- **No key or provider path.** There are no environment reads, no fetch/http(s), and no transport or dispatch module in the
  import closure. The native chain gives NO_DISPATCH with 0 charged.
- **Report.**
  - The §2 decisions are accurate apart from F1, F2 and F6.
  - The §4 RS-C-A timer residual reproduces: 441 of 1000 early, worst −1.858 ms.
  - The full test:pg failure (`reval-eval-handoff`, late ACK) is that pre-existing RS-C-A classification race.

## 4. Commands run and results

| Command | Result |
|---|---|
| Identity script: `git ls-files -co --exclude-standard` against the baseline, the packageHash rule, manifest entries | 0 changed / 0 removed / 36 added; package = 19 manifest files; `5a6676e0…` both ways |
| `shasum` of the manifest, baseline, checks receipt and 14 logs | all match |
| `npm run typecheck` (copy) | pass |
| `npm run api:build` (copy) + `diff -rq dist` | pass; identical |
| `cli.ts artifact-check` (copy, after the build) | `ok:true`, `drift:[]`, 2154 files |
| `node --test tests/reval-instrument-*.test.ts` | 8/8 |
| `node --test tests/*.test.ts` (copy) | 562 tests: 552 pass, 9 fail, 1 skipped. 8 = the known RC5 identity-only set (same names as `unit.txt`). 1 = `action-canonical` "inside this checkout", because the copy had no `.git`; with a git marker that file passes 8/8 |
| `tests/pg/reval-instrument-e2e.pg.test.ts` (Docker PG17, copy) | 3/3; ARM 10 ms, READY 1 ms |
| `ATLAS_REVAL_NATIVE_PG_FIXTURE=… tests/pg/reval-native-instrument.pg.test.ts` | 1/1: TERMINAL_INCOMPLETE, ASK_REMOTE_UNAVAILABLE, NO_DISPATCH, charged 0 |
| Probes I1, I2, I4 (identity) and P2a/P2b (`probe-fault.test.ts`) | as in F1 and F2 |
| Mutations: remove the N2 terminal gate, remove the slot gate (`run.ts`) | detected (2 failures, 1 failure) |
| Import-closure scan; `verifyRevision` timing; timer probe; guard probe | as in §1 and §3 |
| `atlas*` database and role census, Docker and native, before and after | identical (14 DBs and 150 roles; 0 and 1). No test or server process left |

I did not re-run the full `npm run test:pg`, `schema:validate`, `db:check:pg17`, `db:check:drift` or `api:smoke`. The delta adds
no prisma, server or browser file, and the receipt's logs hash-match.

## 5. Residuals and notes for RS-C-C and RS-D

- **Carried as stated.**
  - T2: the two sockets are proven separately and not tied to one I process.
  - The provider-key pass-through is a PENDING owner decision.
  - admission, capability, stage and consent remain ATTESTED.
  - macOS fsync is not `F_FULLFSYNC`.
  - The RS-C-A `nextAck` timer classification bug (fail-closed).
  - N1.
- **RS-C-C.**
  - Seal a build inventory for the RS-B/RS-C-A/RS-C-C outputs, so that the rebuilt set can be pinned rather than recorded.
  - Add `AGENTS.md` and context-map routing for `scripts/reval-instrument/`, which is deferred because the overlays are pinned.
  - Build the manual "Send evaluation evidence" button.
  - The 200-path E2E.
  - The NB7 rehearsal, including the PRE→ARM path inside C's 2 s PRE-age bound: verify ≈55–80 ms plus the receipt fsync.
  - A pair-id typo burns a case (fail-closed by design).
- **RS-D.**
  - The POST census before the next arm, and PROCESS_CENSUS/DRAIN.
  - Egress and privacy proofs.
  - The instrument does not measure C's or S's peer and relies on the 0700 owner directory and same-UID trust.
- **Pre-existing.** The 12 leftover `atlas_it_*` databases in Docker are unchanged.
- **No admission.** No paid or provider call, activation, account, data or budget admission is implied by this review.

---

# Bounded re-review — S5ASKREMOTE-REVAL-SERVER-RSC-B-rc2

This continues the same reviewer session as a bounded repair re-review: native Claude Opus 5.5, effort `max` per the launch
request. Date: 2026-10-12. The boundary is unchanged:
- The only repository change is this appended section.
- Probes and mutations ran in `/private/tmp/rscb-review-opus2/copy` (`node_modules` symlinked, no `.env` copied). The copy was
  deleted afterwards.
- No network beyond loopback and unix sockets.
- Docker and `/private/tmp/rsb-pg` were not touched. The `atlas*` census is identical before and after (Docker: 14 databases and
  150 roles; native: 0 and 1). No test or server process was left running.

Verdict (rc2): CHANGES_REQUIRED

- F1 and F3–F6 are closed.
- The three F2 scenarios are closed, but the F2 repair introduced one required regression, N1: the no-credit substitution erases
  authenticated failure evidence.
- N2 and N3 are optional.

## R1. Artifact identity (recomputed)

- **Manifest.** `S5ASKREMOTE_REVAL_RSCB_RC2_MANIFEST.json` sha256 is `ebdc65d8…72fb4c88`: **matches**.
- **packageHash.** `4e6027e0…6f3669e34`, recomputed from the tree and from the 21 entries: **both match**.
- **Delta against the unchanged baseline** (`278993d1…`):
  - 1 changed: `IMPLEMENTATION_BRIEF_B.md`, `a50b8900…` → `e865c443…`. Its baseline field matches.
  - 20 added package files. 0 removed.
  - 32 further additions are excluded by the rule: the rc1/rc2 manifests, receipts and logs, the baseline and this review.
  - No accepted RS-A/RS-B/RS-C-A/RC5 file changed. The brief is the implementer's own document from the baseline.
- **History.** The rc1 manifest (`d17432d9…`) and the rc1 checks receipt (`7ff02443…`) are unchanged.
- **Checks receipt.** sha256 `3350025f…`. All 13 log hashes match.
- **Build.** A fresh `api:build` in the copy gives a `dist/` identical to the repository's. `artifact-check` reports `ok:true`,
  `drift:[]` and 1974 files. `executionToolSha256` `7e46806b…`, `instrumentRevisionSha256` `afc55ee9…` and `rebuiltOutputsSha256`
  `188a6c98…` all equal `artifact-check.txt`.

## R2. Closure of the rc1 findings

| ID | Status | Evidence |
|---|---|---|
| F1 P2 build identity | **CLOSED** | One ordered map (`identity.ts:91-96`). The presence-only set comes from RS-B/RS-C-A sources only (`:100-103`). The digest is folded into `executionToolSha256` (`:136`). The RS-A seal is pinned and bound (`:29`, `:76`). Re-run probes: a `runtime-role.js` tamper → BUILD_DRIFT (rc1: `ok:true`); `channel.js` → BUILD_DRIFT; an R-C operator bundle file → BUILD_DRIFT. A mid-session change of `main.js` or `eval-runtime.js` → `sameIdentity` false (rc1: true). My mutation removing the fold is detected |
| F2 P2 faults and coverage | **CLOSED for the reported scenarios**; see N1 | A fault in any revision gives a sticky `TERMINAL_FAULT` and `effective` TERMINAL_FAILED (`run.ts:101`, `receipt.ts:42`). A case without a FINAL record gets no credit, and the next GO is blocked before PRE. A contradicting publication gives no credit and a stop. My three rc1 probes are now tests and pass. My mutations of `run.ts:101` and `terminal.ts:28` are detected |
| F3 P3 COMMIT after REJECTED | **CLOSED** | `transfer.ts:80-87` drains the COMMIT(FAILED) inside the window. Mutation detected |
| F4 P3 I-side checks | **CLOSED** | ARM_ACK echoes all six fields (`run.ts:172-173`). READY_ACK registration/boot are checked (`:188-189`). The record's Binding and correlation are checked (`terminal.ts:16-18`, `run.ts:95-103`). The POST snapshot must be consistent, foreign-free and for the confirmed admission (`run.ts:259`). See N2 for the missing tests |
| F5 P3 allowlist | **CLOSED** | `effective` is exact (`receipt.ts:40-45`, `:74-77`). The anchors and hashes are typed (`:68-71`). `armExpiresAt` must be ISO (`:82`) |
| F6 P3 operator procedure | **CLOSED** | `handoff` waits ≤5 s and answers `HANDOFF_PENDING`; `finish` answers `BLOCKED_HANDOFF_PENDING`. `abandonedByOperator` is recorded. `armIssued` is persisted before the ARM and the arm details before the GO line. END_PAIR is sent after an armed failure. The previous record is re-collected before every PRE (mutation detected). The runbook now names the manual button and says that a non-COMMITTED handoff ends the RC5 run |

## R3. New findings

### N1 — P2 — The no-credit substitution erases authenticated failure evidence (regression from the F2 repair)

**Where.** `run.ts:264-273`: when a COMMITTED case has any `creditBlock` (TERMINAL_NOT_FINAL, TERMINAL_FAULT, TERMINAL_MISMATCH,
or a refused foreign record), RC5 receives `replyUnparseable` instead of the exact server-bound values that I already validated.
RC5 therefore records LOCAL_HANDOFF_UNVERIFIED, an unattributed handoff failure, and never sees the authenticated outcome, its truth
result or its safety code.

**Why it is a defect.** 06 says: "Preserve a previously authenticated fixed fault or truth/threshold failure as FAILED; transport
uncertainty must not erase that stronger evidence". It also says: "Known authentic claim/safety failure … also retains its stronger
FAILED state". Missing coverage must block credit; it must not downgrade a proven failure.

**Probe.** `probe-rc2.test.ts` in the copy uses the rc2 unit rig on the unchanged RC5 session, with a SUPPORTED case first.

| COMMITTED values and terminal record | base run / safety rows hit / unattributed handoff failures | `effective` |
|---|---|---|
| Control: 503 ASK_REMOTE_MODEL_MISMATCH, FINAL agreeing record, no fault | TERMINAL_FAILED (ASK_REMOTE_MODEL_MISMATCH) / MODEL_TIER 1 / 0 | = base |
| Same values; FINAL record with latched MODEL_OR_TIER_MISMATCH | TERMINAL_INCOMPLETE (LOCAL_HANDOFF_UNVERIFIED) / none / 1 | TERMINAL_FAILED (fault) |
| Same values; record not FINAL in the poll window | TERMINAL_INCOMPLETE (LOCAL_HANDOFF_UNVERIFIED) / none / 1 | **TERMINAL_INCOMPLETE** |
| Control: ANSWER failing a claims predicate (accepted fake-V2 tamper `OBSERVATION_SUMMARY`), FINAL | TERMINAL_FAILED (SAFETY_VIOLATION) / CLAIMS 1 / 0 | = base |
| Same ANSWER; record not FINAL | TERMINAL_INCOMPLETE (LOCAL_HANDOFF_UNVERIFIED) / none / 1 | **TERMINAL_INCOMPLETE** |

**Impact.**
- A proven zero-tolerance claims failure, or a COMMITTED public model/tier failure, ends INCOMPLETE instead of FAILED whenever
  coverage is missing.
- With a matching fault, the base loses the safety category and gains a false "unattributed handoff failure".
- rc1 recorded these cases as FAILED with the row hit.
- The same path is reachable through a foreign record or a contradicting publication.

**Required fix.**
- For a COMMITTED handoff, always give RC5 the exact values.
- Withhold credit without erasing evidence. For example, for an ANSWER withhold the ledger binding, so that RC5 takes its accepted
  unknown-liability path: no pass and no credit, while a truth failure stays SAFETY_VIOLATION_UNDER_UNKNOWN_LIABILITY (FAILED) and
  the safety rows are tallied. An ERROR never earns credit, so its exact values and the measured ledger can be kept.
- Keep `creditBlock`, the fault stop and `effective` as they are now. The N2 gate already blocks further arming until coverage
  exists.
- Add the five probe rows as tests.

### N2 — P3 — Some rc2 repairs have no detecting test

My mutations that remove each of the following are not detected by any test:
- the POST-snapshot consistent/foreign/admission check (`run.ts:259`);
- the READY_ACK 4 KiB cap (`:186`);
- the ARM_ACK `fixtureId`/`admissionId` echo (`:172`);
- the persist of the arm details before the GO line (`:195`).

The RS-A seal binding check (`identity.ts:76`) cannot be detected by design, because the seal is hash-pinned; that is acceptable.
The report §0 proof column overstates the coverage for F4 and F6.

### N3 — P3 — The POST ledger check is keyed to the mutable run tuple

- `run.ts:259` compares the POST snapshot with `this.tuple?.admissionId`.
- A `confirm` typed while a case is in flight returns BLOCKED and sets `run.tuple` to null (`run.ts:79-82`). `finish` then
  discards the measured ledger (MISSING, so the liability is unknown).
- This is conservative, but the check should use the case's own PRE tuple.

## R4. Commands and results (rc2)

| Command | Result |
|---|---|
| Identity script: delta against the baseline, packageHash rule, manifest entries and baseline field | 1 changed / 20 added (+32 excluded) / 0 removed; `4e6027e0…` both ways |
| `shasum` of the manifest, checks receipt and 13 logs; rc1 manifest and receipt | all match; rc1 unchanged |
| `npm run typecheck` (copy) | pass |
| `npm run api:build` (copy) + `diff -rq dist` | pass; identical |
| `cli.ts artifact-check` (copy) | `ok:true`, `drift:[]`, 1974 files |
| `node --test tests/reval-instrument-*.test.ts` | 11/11 |
| `node --test tests/*.test.ts` (copy with a git marker) | 565 tests: 556 pass, 8 fail (the known RC5 identity-only set), 1 skipped |
| `tests/pg/reval-instrument-e2e.pg.test.ts` (Docker PG17) | 3/3; ARM 9 ms, READY 0 ms |
| `ATLAS_REVAL_NATIVE_PG_FIXTURE=… tests/pg/reval-native-instrument.pg.test.ts` | 1/1: TERMINAL_INCOMPLETE, ASK_REMOTE_UNAVAILABLE, NO_DISPATCH, charged 0 |
| Identity probes: `runtime-role.js`, `channel.js`, operator bundle file, mid-session `main.js`/`eval-runtime.js` | as in R2 |
| N1 probe (`probe-rc2.test.ts`) | as in N1 |
| Mutations: 10 valid ones in the copy, each file restored and compared with `cmp` | 5 detected: fold, fault stop (`run.ts`), fault credit block (`terminal.ts`), COMMIT drain, re-collect before every PRE. 5 not detected: RS-A seal binding (redundant by design), POST check, READY_ACK cap, ARM_ACK fixture/admission echo, persist before GO |
| `atlas*` database and role census, before and after | identical; no process left |

I did not re-run the full `test:pg`, `db:check:*` or `api:smoke`: the delta has no prisma, server or browser file, and the
receipt's logs hash-match (771/771).

## R5. Residuals

- **Carried.** The rc1 §5 residuals stand unchanged. Binding the receipt to C's IDENTITY `buildManifestSha256` stays optional,
  and the report gives the reason.
- **New.** Once a FINAL record has been collected, any later OBSERVATION_UNAVAILABLE counts as "swept" (`run.ts:112`).
  - S returns the same code for a record that expired uncollected (`eval-observer.ts:28`, `:85`). That happens after a lost
    OBSERVATION_COLLECTED plus 10 minutes, and S then counts it against arming.
  - The next ARM would therefore fail OBSERVATION_GAP after consumption.
  - This is fail-closed. Telling the two apart needs a protocol distinction (RS-C-C/RS-D).
- **Behaviour change to note.** A COMMITTED case whose record is not FINAL within `finish`'s 10 s poll now ends the RC5 run with
  no credit. The operator can wait before typing `finish`.
- **No admission.** No paid or provider call, activation, account, data or budget admission is implied.

---

# Bounded re-review — S5ASKREMOTE-REVAL-SERVER-RSC-B-rc3

This continues the same reviewer session as a bounded re-review of the rc2 findings N1–N3: native Claude Opus 5.5, effort `max` per
the launch request. Date: 2026-10-12. The boundary is unchanged:
- The only repository change is this appended section.
- Probes and mutations ran in `/private/tmp/rscb-review-opus3/copy`, which was deleted afterwards.
- Loopback and unix sockets only.
- Docker and `/private/tmp/rsb-pg` were not touched. The `atlas*` census is identical before and after (Docker: 14 databases and
  150 roles; native: 0 and 1). No process was left running.

Verdict (rc3): APPROVE_RS_C_B

- N1 (P2) is closed, and N2 and N3 (P3) are closed.
- F1–F6 remain closed.
- There are no new findings.

## S1. Artifact identity (recomputed)

- **Manifest.** `S5ASKREMOTE_REVAL_RSCB_RC3_MANIFEST.json` sha256 is `f7497028…4e077d77929`: **matches**.
- **packageHash.** `f987d968…16290a5dd8`, recomputed from the tree and from the 21 entries: **both match**.
- **Delta against the unchanged baseline:** 1 changed (`IMPLEMENTATION_BRIEF_B.md`; its baseline field matches), 20 added,
  0 removed. No accepted RS-A/RS-B/RS-C-A/RC5 file changed.
- **rc2 → rc3.** Exactly the 7 files declared: the brief, the report, `receipt.ts`, `run.ts`, `transfer.ts`, and the run and units
  tests.
- **History.** The rc1 and rc2 manifests and receipts are unchanged.
- **Checks receipt.** sha256 `69c36102…cbedf989e`. All 13 log hashes match.
- **Build.** A fresh `api:build` in the copy gives a `dist/` identical to the repository's. `artifact-check` reports `ok:true`,
  `drift:[]` and 1974 files. `executionToolSha256` `54cd8dbe…`, `instrumentRevisionSha256` `852c5362…` and `rebuiltOutputsSha256`
  `188a6c98…` all equal the rc3 `artifact-check.txt`.

## S2. Closure

| ID | Status | Evidence |
|---|---|---|
| N1 P2 no-credit substitution | **CLOSED** | `run.ts` `finish`: a COMMITTED handoff always gives RC5 the exact values. A credit-blocked ANSWER loses only its ledger binding (`ledgerWithheld`, RC5's accepted unknown-liability path). An ERROR keeps its measured ledger. `replyUnparseable` is used only for UNVERIFIED transfers. `effectiveOf` is INCOMPLETE only for OBSERVATION_INVALID, or while a TERMINAL_NOT_FINAL record is still missing. My independent probe (11 rows, SUPPORTED case first) is listed below this table |
| N2 P3 untested repairs | **CLOSED** | My mutations removing each of these are now detected: the POST check, the READY_ACK cap, the ARM_ACK fixture/admission echo, the persist before GO, and the COMMIT cap code |
| N3 P3 mutable tuple | **CLOSED** | The POST check uses `b.ready.admissionId` (the case's PRE tuple). Reverting it is detected by the test with a mid-case `confirm` |

My N1 probe gave these results:
- The model/tier ERROR rows now equal the FINAL control, both with a latched fault and with the record not FINAL: base
  TERMINAL_FAILED, MODEL_TIER 1, 0 unattributed handoff failures.
- A claims-failing ANSWER with the record not FINAL gives TERMINAL_FAILED (SAFETY_VIOLATION_UNDER_UNKNOWN_LIABILITY), CLAIMS 1, no
  pass and `ledgerWithheld:true`.
- A valid uncovered ANSWER gives TERMINAL_INCOMPLETE (ANSWER_LIABILITY_UNKNOWN), no pass and 0 handoff failures.
- A fault with an ANSWER gives `effective` TERMINAL_FAILED and a TERMINAL_FAULT stop.
- A contradicting publication and a foreign record each give INCOMPLETE and an OBSERVATION_INVALID stop.
- A clean FINAL ANSWER is still credited.
- ASK_BUSY with the record not FINAL leaves the base ACTIVE, gives `effective` TERMINAL_INCOMPLETE, and the N2 gate blocks the next
  GO before consumption until coverage arrives.

**Regression search.** I re-checked the following and found no regression:
- every RC5 outcome path for a COMMITTED, credit-blocked case;
- the FailureCode closure of the new `FRAME_TOO_LARGE` results;
- the exact `effective`/allowlist rules with the new `ledgerWithheld` key;
- that the 8 `go`/`finish` mutations below restore byte-exact.

## S3. Notes (no action required)

- A credit-blocked ANSWER keeps only the fact that a measured ledger existed (`ledgerSource`, `ledgerWithheld`), not its amounts.
  RC5 books the case as unknown liability, which is conservative. The DB, closure and POST census remain the financial source of
  truth.
- `effective` can return from TERMINAL_INCOMPLETE to the base state once a missing record arrives FINAL and clean. Arming stayed
  blocked meanwhile, and that case's credit stays withheld. This matches "missing coverage blocks credit and further arming".

## S4. Commands and results (rc3)

| Command | Result |
|---|---|
| Identity script: delta, packageHash rule, manifest entries, rc2→rc3 diff | 1 changed / 20 added / 0 removed; `f987d968…` both ways; exactly the 7 declared files |
| `shasum` of the manifest, checks receipt and 13 logs; rc1/rc2 artifacts | all match; history unchanged |
| `npm run typecheck`; `npm run api:build` + `diff -rq dist` (copy) | pass; identical |
| `cli.ts artifact-check` (copy) | `ok:true`, `drift:[]`, 1974 files |
| `node --test tests/reval-instrument-*.test.ts` | 13/13 |
| `node --test tests/*.test.ts` (copy with a git marker) | 567 tests: 558 pass, 8 fail (the known RC5 identity-only set), 1 skipped |
| `tests/pg/reval-instrument-e2e.pg.test.ts` (Docker PG17) | 3/3 (ARM 9 ms, READY 0 ms) |
| `ATLAS_REVAL_NATIVE_PG_FIXTURE=… tests/pg/reval-native-instrument.pg.test.ts` | 1/1: TERMINAL_INCOMPLETE, ASK_REMOTE_UNAVAILABLE, NO_DISPATCH, charged 0 |
| Independent N1 probe (11 rows) | as in S2 |
| My 8 mutations of `run.ts`/`transfer.ts` (each restored and compared with `cmp`) | 8/8 detected |
| `atlas*` census, before and after | identical; no process left |

I did not re-run the full `test:pg`, `db:check:*` or `api:smoke`. The delta adds no prisma, server or browser file, and the
receipt's logs hash-match (771/771).

## S5. Residuals (carried, unchanged)

- T2: the two instrument sockets are proven separately, not tied to one process.
- The provider-key pass-through is a PENDING owner decision.
- admission, capability, stage and consent remain ATTESTED.
- macOS fsync is not `F_FULLFSYNC`.
- The RS-C-A `nextAck` timer classification bug (fail-closed).
- N1 from the RS-C-A review.
- The "swept versus expired uncollected" OBSERVATION_UNAVAILABLE ambiguity (fail-closed; needs a protocol distinction).
- Optional: binding the receipt to C's IDENTITY `buildManifestSha256`.
- RS-C-C: a sealed build inventory, routing for `scripts/reval-instrument/`, the manual "Send evaluation evidence" button, the
  200-path E2E and the NB7 rehearsal.
- RS-D: the POST census, PROCESS_CENSUS/DRAIN, and the egress and privacy proofs.
- No paid or provider call, activation, account, data or budget admission is implied by this acceptance.
