# RS-D implementation report — part C (integration, final instrument revision, offline rehearsal/runbook), rc1

Implementer: native `claude-opus-5-5` (Claude Code session), 2026-10-13. Brief: `IMPLEMENTATION_BRIEF_C.md` (rc1). Not an approval.
Gate: ONE independent native Opus 5.5 `max` review in a clean session (owner instruction); the project's Sol/Opus `xhigh` and
Astra/Fable gates are NOT run (recorded deviation). No paid/provider call, activation, account, customer data or deployment; the key
pass-through stays PENDING; no root/admin host change; frozen 01–06, accepted seals/manifests and migrations untouched.

## 1. What changed
- **Final instrument revision** (`scripts/reval-instrument/identity.ts`, `candidate.ts`): the RS-D-B rc2 manifest + seal are pinned
  (anchors, seal status `ACCEPTED_RS_D_B_RC2`, expected map, administrative deltas, accepted-later overlay rule); candidate layer
  `RS-D-C`. The identity test is seal-aware (RS-D-B `knownPostSealTestState` closed): `accepted` must equal "the part's matching seal
  exists" — the post-seal failure of RS-D-B is gone and cannot recur.
- **Sealed build inventory** (`build-inventory.ts`, `verification/stage5/S5ASKREMOTE_REVAL_RSD_BUILD_INVENTORY.json`): every output
  rebuilt from an accepted RS-B … RS-D-B `apps/api|packages` source (minus RS-D-C candidate outputs) and the sealed measured console
  manifest, with its sha256; closed schema, sorted, unique. The identity now PINS them (`BUILD_DRIFT`; a wrong set is
  `BUILD_INVENTORY_MISMATCH`) instead of only recording a digest. The inventory is a candidate path, so the RS-D-C seal seals it.
- **Receipt v6** (`receipt.ts`, `run.ts`): `build` = C's registered build digest from IDENTITY (I→C, allowed by 06), asked ONCE per run
  (first GO or first `proofs`; rc2); every recorded platform proof must name the same build (refused at take time; receipt unsafe
  otherwise); proofs without a build are unsafe.
- **Pair refresh** (`run.ts`, `operator.ts` `pair-ack`; found by the rehearsal, §2; bound fixed in rc2): a GO is refused before
  consumption (`BLOCKED_PAIR_REFRESH_REQUIRED`) once the pair's guaranteed life (from the owner's PAIR_ACK) cannot cover one case.
- **Swept vs expired-uncollected** (carried since RS-C-B; 06 frozen): an expired-uncollected record grows S's sticky
  `uncollectedTerminalCount`; the PRE census sees it before consumption and stops with `TERMINAL_EXPIRED_UNCOLLECTED` (its own reason,
  `effective` CENSUS_UNVERIFIED), while a swept FINAL record (collected, then removed) stays a normal path.
- **F_FULLFSYNC** (carried): measured — `tests/reval-fsync.test.ts` interposes `fcntl`/`fsync` (DYLD, ad-hoc-signed Homebrew node) and
  shows that C's journal append and the receipt writer (`durableWrite`, extracted from `writeReceiptV6`) issue `fcntl(F_FULLFSYNC)`
  for every durability point (libuv 1.52), never a plain `fsync()`. The stale "residual" comments are corrected.
- **S profile** (`platform.ts`, `server-link.ts`, `deps.ts`; RS-D-B rc2-N1/N3/N4): outbound unix sockets only to the exact
  `<socketDir>/.s.PGSQL.<port>` (path literal); S cannot write the owner config file, C's journal or C's instrument socket; policy ref
  `rsd-seatbelt-s-v2`. `ServerLink` receives the config path (the handoff socket is derived from it); `spawnServer(config, configPath)`.
- **RS-D-B rc2-N5/N6**: logging-scope wording; a PG test that a (role, ALL databases) override of S's or C's role is counted.
- **RS-C-C review N2** (`apps/api/src/reval/evaluation.ts`): on `/operator` paths the evaluation-header refusal now carries the
  console security headers and applies the exact-Host gate first (421 for a rebinding or duplicated Host). RS-C-C N5 is closed by
  the versioned receipts (v4/v5/v6).
- **Integrated offline rehearsal** (`tests/pg/reval-rehearsal.pg.test.ts`, generalized `tests/support/reval-segment-entry.ts`, shared
  `tests/support/reval-segment-harness.ts`): see §2.
- **Docs**: brief C, this report, `rs-d/REVAL_RUNBOOK.md` (RS-D-C end-to-end procedure, stops, pending limitations; RS-D-B profile
  text updated), `rs-c/INSTRUMENT_RUNBOOK.md` (receipt v6, new stops), routing files.

## 2. Integrated offline rehearsal (05 RS-D)
`tests/pg/reval-rehearsal.pg.test.ts` (`ATLAS_REVAL_REHEARSAL=1`; darwin/arm64; Docker PG17 = regression evidence) drives the real O (PTY)
→ C → S (BUILT bridge server under the pinned profile, the accepted OFFLINE scripted provider seam — no key, no network) chain and the
real instrument code (`tests/support/reval-segment-entry.ts`, now one generalized driver for the RS-D-A segment test and this run) through
the WHOLE grouped order. Result (implementer run, 2026-10-13, 2687 s; the evidence run of the checks 2693 s): 200 cases in 11 segments (FX07 13, FX05 19, FX10 15, FX02 26,
FX03 22, FX09 20, FX11 17, FX04 21, FX01 21, FX08 12, FX06 13), 10 boundaries with S and C up (both refusals each time, closure,
DRAIN QUIESCENT INTACT by I and by O, END_PAIR, switch to generation 11, FIXTURE_CHECK, resume, re-PAIR), one mid-segment re-pair, ONE
guard epoch, every case census MATCH + COMMITTED handoff + FINAL record + casePass, 12 proofs (process COMPLETE, destinations UNKNOWN,
privacy UNKNOWN on this PG, matches 0, never a verified zero), receipt v6 bound to C's registered build, final RC5 state
COMPLETE_PENDING_REVIEW, no flag upgraded, C opened only the reader credential file (fs-level spy).

**Found by the rehearsal and fixed in rc1 (before review).**
- The driver expected the last case to leave the run ACTIVE; RC5 completes the run with it (COMPLETE_PENDING_REVIEW). Driver fixed.
- A ~7-minute host stall (the owner reported a network outage) let the browser pair expire (04: a pair lives ≤ 10 min after the browser
  PAIR); the next GO consumed a case and failed ARM with PAIR_UNAVAILABLE (fail-closed, run stopped). This exposed a real operational
  gap: a MANUAL segment lasts far longer than 10 minutes and nothing re-paired inside a segment, so a real run would burn a case per
  long segment. Fixed (bound corrected in rc2, review F3): the instrument refuses a GO (`BLOCKED_PAIR_REFRESH_REQUIRED`, before any
  consumption) once the pair's guaranteed life cannot cover a case, the runbook describes the in-segment re-pair (owner `end-pair` +
  `pair`, browser PAIR, `pair-ack`; no confirm), and the rehearsal forces one in-segment re-pair (and re-pairs proactively after 5.5
  minutes) through the real chain.

**Rehearsal fidelity (rc2, review N4).** The instrument is the `MeasuredRun` API under a test driver (not the `cli.ts`/`operator.ts`
TTY); S is the test server entry (Docker TCP seam + the scripted offline provider); the fixture switch is the library `install` (not
`maintain.ts`); policy activation is test SQL; the browser is played over loopback HTTP; `BLOCKED_PAIR_REFRESH_REQUIRED` itself is not
reached (the driver re-pairs proactively). Those pieces are covered elsewhere: the native chain (production O/C/`main.js` + `cli.ts` +
`maintain.ts`), the 200-path browser E2E and the unit tests.

## 3. Pending limitations (declared)
- **T2**: the instrument's control and handoff sockets are not tied to one I process — needs an extension of the frozen 06 frames.
- No verified zero on darwin; provider egress needs a host-level layer (PENDING key decision); privacy proof incomplete by design;
  on a default PG `collectionState` is UNKNOWN (the rehearsal's Docker PG17 shows exactly that).
- D1 evaluation-validity residual; human label attestation and the owner data/budget admissions are separate gates.
- **S profile limit** (rc3, review F5; owner decision): the profile is an egress floor plus direct-path denies under `(allow default)`,
  not the containment of a compromised S — same uid, so S can rewrite user-owned files that unsandboxed C/E/V execute later (node
  toolchain and libraries, shell/launchd startup files). Closing it needs an allow-list write profile, protected toolchain prefixes
  or a separate uid for S.

## 4. Checks
Evidence `verification/stage5/S5ASKREMOTE_REVAL_RSDC_RC1_EVIDENCE/`, summary `…_RSDC_RC1_CHECKS.json` (2026-10-13T08:21–09:36Z).
| Check | Result |
|---|---|
| typecheck, ui:typecheck, schema:validate, api:build (both consoles), api:smoke, db:check:pg17, db:check:drift | pass |
| `build-inventory.ts --check` | the sealed inventory equals the outputs of a fresh `api:build` (44 outputs) |
| `cli.ts artifact-check` | ok, drift [], candidate RS-D-C `86e5f7b8…` accepted:false |
| unit (`tests/*.test.ts`) | 616: 607 pass, 8 fail (exactly the pre-existing RC5 identity-only set, diffed), 1 skipped — the RS-D-B post-seal identity failure is gone |
| `test:pg` (Docker PG17 + native unix PG17) | 781: 780 pass, 1 skipped (the rehearsal file without its flag); no throwaway DB left |
| integrated rehearsal (`ATLAS_REVAL_REHEARSAL=1`) | pass, 2693 s — §2 |
| `test:ui` with `ATLAS_REVAL_E2E_200=1` | 90 passed (21.9 min); 200 COMMITTED, semantic MATCH, FX10 MISSING 15 |
| mutations (`mutations.txt`, harness `mutations-harness.py`) | 25/26 detected |

Mutation survivor (qualified): **D07** (the RS-D-B seal's status/manifest cross-check skipped) — the seal bytes are pinned by their
sha256 anchor, so a seal with another status cannot be presented without RSDB_SEAL_DRIFT first; the cross-check is a redundant layer, as
for the earlier seals. D20–D22 (the console refusal in S) first "survived" because the console test runs the BUILT S and the harness had
not rebuilt `dist/`; re-run with a rebuild per mutation they are detected (both runs are in the evidence).

## 5. Residuals
- The build inventory pins outputs rebuilt from accepted sources in THIS tree (tsc output is deterministic; a different compiler or
  config changes the bytes and is BUILD_DRIFT, fail-closed). It cannot prove what a running process loaded (`loadedBinding`
  UNVERIFIED stays).
- IDENTITY's build digest is C's own computation over the accepted tree (not a measurement of S's loaded image).
- `TERMINAL_EXPIRED_UNCOLLECTED` relies on S's own sticky counter (S's self-measurement inside its trust boundary).
- The F_FULLFSYNC evidence is for this host's file system and Node/libuv build; another file system may fall back (the test would show
  F_BARRIERFSYNC/fsync).
- The rehearsal is regression evidence on Docker PG17 with the scripted offline provider; it is not an R-EVAL run and admits nothing.

## 6. rc2 repairs (review `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSDC_RC1.md`, CHANGES_REQUIRED: F1–F4 Low)
- **F1** (S lost between cases was only retryable; the GO-time IDENTITY could itself end S): C's IDENTITY is asked ONCE per run (C computes
  its build digest once at startup — N1; `BUILD_CHANGED` removed as unreachable), and C's continuity-loss answers (IDENTITY_UNVERIFIED /
  IPC_LOST) to that IDENTITY and to the previous-terminal re-collection are the persisted `CENSUS_CONTINUITY_LOST` stop (RS-D-A rc2 F3);
  other failures stay retryable. Tested with a consistent lost-S fake (first GO, after a case, `proofs`); runbooks aligned.
- **F2** (the identity test would fail after the RS-D-C seal): the candidate-layer block asserts the unsealed behaviour on a view without
  the seal and the sealed behaviour on a simulated matching seal — both every time. Verified with a temporary simulated seal on disk
  (2/2 pass; the file removed).
- **F3** (7 min after `pair-id` did not keep the pair alive through the case): the operator pastes the owner's PAIR_ACK (`pair-ack`); the
  pair lives at least until `expiresAt` − PAIR_NONCE_MS + PAIR_MAX_MS whatever the typing delay, and a GO is refused once less than
  `CASE_PAIR_RESERVE_MS` (200 s: GO, 26 s arm window, 120 s slot, 2 s handoff, margin) remains. Re-entering the same ack does not
  extend it (N3). The runbook says the RESPONSE must be sent before the pair ends.
- **F4** (rename bypass of the S write-denies; untested wiring): the profile also denies writes on the config directory and every
  ancestor but `/` (renames/removals), measured under the real profile (config-dir and ancestor rename EPERM, hard link to the journal
  EPERM, S's own socket inside still binds), built through the production `serverSandboxPaths`; a test asserts that
  `productionDeps().spawnServer` puts THIS config path's profile on the sandbox-exec argv.
- **N2** `proofs`-first test (IDENTITY before the first proof, binding persisted before the proof). **N5** docs: the build comes from
  IDENTITY; `launch.ts` is not changed in this part; durations; `receipt.ts` header v6; operator banner RS-D-C. **N6** four
  `dist/scripts/ask-remote-eval` outputs are outside the identity; nothing at runtime loads them (S's import graph does not reach them;
  C/V/E/O run TS sources).

**rc2 checks.** Evidence `verification/stage5/S5ASKREMOTE_REVAL_RSDC_RC2_EVIDENCE/`, summary `…_RSDC_RC2_CHECKS.json`
(suite 2026-10-13T10:54–12:10Z, then the PG re-runs).
| Check | Result |
|---|---|
| typecheck, ui:typecheck, schema:validate, api:build, api:smoke, db:check:pg17, db:check:drift | pass |
| `build-inventory.ts --check` | the sealed inventory equals a fresh `api:build` (44 outputs) |
| `cli.ts artifact-check` | ok, drift [], candidate RS-D-C `c6ed0a19…` accepted:false |
| unit | 618: 609 pass, 8 fail (the same RC5 identity-only set as rc1, diffed), 1 skipped |
| `test:pg` | 781: 772 pass, **8 fail**, 1 skipped — NOT a clean pass (below) |
| PG re-run of the 5 failing files, sequential, after `test:ui` | 29: 28 pass, 1 fail (`reval-eval-e2e` one case) |
| `reval-eval-e2e` repeated (test alone; file alone ×2; after `reval-closure`) | 4/4 pass |
| integrated rehearsal | pass, 2680 s: 200 cases, 11 segments, 10 boundaries, 2 in-segment re-pairs via `pair-ack`, one guard epoch, 12 proofs, COMPLETE_PENDING_REVIEW |
| `test:ui` with `ATLAS_REVAL_E2E_200=1` | 90 passed (21.9 min); 200 COMMITTED, semantic MATCH, FX10 MISSING 15 |
| mutations | 34/35 detected (22 rc1 mutations whose rules remain + E01–E13 for the rc2 rules; D10/D16 targeted the removed `BUILD_CHANGED`, D25/D26 the replaced pair-id bound); D07 survives as in rc1 |

`test:pg` failures: the 8 are bounded-latency refusals (`FAILURE DEADLINE`; `CENSUS_UNAVAILABLE` at a first FIXTURE_CHECK) in
`reval-closure` (executor lifetime), `reval-eval-e2e` (one case), `reval-fixture-check` ×4, `reval-launch-controls` (R1) and
`reval-launch` (real PTY). The host load average was 5.7–7.2 and the Docker VM ~134 % CPU; all passed in rc1 and in the focused rc2
run. Re-run sequentially, 7 pass. The `reval-eval-e2e` one-case test failed again at load ≈ 5–6 right after `test:ui`, then passed
4/4 at lower load. Residual: its first FIXTURE_CHECK (cold reader connect within the 1800 ms budget) is load-sensitive on this
host. RS-D-C does not change that path (`fixture-check.ts`, `snapshot-reader.ts`, `physical.ts` equal the baseline; the
`controller.ts` changes are the `processInventory` move and the `ServerLink` config path).

## 7. rc3 repair (rc2 re-review in the same review file, CHANGES_REQUIRED: F5 Medium)
- **F5** (a compromised S could still bypass the path denies by renaming a directory ABOVE a protected path: read the owner password
  through a renamed `<cfg>/secrets`, replace the helper through a renamed project parent): `serverSandboxPaths` now names, as
  write-denied literals, every ancestor (but `/`) of every named file (helper, the three credential files, the config file, C's
  journal and instrument socket) and of the project root; ancestors inside the project tree stay covered by its subpath rule (no
  duplicates). Measured under the REAL profile (`tests/reval-platform.test.ts`): renaming the credential subdirectory (then reading
  through the new name), the helper's own directory and the project root's parent are EPERM; without the profile the same probe does
  all three. Mutations F01 (only the config path's ancestors, the rc2 rule), F02 (the project root's ancestors dropped) and F03 (the
  in-tree filter dropped) are detected. Policy ref stays `rsd-seatbelt-s-v2`: the RS-D-C candidate's profile, not yet sealed.
- The remaining limit is stated, not implemented (owner decision): §3 "S profile limit", the profile header in `platform.ts` and
  `REVAL_RUNBOOK.md` (RS-D-B paragraph and "Ожидающие ограничения"). Optional re-hash of the helper before each spawn: not done — it
  would race the exec by path (no fd exec in node); with the ancestor denies S cannot replace the helper.
- **N8** `receipt.ts` header (one IDENTITY per run) and the INSTRUMENT_RUNBOOK sentence case. **N7** (IDENTITY_UNVERIFIED while S is
  still launching → a false persisted stop) not changed: unreachable as the reviewer notes (`pair-ack` needs a READY S before any
  `proofs`/GO). **N9** (pre-existing 1 ms receive timeout near an operation's deadline) recorded for a later part.

**rc3 checks.** Evidence `verification/stage5/S5ASKREMOTE_REVAL_RSDC_RC3_EVIDENCE/`, summary `…_RSDC_RC3_CHECKS.json`
(suite 2026-10-13T13:01–14:17Z, then D18 and the PG re-run).
| Check | Result |
|---|---|
| typecheck, ui:typecheck, schema:validate, api:build, api:smoke, db:check:pg17, db:check:drift | pass |
| `build-inventory.ts --check` / `cli.ts artifact-check` | pass (44 outputs) / ok, drift [], candidate RS-D-C `c7cb5f9b…` accepted:false |
| unit | 618: 609 pass, 8 fail (the same RC5 identity-only set, diffed), 1 skipped |
| `test:pg` | 781: 775 pass, **5 fail**, 1 skipped — NOT a clean pass (below) |
| sequential re-run of the 4 failing files (load ≈ 5.1) | 19/19 pass |
| integrated rehearsal (S under the rc3 profile) | pass, 2709 s: 200 cases, 11 segments, 10 boundaries, 2 in-segment re-pairs, one guard epoch, 12 proofs |
| `test:ui` with `ATLAS_REVAL_E2E_200=1` | 90 passed (21.8 min); 200 COMMITTED, semantic MATCH, FX10 MISSING 15 |
| mutations | 37/38 detected: F01–F03 (rc3 rule), E09/E10/D18 in their rc3 form; D07 survives as before. D18 first did not run (rc2-form pattern; the harness did not print such skips — fixed) and was run separately |

`test:pg` failures (bounded-latency refusals, load ≈ 5–6): `reval-eval-e2e` one case (first FIXTURE_CHECK), `reval-fixture-check` ×2
(generation-change cases), `reval-launch` IDENTITY re-proof (PTY wait timeout), `reval-native-instrument` (FIXTURE_CHECK `FAILURE
DEADLINE`). All pass on the sequential re-run at a similar load: intermittent, latency-bounded, as accepted in the rc2 re-review.
There is still no clean full `test:pg` run on this host in evidence.
