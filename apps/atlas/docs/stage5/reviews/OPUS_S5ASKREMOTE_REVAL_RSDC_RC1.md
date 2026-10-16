# Independent checkpoint review — S5ASKREMOTE-REVAL-SERVER-RSD-C rc1 (RS-D part C: final instrument revision + sealed build inventory, receipt v6, swept-vs-expired, F_FULLFSYNC, S-profile hardening, RS-C-C N2, pair refresh, integrated offline rehearsal, final runbook)

Date 2026-10-13. Reviewer: native Claude `claude-opus-5-5`, launched through the Claude Code Agent tool with a fresh context at the
requested effort `max` (the effort setting cannot be confirmed from inside the session). Gate: owner instruction — ONE independent
Opus 5.5 `max` review per RS-D part (recorded deviation from the Sol/Opus `xhigh` and Astra/Fable gates; not re-judged here).
Disclosure: my scratchpad is the host session's directory (`d0382327-…`), which also holds implementer/earlier-reviewer files. To look
for a byte-exact copy of the baseline sources (none found) I hashed every file under `/private/tmp/claude-501/-Users-oleksandr-atlas-v1-1-3/`
(bytes read only for hashing, nothing opened for content); my own files are all in `scratchpad/rsdc-review/`. The session's
auto-loaded user memory contained the implementer's short RS-D-C status notes (hash prefixes, gotchas); I used none of it as evidence
and re-derived every result below. No implementer conversation and no verdict of another reviewer on this artifact were available.

Verdict (rc1): CHANGES_REQUIRED

Four Low findings, all small to fix: (F1) S continuity loss between cases is still never a persisted stop in the real chain, and the
new GO-time IDENTITY makes this worse — it regresses the accepted RS-D-A rc2 F3 fix on the first-GO and `proofs` paths, and it can
itself kill S; (F2) the identity test is only partly seal-aware and will fail by design once the RS-D-C seal exists (the RS-D-B
`knownPostSealTestState` repeats, now in the FINAL revision); (F3) the 7-minute pair-refresh bound is not sound against 04's 10-minute
pair plus S's arm window and 120 s slot; (F4) the new S write-denies (config file, C's journal, C's instrument socket) can be bypassed
by renaming the config directory or one of its ancestors (demonstrated under Seatbelt), the docs claim more than holds, and the
production wiring of the config path into the profile has no detecting test.
Everything else checked holds: package/candidate identity, RS-D-B pinned exactly, candidate layer complete, sealed build inventory
exact, closed, sorted and reproducible, accepted outputs pinned, receipt v6 schema with constant flags, TERMINAL_EXPIRED_UNCOLLECTED
before consumption and distinct from a swept record, F_FULLFSYNC measured on the production write paths, the exact PG socket literal
(native unix-socket chain still works), RS-C-C N2, RS-D-B rc2-N2/N4/N5/N6, and a strong 200-case integrated rehearsal whose evidence
matches the final tree.

## Identity (recomputed)

| Item | Result |
|---|---|
| Baseline `S5ASKREMOTE_REVAL_RSDC_BASELINE.sha256` | sha256 `98ec0568…5c4d` = manifest `baselineFileSha256`; 2219 entries |
| Completeness (`git ls-files -co --exclude-standard` vs baseline) | exactly the 33 changed + 7 added manifest files (+ the excluded RSDC receipts/baseline); 0 removed; every per-file baseline and current hash equals the manifest |
| **packageHash** (manifest rule) | **`951f92e2c7b02bd1d091c3eefab8bb4af02f68eda19f269a8a13c653386bc4ba`** — recomputed from disk; every file I mutated was restored byte-exact (sha256 verified) |
| Manifest / checks / inventory files | `04bca671…3131` / `3493a40b…01a8` / `b1559d17…b2a2` (44 outputs); all 18 evidence logs match `logs` |
| Evidence window 08:21:48Z–09:36:43Z | after the last source/test edit (`candidate.ts`, inventory 08:21:20Z, restored mutation targets ≤ 08:21:14Z, mtimes read before my own mutations, whose byte-exact restores refresh mtimes only); only the report was written later (09:37Z) |
| `cli.ts artifact-check` (my runs) | ok, drift [], 2089 files, 2045 expected; candidate RS-D-C **`86e5f7b873446e1fa4a38f71dafc889bc456546250d4a81d88b0ea6bf1960895`**, accepted:false; anchors `rsdbManifest 45d5df36…` / `rsdbSeal dc4dd7fe…` equal the files; the RS-D-B seal names that manifest with `ACCEPTED_RS_D_B_RC2`, no admin deltas |
| Fresh `npm run api:build` | all 355 `dist/` files byte-identical before/after; `build-inventory.ts --check` exit 0 |

## Findings (required)

**F1 — Low (regression of the accepted RS-D-A rc2 F3) — S lost between cases is a retryable `BLOCKED_*` forever; the documented
persisted stop is unreachable, and the GO-time IDENTITY can itself kill S.**
`scripts/reval-instrument/run.ts:144-152` (`#bindBuild` maps EVERY IDENTITY failure to `BLOCKED_C_IDENTITY_<code>`), `:310-311` (IDENTITY
now runs BEFORE the PRE census that carries the F3 rule, `:313-314`), `:195` (`proofs`), and the pre-existing `:251-261` (previous-terminal
re-collection: C's `IPC_LOST` → `BLOCKED_PREVIOUS_TERMINAL_IPC_LOST`). The real C answers, when S is LOST: IDENTITY → FAILURE
`IDENTITY_UNVERIFIED` (`packages/reval/server-link.ts:145`, `controller.ts:233`), TERMINAL_OBSERVATION and PROCESS_CENSUS → FAILURE
`IPC_LOST` (`eval-controller.ts:45,111-112`). Probes (scratch copy of the unit rig, C answering exactly that): first GO of a run →
`BLOCKED_C_IDENTITY_IDENTITY_UNVERIFIED`, armStop null, effective ACTIVE; with only the RS-D-C IDENTITY line removed the same GO is
`BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST`, effective TERMINAL_INCOMPLETE/CENSUS_UNVERIFIED (the RS-D-B behaviour) → regression; after a
case → `BLOCKED_PREVIOUS_TERMINAL_IPC_LOST` on every retry (pre-existing since RS-D-A rc2, whose probe kept TERMINAL_OBSERVATION answering);
`proofs` → `BLOCKED_C_IDENTITY_…`. In addition, C's IDENTITY kills S whenever the reader recheck fails or stalls past ≈1.5 s
(`controller.ts:235-239`; accepted R1 test `reval-launch-controls.pg.test.ts:58`), and the instrument now calls it before each of ≈212
GO/`proofs` per run — a PG hiccup ends the run in exactly this unrecorded state. The RS-D-C unit test asserts the retryable code for
`IDENTITY_UNVERIFIED` (`tests/reval-instrument-run.test.ts:220-221`); `rs-c/INSTRUMENT_RUNBOOK.md:25-27` (a candidate file of this part)
promises `BLOCKED_ARM_STOPPED_CENSUS_*` "записана в квитанцию" for exactly this loss, while `rs-d/REVAL_RUNBOOK.md:229` says "повторить".
Nothing is consumed and no credit is possible, but 04 ("Loss of … process identity stops that run") and the receipt disagree.
**Fix:** treat C's continuity-loss answers — FAILURE `IDENTITY_UNVERIFIED`/`IPC_LOST` to IDENTITY (go and `proofs`) and FAILURE `IPC_LOST`
to the previous-terminal re-collection — as the persisted `CENSUS_CONTINUITY_LOST` stop (keep `DEADLINE` and other codes retryable);
test with a CONSISTENT lost-S fake (all three operations failing as C really answers) incl. the first GO and `proofs`; align both runbooks.
(Optionally reconsider whether every GO needs the S-re-proving IDENTITY, or state the exposure.)

**F2 — Low — the identity test fails by design after the RS-D-C seal (brief §1.1, RS-D-B `knownPostSealTestState`).**
`tests/reval-instrument-identity.test.ts:85-88`: for a flipped candidate path it asserts `c.snapshot.ok === true` and reads
`c.revision!.candidate`. With the seal on disk the flip is `CANDIDATE_SEAL_MISMATCH` and `revision` is null. Simulation (reader overlaying a
seal `{status: ACCEPTED_RS_D_C_RC1, candidateSha256: 86e5f7b8…}`): base ok, accepted:true; flipped `identity.ts` / `build-inventory.ts`
→ ok:false, drift `CANDIDATE_SEAL_MISMATCH`, revision null → the test throws. Only `:84` was made seal-aware. This is the FINAL revision,
so after sealing no later part can repair it (the unit suite would be back to 9 failures for good). **Fix:** before the seal, branch the
candidate-change block on the seal — without a matching seal: recorded (ok, digest changes, identity changes); with it: drift
`CANDIDATE_SEAL_MISMATCH` — e.g. evaluate the recorded-layer assertions over `overlay(CANDIDATE_SEAL, null)` and assert the sealed
behaviour separately; then simulate the post-seal state in the test itself (as above) so both states run every time.

**F3 — Low — the pair-refresh bound (7 min after `pair-id`) does not keep the pair alive through the case it admits.**
`scripts/reval-instrument/run.ts:52-53,302`; `rs-d/REVAL_RUNBOOK.md:209-212`; `rs-c/INSTRUMENT_RUNBOOK.md:12-15`. The comment reasons about
"≥ 2 min … for the GO window", but S burns a non-committed slot the moment the pair lapses (`packages/reval/eval-state.ts:84,95`) and the
RESPONSE/transfer need the pair (`eval-handoff-route.ts:102`, `eval-runtime.ts:166,198`). Worst case allowed by the runbook: browser PAIR
T, `pair-id` T+60 s, GO T+480 s, click up to the 26 s arm window, slot 120 s after the claim, 2 s handoff → COMMIT as late as ≈T+628 s
> T+600 s → `LOCAL_HANDOFF_UNVERIFIED`, a consumed case without credit — the very loss the rc1 fix targets. (Sound only if `pair-id` is
typed within ≈30 s; the rehearsal's own driver re-pairs at 6.5 min with zero typing delay, `tests/support/reval-segment-entry.ts:122`.)
**Fix:** derive the bound from the worst case (10 min − pair-id allowance − GO overhead − 26 s − 120 s − 2 s − RESPONSE margin, e.g.
6 min with a 60 s allowance), or better bind it to the owner's PAIR_ACK `expiresAt` (nonce expiry; the pair ends ≤ that + 10 min) instead
of the typing time; say in the runbook that the RESPONSE must be sent before the pair's `expiresAt`; adjust the unit test.

**F4 — Low — the RS-D-C S write-denies (config file, C's journal, C's instrument socket; RS-D-B rc2-N3) are bypassable, the docs
over-claim, and the production wiring is untested.**
`packages/reval/platform.ts:35-41,51` denies only path literals. Under `/usr/bin/sandbox-exec` with the same rule shape (my probe,
scratch dir): writing/unlinking/renaming the journal literal → EPERM, but `rename(<cfg>, <cfg2>)` → OK, append through the new path → OK,
rename back → OK: the journal ends `journal|TAMPERED|`. Adding a literal deny on the config directory blocks that rename while S can still
create its handoff socket entry there (create in dir → OK), but renaming a user-writable ancestor (`<top>` → `<top2>`) still bypasses it.
Impact is limited (C never reads its journal back; the instrument receipt lives outside the config dir; a tampered config fails closed),
but `REVAL_RUNBOOK.md:144-146`, `IMPLEMENTATION_REPORT_C.md:29`, brief §1.6 and `platform.ts:19` state "S cannot write …". Separately, the
production `deps.ts:73` passing `configPath` into the profile has no detecting test: mutation `configPath` → `config.server.apiEntry`
SURVIVED the only production-deps test (`tests/pg/reval-native-instrument.pg.test.ts`, 1/1 pass). **Fix:** either deny `file-write*` on
the literal of the config directory AND each ancestor (realpaths) — test under a real profile that rename attempts are EPERM and the
handoff socket still binds — or restate the claim as "direct writes only" with the rename residual; and add a detecting test for the
production wiring (e.g. `productionDeps().spawnServer` with a captured argv/profile).

## Notes (optional)

- **N1** `BUILD_CHANGED` cannot fire inside one instrument session: C computes its digests once at startup (`controller.ts:101-103`,
  IDENTITY returns that value) and `connect` is once per session (`operator.ts:115`). The value of v6 is the receipt binding; a mid-run
  rebuild is caught by `identityHolds` (inventory/candidate), not by `BUILD_CHANGED`. Fine as defence in depth; worth one sentence.
- **N2** Two survivors in `tests/reval-instrument-run.test.ts`: R-M2 (no IDENTITY before `proofs`) and R-M3 (first build binding not
  persisted). Tests always bind via a GO first; add `proofs` as the first operation (the runbook order) and a persist assertion.
- **N3** Re-entering the SAME `pair-id` resets the 7-minute clock (`run.ts:103`) without any re-pair; refuse an unchanged id or use the
  PAIR_ACK expiry (F3).
- **N4** Rehearsal fidelity (honest in substance, but say it): I is the `MeasuredRun` API under a test driver (not `cli.ts`/`operator.ts`),
  S is the test server entry (Docker TCP seam + scripted provider), the switch is the library `install` (not `maintain.ts`), policy
  activation is test SQL, the browser is played over HTTP, and `BLOCKED_PAIR_REFRESH_REQUIRED` itself is never reached (proactive re-pair).
  Those pieces are covered elsewhere (native chain: production O/C/`main.js` + `cli.ts` + `maintain.ts`; 200-path UI E2E). Assertions are
  strong (all 200 credited in the grouped order, MATCH/COMMITTED/FINAL per case, one epoch, 10+1 QUIESCENT drains with closure tuples,
  12 proofs, build = registered digest, C opens only the reader secret, run COMPLETE_PENDING_REVIEW, flags constant).
- **N5** Docs: brief §1.3 says the build comes "from the first PRE snapshot" (the code uses IDENTITY; I's SNAPSHOT has no build field);
  report §1 lists `launch.ts` as changed (it is not); report §2 quotes a 2687 s run, the evidence run is 2693 s; `receipt.ts:1` still says
  "Receipt v5"; `operator.ts:30` banner still says "(RS-D-B)".
- **N6** Four outputs of accepted offline sources (`dist/scripts/ask-remote-eval/{dataset,expected-facts,fixtures,predicates}.js`) are
  outside the identity; the static import graph of `dist/apps/api/src/main.js` (151 files) does not reach them and C/V/E/O run TS
  sources, so no gap today. The 47 measured-console assets are pinned transitively (manifest pinned; S verifies each asset hash at load).

## What I checked and how

- Identity: package hash, completeness, per-file hashes, evidence log hashes (script in `scratchpad/rsdc-review/pkg.py`); artifact-check;
  RS-D-B anchors vs files and seal content; expected-map/rebuilt/candidate coverage of all 355 `dist/` files (`coverage.py`); a fresh
  `api:build` byte-identical; `build-inventory.ts --check` exit 0; the inventory = exactly the 44-path rebuilt set (my recomputation).
- Candidate completeness: appending one byte to `packages/reval/eval-drain.ts`, `tests/reval-proofs.test.ts`,
  `rs-d/IMPLEMENTATION_REPORT_B.md` (chain files outside the list) → `SOURCE_DRIFT` each; restored (sha verified).
- Seal-aware test: post-seal simulation (`sealprobe.ts`) → F2.
- Run/receipt/S/C code read in full where changed (`identity.ts`, `candidate.ts`, `build-inventory.ts`, `run.ts`, `receipt.ts`,
  `operator.ts`, `platform.ts`, `server-link.ts`, `evaluation.ts`, `eval-journal.ts`, `privacy-scan.ts`, relevant C/S paths).
- Tests run: focused unit files (fsync, identity, run, platform, census, handshake) 29/29; full unit suite 616: 607 pass, 8 fail (the
  pre-existing RC5 set, identical to the RS-D-B rc2 evidence), 1 skipped; `reval-native-instrument.pg` (production chain under the exact
  PG socket literal) pass; `reval-eval-console.pg` 3/3; `reval-segments.pg` (real O/C/S under the profile + instrument, boundary with
  S/C up, receipt v6) pass in 188 s.
- Mutations (one line at a time, restored, sha-verified; the console ones with `api:build` before the test and after restoring; `dist`
  byte-identical afterwards): D20 / D21 / D22 DETECTED (rebuilt S); D02, D09, D17, D25 DETECTED; R-M1 (production config path) SURVIVED
  (F4); R-M2, R-M3 SURVIVED (N2). D07 accepted as qualified: the RS-D-B seal bytes are pinned by their sha256 anchor and already name the
  manifest/status, so the cross-check cannot be reached by a test.
- Probes: lost-S rig probes and the regression probe (F1); Seatbelt rename probes (F4); pair-lifetime arithmetic against
  `eval-state.ts`/`eval-runtime.ts`/`eval-handoff-route.ts` (F3); F_FULLFSYNC test reads: it interposes `fcntl`/`fsync` in a child node
  that runs the production `TerminalJournal.save` and `durableWrite` (the function `writeReceiptV6` calls) — 2 + 2 F_FULLFSYNC, no plain
  fsync; I re-ran it (pass).
- RS-C-C N2: console refusal now sets the console headers and the exact single-Host gate (same semantics as `operator/http.ts`
  `hostAllowed`), absolute-form targets are already 421 in the first middleware; RS-D-B rc2-N1 (sibling socket EPERM in the real profile
  test), N2 (runbook), N4 (`rsd-seatbelt-s-v2`), N5 (wording), N6 (all-databases override test) present.
- Owner constraints: no frozen 01–06, seal, manifest, migration or RC5 instrument file changed; no provider/key path (scripted offline
  provider in the rehearsal; `bridgeRemoteSeams` unchanged); darwin/arm64 only; files ≤ 700 lines (largest 542).

## Residuals I accept

T2 (instrument sockets not tied to one I process — needs a 06 extension); no verified zero on darwin (Seatbelt denials not countable,
O/C/I/browser unenforced); provider egress needs a host-level layer on the target platform, tied to the PENDING key decision; privacy proof
incomplete by design; D1 order/fixture confound; `loadedBinding` UNVERIFIED and IDENTITY's build digest being C's own computation; the
inventory is compiler/tree specific (fail-closed); `TERMINAL_EXPIRED_UNCOLLECTED` relies on S's self-measured sticky counter; F_FULLFSYNC is
host/file-system specific; the rehearsal is Docker PG17 regression evidence with the scripted provider and admits nothing; D07.

## rc2 re-review (bounded, same reviewer session)

Date 2026-10-13, same reviewer session (native `claude-opus-5-5`, requested effort `max`). Input: manifest
`S5ASKREMOTE_REVAL_RSDC_RC2_MANIFEST.json` (sha256 `ea7a86e0…1e62`), checks `…_RC2_CHECKS.json` (`d324e38a…b13c`), report §6.

Verdict (rc2): CHANGES_REQUIRED

F1, F2 and F3 are closed, each with a detecting test that I re-ran and mutated. F4 is closed as I scoped it in rc1, but the same
rename technique still defeats the profile's other path denies. Under the REAL rc2 profile, a compromised S can read the owner DB
password when the credential files sit in a subdirectory of the config directory (the test-harness layout). It can also replace the
native helper at its runbook default location (`dist/native/reval-peer`), which unsandboxed C executes later. Separately,
`(allow default)` lets S rewrite the user-owned node toolchain that C's owner executor E runs. The final runbook still says S cannot
read the credential files or write the helper (new F5, Medium). Everything else checked holds. My rc1 F4 should have covered every
protected path, not only the journal; F5 is that missed scope.

### Identity (recomputed)

| Item | Result |
|---|---|
| **packageHash** (same rule/baseline) | **`46c6487f94608780da59aa65fca393557e2c602c8c4e91dca1b17d116ea1f444`** — 34 changed + 7 added, every per-file hash equal to the manifest, 0 removed; recomputed again after my mutations |
| rc1 → rc2 delta | 19 files changed (run/receipt/operator/candidate/platform, 9 tests, 4 docs, AGENTS) + `tests/pg/reval-nb7-rehearsal.pg.test.ts` added to the package; `identity.ts`, `deps.ts`, `controller.ts`, `evaluation.ts`, inventory unchanged since rc1 |
| `cli.ts artifact-check` | ok, drift [], candidate RS-D-C **`c6ed0a1934a6fd0bb397d890d684fefd39a0e6b1b65347a90bf9580694cec635`**, accepted:false (also after a fresh `api:build`: `dist/` byte-identical, `build-inventory.ts --check` exit 0) |
| Evidence | all 24 logs match `logs`; every package code/test file was last written before the window start 10:54:18Z, and only the report afterwards |

### rc1 findings

| # | Status | How I verified |
|---|---|---|
| F1 | **closed** | IDENTITY is asked once (`run.ts:165-176`). A FAILURE `IDENTITY_UNVERIFIED`/`IPC_LOST` to it, or to the previous-terminal re-collection (`:282`), is the persisted `CENSUS_CONTINUITY_LOST`; `DEADLINE` and thrown errors stay retryable. My lost-S probes (C answering as it really does), re-run on rc2: first GO, GO after a case, `proofs` first, and TERMINAL_OBSERVATION `IDENTITY_UNVERIFIED` each give `BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST`, effective TERMINAL_INCOMPLETE/CENSUS_UNVERIFIED, nothing consumed. A thrown `IPC_LOST` stays retryable. `BUILD_CHANGED` is gone from code, receipt and runbooks. Mutations E02, E03 DETECTED. Both runbooks are aligned |
| F2 | **closed** | The candidate block asserts the unsealed view (`on(disk, seal, null)`) and the simulated matching seal both ways. I ran a scratch copy whose `disk` returns a matching `ACCEPTED_RS_D_C_RC2` seal for every read (the post-seal state): 1/1 pass; the unsealed test passes too |
| F3 | **closed** | `pair-ack` takes the owner's exact PAIR_ACK. S's `install` refuses a nonce window above PAIR_NONCE_MS (`eval-state.ts:105-106`), so the pair ends at the earliest at `expiresAt − 120 s + 600 s`. A GO is refused once less than 200 s remain (≥ GO work + 26 s + 120 s + 2 s), before any consumption. Re-entering the same ack does not extend it (N3). The runbooks require RESPONSE before the pair ends. Mutations E05 and mine (no nonce-window subtraction) DETECTED. The rehearsal re-pairs at 5.5 min, so the refusal itself is unit-tested only — fine |
| F4 | **closed as scoped** | The config dir and every ancestor but `/` are write-denied literals. The real-profile test shows config-dir and ancestor rename EPERM, journal hard link EPERM, and S's own socket still binding. The `productionDeps().spawnServer` wiring is tested. E09 and E11 (= my rc1 R-M1) DETECTED. **But see F5** |
| N1–N6 | addressed | N1 `BUILD_CHANGED` removed; N2 `proofs`-first test (E12/E13); N3 same ack; N4 fidelity stated in report §2/§6; N5 docs (banner RS-D-C, receipt header v6, brief §1.3 IDENTITY, `launch.ts`, durations); N6 recorded |

### New finding (required)

**F5 — Medium — S's path denies still do not hold against a compromised S, and the final docs say they do.**
`packages/reval/platform.ts:37-47` adds rename/remove protection only for the config dir and its ancestors. The read-deny on the
owner/reader files and the write-denies on the helper and the project tree are still bare path rules.
- **Credential read.** Under the REAL rc2 profile built by `serverSandboxPaths` (scratch probe, test-harness layout
  `<cfg>/secrets/{owner,reader,runtime}` as written by `tests/support/reval-test-deps.ts:90-95`): reading `secrets/owner` directly
  and renaming the config dir both give EPERM. But `rename(<cfg>/secrets, <cfg>/sx)` → OK, read `<cfg>/sx/owner` → OK (the
  synthetic owner password came back), overwrite `<cfg>/sx/runtime` → OK, rename back → OK.
- **Helper replacement.** Production layout (helper at `<project>/dist/native/reval-peer`, the build-peer/runbook default): direct write
  and project-root rename give EPERM, but `rename(<project parent>, …)` → OK, replace the helper through the new path → OK, rename back
  → OK (the helper ends `EVIL`). The same works for a helper in its own directory (the test layout). C verifies the helper hash only at
  startup (`controller.ts:63`) and then spawns it by path for every peer proof and sandbox check (`peer.ts:42-49`,
  `server-link.ts:99,159`). S knows the path from its launch frame, so a replaced helper runs unsandboxed under C and can also forge
  the `sandbox <pid>` answer behind `processCoverage COMPLETE` / DRAIN QUIESCENT.
- **Toolchain rewrite.** Independent of renames, `(allow default)` (accepted in RS-D-B as "allow default beyond the listed rules")
  lets S write user-owned files that unsandboxed components later execute. On this host the node binary
  (`/opt/homebrew/Cellar/node/25.8.1_1/bin/node`, owner = the user, 0555) and its Homebrew dylibs are user-owned. C spawns E — which
  reads the owner credential, `owner-exec.ts:72` — and V with that node at every boundary. I did not touch those files; this
  follows from the profile text and file ownership.

Meanwhile `REVAL_RUNBOOK.md:144-147`, the profile header (`platform.ts:18-21`) and report §6 F4 state that S cannot read the
owner/reader credential files or write the helper or project tree.
**Fix:**
1. Add rename/remove protection for the ancestors of EVERY listed path (credential files, helper, project root, config file, C's
   files) — the same three lines generalised. Add real-profile tests: a credential file in a subdirectory (rename EPERM, no read via
   a new path), and the helper's and project root's parent directories (rename EPERM).
2. Optionally re-hash the helper in C before each spawn.
3. State the remaining limit honestly in the profile header, REVAL_RUNBOOK (RS-D-B section and "Ожидающие ограничения") and the
   report: the profile is an egress floor plus direct-path denies, and with `allow default` it does not contain a compromised S
   against same-uid writes to files that unsandboxed components execute later (node toolchain, dylibs, shell/launchd startup files).
   Closing that is an owner/architecture decision: an allow-list write profile, protecting the toolchain prefixes, or a separate uid
   for S.

### test:pg (not a clean pass) — my judgement

The 8 failures are latency-bounded refusals (`DEADLINE`, a first `CENSUS_UNAVAILABLE`, ordering of two refusals, PTY wait) at host
load 5.7–7.2. They sit in `reval-closure`, `reval-eval-e2e`, `reval-fixture-check` ×4, `reval-launch-controls` and `reval-launch`.
- **The implementer's claim holds.** `fixture-check.ts`, `snapshot-reader.ts`, `physical.ts`, `verifier-exec.ts`, `fixture-verify.ts`,
  `pg-tx.ts`, `eval-controller.ts`, `eval-drain.ts`, `scripts/reval-server/fixture-verifier.ts`, the e2e test and its support files
  all equal the RS-D-C baseline. The rc2 delta does not touch `controller.ts`.
- **My runs at load ≈ 4–5.6:** `reval-eval-e2e` 2/2 file runs pass. Sequentially, `reval-fixture-check`, `reval-closure`,
  `reval-launch-controls`, `reval-launch` (incl. the real-PTY test with S under the rc2 profile) and `reval-native-instrument`
  pass 28/28.
- **Accepted as residual:** these tests' 1.8–2 s budgets are load-sensitive on this host, and there is no clean full `test:pg` run on
  the rc2 tree in evidence. One gap stays open: a full run of the remaining ~770 PG tests at low load. The full run's only failures
  are these load-bound ones, and the files touched since rc1 all passed in it or in the re-runs.

### Notes (optional)

- **N7** IDENTITY_UNVERIFIED is also C's answer while S is still LAUNCHING (`server-link.ts:141-145`, no kill). A persisted stop then
  would be false, but it is practically unreachable: `connect` needs S's handoff socket, and `pair-ack` needs a READY S before
  `proofs`/GO. Optionally map it only after the pair exists.
- **N8** Cosmetic: `receipt.ts:5` still says "bound to every later IDENTITY"; `INSTRUMENT_RUNBOOK.md:14` starts a sentence in lower
  case.
- **N9** Pre-existing (accepted RS-C-A code): `eval-controller.ts:112` can hand S a 1 ms receive timeout when an operation reaches
  the front of C's queue near its deadline, and `server-link.ts:135-137` kills S on that timeout. Under heavy load this can end a run
  (now correctly as a persisted continuity stop). Worth a bounded floor in a later part.

### What I ran (rc2)

- Package hash, completeness, artifact-check, fresh build with inventory check, and evidence hashes.
- The lost-S probes on the rc2 rig. The post-seal identity simulation. Focused unit files 31/31.
- Mutations, each restored and sha-verified: E02, E03, E05, E09, E11 and my nonce-window mutation, all DETECTED.
- Seatbelt probes under the real rc2 profile built by `serverSandboxPaths`: test layout and production-like layout (F5).
- PG re-runs as above.
- Everything was restored byte-exact; `dist/` is unchanged.

### Residuals I accept (rc2)

The rc1 residuals, plus the load-sensitivity of the bounded-latency PG tests on this host (above). After F5 the S profile is an
egress floor with direct-path denies, not a containment boundary against a compromised same-uid S. I accept that only once it is
stated as an owner-decision residual.

## rc3 re-review (bounded, same reviewer session)

Date 2026-10-13, same reviewer session (native `claude-opus-5-5`, requested effort `max`). Input: manifest
`S5ASKREMOTE_REVAL_RSDC_RC3_MANIFEST.json` (sha256 `f2af7ff0…3d61`), checks `…_RC3_CHECKS.json` (`c83da306…2222`), report §7.

Verdict (rc3): APPROVE_RS_D_C

F5 is closed. Every directory above every named file (helper, the three credential files, the config file, C's journal and
instrument socket) and above the project root is now a write-denied literal, except `/` and directories inside the project tree,
which its subpath rule already covers. All three rc2 attacks fail under the real profile, and the unsandboxed control still performs
them. The remaining same-uid limit of an `(allow default)` profile is now stated honestly, as an owner decision, in the profile
header, the runbook and the report. N8 is fixed; N7 and N9 are recorded, which is acceptable for optional notes.

### Identity (recomputed)

| Item | Result |
|---|---|
| **packageHash** (same rule/baseline) | **`6330ca7980864e8ef447bb9d1ed3d08c0559288d4a87971d019b25accdb60727`** — 34 changed + 7 added, every per-file hash equal to the manifest, 0 removed; recomputed again after my mutations |
| rc2 → rc3 delta | `packages/reval/platform.ts`, `scripts/reval-instrument/receipt.ts` (header), `tests/reval-platform.test.ts`, 4 docs; candidate list and inventory unchanged |
| `cli.ts artifact-check` | ok, drift [], candidate RS-D-C **`c7cb5f9bbbe7adb8ca9641765fdad6aa042bc5546e6bbdb1798b68c86ddb2707`**, accepted:false; a fresh `api:build` leaves `dist/` byte-identical, `build-inventory.ts --check` exit 0, same digest |
| Evidence | all 22 logs match `logs`. Main mutation run ended 13:01:08Z, suite 13:01:21–14:17:48Z, then D18 alone (its sha-verified restore set `platform.ts` mtime 14:18:33Z) and the PG re-run. The current `platform.ts` bytes equal the manifest |

### rc2 finding and notes

| # | Status | How I verified |
|---|---|---|
| F5 | **closed** | `platform.ts:41-54` (`writeDenied` at :53), ancestors of `[root, ...files]` minus in-tree, no `/`. Unit layout check: credentials in a subdirectory, the helper in its own directory and in the tree, no duplicates, `/` never named. The real-profile probe through the production `serverSandboxPaths` (credentials in `c/secrets/`, helper in `hx/`, project root at `p/tree`): `renameSecrets` (with a read through the new name), `renameHelperDir` and `renameRootParent` are EPERM, and the unsandboxed control does all three. My mutations, each restored and sha-verified: F01 (the rc2 rule), F02, F03 and my own (credential files not walked) — all DETECTED, the first by the real-profile probe. Focused units (platform, identity, run, fsync) 23/23 |
| F5 docs | **closed** | Profile header LIMIT paragraph, `REVAL_RUNBOOK.md` RS-D-B paragraph ("напрямую"; "нижняя граница исходящего трафика плюс запреты на эти пути, а не изоляция взломанного S") and «Ожидающие ограничения», brief item 6 and §2, report §3/§7 — consistent and no longer over-claiming |
| F5 fix item 2 | accepted as not done | With every ancestor protected, S cannot replace the helper. A hash check before a by-path spawn would race the exec anyway |
| N7 | accepted unchanged | Unreachable in practice, as I noted (`pair-ack` needs a READY S) |
| N8 | **fixed** | `receipt.ts:5` "one IDENTITY per run"; `INSTRUMENT_RUNBOOK.md:14` sentence case |
| N9 | recorded | Pre-existing RS-C-A behaviour, for a later part |

The rehearsal (2709 s, S under the rc3 profile, 200 cases, 11 segments, 2 in-segment re-pairs, one guard epoch, 12 proofs,
COMPLETE_PENDING_REVIEW), test:ui 90/90 and unit (the same 8 RC5 failures) are consistent with the final tree. Mutations: 37/38.
D18 was run separately after the harness silently skipped its stale pattern (now fixed to print skips). D07 is qualified as before.

### test:pg (again not a clean pass) — my judgement

The 5 failures are latency-bounded refusals at load ≈ 5–6, all in startup or FIXTURE_CHECK / IDENTITY paths that RS-D-C does not
change (file hashes checked in rc2):
- `reval-eval-e2e` one case, at C's first operation;
- `reval-fixture-check` ×2;
- `reval-launch` PTY wait;
- `reval-native-instrument`, FIXTURE_CHECK `DEADLINE`.

The implementer's sequential re-run passed 19/19. My runs at load ≈ 3–4.9 also pass: `reval-eval-e2e` 3/3, and
`reval-fixture-check` + `reval-launch` + `reval-native-instrument` sequentially 17/17 (S under the rc3 profile in the last two).
I accept these as environmental. **Residual:** no clean full `test:pg` run exists for the rc2/rc3 trees (the rc1 tree had one).
I recommend attaching a full low-load run to the seal evidence.

### Residuals I accept (final)

The rc1 residuals (T2; no verified zero on darwin; provider egress layer tied to the PENDING key; privacy proof incomplete by
design; D1; `loadedBinding` UNVERIFIED; compiler-specific inventory; S's self-measured uncollected counter; host-specific
F_FULLFSYNC; the rehearsal is regression evidence and admits nothing; D07), plus:
- the declared S-profile limit: an egress floor plus direct-path denies under `(allow default)`, not containment of a compromised
  same-uid S; closing it is an owner decision. I did not probe beyond the three rc2 attacks, and anything past direct-path denies
  falls under this declared limit;
- the load sensitivity of the bounded-latency PG tests on this host and the missing clean full run above;
- N7 and N9.
