# R-EVAL server stage RS-A — implementation report, RC3 (repair of both independent RC2 reviews)

- **Author session:** native Claude Code `claude-opus-5-5`, the SAME session `642adc68-1d33-4c80-be48-6c8135833222`.
  - **Effective effort for this repair: xhigh** (settings-xhigh.json). This is the owner's conditional instruction ("если в этот раз приемки не будет, поставь исполнителю effort - xhigh"), triggered by both RC2 reviews returning CHANGES_REQUIRED. It overrides medium for this RS-A repair and related follow-ups.
  - No subagents or other models; no API, credits, fast mode, fallback or provider calls. **Paid product calls 0, activation false.** No customer, account, deploy or commit actions; network only for the existing loopback test DBs.
- **Governing documents (unchanged):** architecture RC4 `9fa16222…8163`; BRIEF rc4 package `e8f87336…f85040` (`IMPLEMENTATION_BRIEF.md` `caa8a5b4…`, `ACCEPTANCE_CHECKS.md` `5b2b3062…`); addendum `59c2fd7f…99dc`. The 8 RC4 norms, 120 RC5 files, six overlays, the 1540-file baseline and the 14 old-path scope are preserved.
- **Inputs:**
  - `docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_RC2.md` `0b92685b…` (RC2-F1 P1, RC2-F2 P2) and `OPUS_S5ASKREMOTE_REVAL_RSA_RC2.md` `c3c12fe9…` (R2-F1 P3).
  - Both cover frozen RC2 `cd13f162c0eabc555bff18460820127aa3b7aeef82396be6e0739726e11817df` (492 entries).
- **Source identity (after the LAST change and all tests/cleanup):** HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66` (uncommitted tree).
  - Source inventory `adc6a9ce98ffda270518fd17d8846059ca8ca801903bb3622adda2b15d791874` (1753 files; includes root's admin-only verification records).
  - Build inventory `583a4ca84af872b6e17943c563257e53983882bdcce1f74074f1043883215c13` (268 files).
  - Identical before the final run, in both paired unit records, and after the repro.
- **Status:** RC3 is ready for root's freeze and both independent own-session xhigh bounded re-reviews. I claim no acceptance, and neither an RC1 nor an RC2 review counts as approval.

## 0. Provenance

- **RC1** `1f5cd250…a05c` and **RC2** `cd13f162…17df` are frozen and archived by root; their manifests, CHECKS, reports and evidence are untouched.
- **RC2-era author report/CHECKS** are preserved as `checks/rc3/IMPLEMENTATION_REPORT.rc2.md` `be43ae6b…` and `checks/rc3/IMPLEMENTATION_CHECKS.rc2.json` `3aa1cab5…`; `checks/rc2/` is unchanged (its final5 is RC2 evidence).
- **RC3 evidence** is under `/tmp/atlas-reval-rsa/checks/rc3/`:
  - `focus/`: focused runs, including one failure that was then fixed (§2);
  - `probes/`: the reviewers' appendices verbatim and the before/after harness;
  - `mutation/`;
  - `final/`: THE final run, plus its paired-unit rerun, repro, manifest, deltas and identities.
## 1. RC2 findings → fix → meaningful test (RC2 → RC3)

Both independent RC2 reviews (`docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_RC2.md`, `OPUS_S5ASKREMOTE_REVAL_RSA_RC2.md`) cover frozen RC2 `cd13f162…17df`. Everything they recorded as closed stays as it was: RC1 R1, R3 and R4; Opus F1–F5; R2 except the reread interval; the final5 qualification approach. No contract, nonce, field, authority, route or stage was added. Architecture RC4, brief RC4, the acceptance checks and the addendum are unchanged.

### Sol RC2-F1 (P1) — private-channel violations stay effective through the pending reread

**Defect.** After E's valid result, `pauseExport` checked `channel.violated()` once and then awaited its reread. A duplicate result, a partial frame or malformed traffic arriving DURING that await closed the strict channel, but C still returned CLOSURE without a latch. `Channel.violated()` also did not count FRAME_TOO_LARGE.

**Fix** (`packages/reval/pause.ts`, `channel.ts`).
- `isViolation()` = PROTOCOL or FRAME_TOO_LARGE. It is persistent once set, because a closed channel never reopens. A peer's normal EOF/exit, ERROR, TIMEOUT and LOCAL are not violations.
- `pauseExport` keeps the strict channel listening (unsolicited) through the reread. It re-checks `violated()` AFTER the reread and then closes the channel in the SAME synchronous step. A violation at any time until the decision → `CONTAINMENT_UNCONFIRMED` + latch; it never reaches a closure. The session latch makes every later PAUSE_EXPORT refuse without spawning.
- E, S and `ServerLink` treat oversize private frames as violations too: E exits 22, S exits 42, C kills S.
- E is never killed in order to assume a rollback.

**Tests** (`tests/reval-reread-window.test.ts`, NEW). Real controller; real AF_UNIX socketpair to O with production `checkResponse`; real child executor stand-in (`tests/support/reval-gated-executor.ts`, NEW).
- The child sends exactly ONE valid CONFIRMED_COMMIT. While C's single reread is HELD, the test gates ONE anomaly: a duplicate full result, a partial extra frame (6 bytes), an oversize frame (declared > 4 KiB) or a malformed well-framed body.
- The reread is released only after C's own socket emitted those bytes. The observer listener is registered after C's channel listener, so this is deterministic, with no sleep.
- **Each anomaly:** O validates `FAILURE CONTAINMENT_UNCONFIRMED` at sequence 1; the next PAUSE_EXPORT gives sequence 2, `CONTAINMENT_UNCONFIRMED`, and the spawn count stays 1; the child is reaped.
- **Control:** the same single result followed by E's NORMAL exit (EOF) during the reread → `CLOSURE` at sequences 1 and 2, spawns 2. Not latched.
- **Retained unchanged:** the coalesced duplicate and pre-request negatives (`tests/reval-handshake.test.ts`).

**Sol's Appendix A** (verbatim, `checks/rc3/probes/sol-rc2-appendix-A.mjs`): actual production `pauseExport`/Channel, a real child socketpair, no DB, child reaped. Recorded before and after in `checks/rc3/probes/before-after.log`:
- frozen RC2 bytes (temp view): `CLOSURE`, `latched:false`;
- current: `FAILURE CONTAINMENT_UNCONFIRMED`, `latch:true`, `latched:true`, `reaped true`.

### Sol RC2-F2 (P2) / Opus R2-F1 (P3) — E's approved connect cap `min(300, DE − now)` restored

**Defect.** RC2 passed `min(500, deadline − now)` as E's whole physical budget, which `verifyPhysicalEndpoint` handed to pg as `connectionTimeoutMillis`. The pg connect could therefore take up to ~500 ms, against BRIEF §6's fixed `min(300, DE − now)`.

**Fix** (`packages/reval/owner-exec.ts`, `physical.ts`, `scripts/reval-server/owner-exec.ts`).
- `PhysicalExpectation.connectTimeoutMs` is a FIXED cap of the connection step alone, distinct from (and never widened by) the whole-binding `budgetMs`. The pg `connectionTimeoutMillis` AND the bound of the connect await are both `min(cap, remaining budget)`.
- E passes `connectTimeoutMs = min(E_CONNECT_TIMEOUT_MS = 300, remaining)` and `budgetMs = remaining` (bounded by E's own deadline).
- The production E connector is now `productionExecConnect()` in `owner-exec.ts`, used by the production entry, so it can be spied.
- Reader and S keep their budget-only connect: the brief fixes no cap for them.
- The brief and architecture are NOT changed.

**Tests** (`tests/reval-physical-peer.test.ts`, NEW test through `productionExecConnect` → `verifyPhysicalEndpoint` with a connect spy):
- under a 1200 ms deadline, the pg `connectionTimeoutMillis` is exactly 300 while the binding budget (session `statement_timeout`) is > 300 and ≤ 1200;
- 120 ms remaining → ≤ 120;
- a STALLED connect is cut at ~300 ms (REFUSED `DEADLINE`, nothing else ran), not at the 1200 ms deadline, and the late connection is destroyed unused;
- 28P01/28000/42501 → `OWNER_REQUIRED`;
- a wrong physical tuple → `REGISTRATION_MISMATCH`;
- the existing R3 controls now also run through `productionExecConnect`.

**Sol's Appendix B** (verbatim): frozen RC2 `{suppliedBudget:500, actualConnectTimeout:499}` → current `{suppliedBudget:300, actualConnectTimeout:299, authCode:OWNER_REQUIRED}`.

### RC3 self-found test-isolation defect (tests only)

**Defect.** The concurrency control's "E holds the fence" probe, and the owner-backend counters of the controls and closure files, queried `pg_stat_activity` CLUSTER-wide by `application_name`. With other PG files running executors in parallel on the shared Docker cluster, they could observe ANOTHER database's E. A concurrent reserve could then legitimately serialize before this test's E took the fence, and the test failed while the closure stayed exact.

**Fix:** every such query is scoped by `datname` to the test's own database. The launch file's reader-visibility evidence query is scoped the same way.

**Evidence:** found in a focused run (`checks/rc3/focus/pg-affected.log`). Two subsequent focused runs of all 5 affected PG files passed 23/23 each.

### Mutation evidence (temp copies only; `checks/rc3/mutation/mutation.log`)

Each mutation undoes ONE repair; all four are detected:

| Mutation | Detected by |
|---|---|
| Post-reread re-check removed | reval-reread-window |
| FRAME_TOO_LARGE not a violation | reval-reread-window (oversize case) |
| E cap 500 | reval-physical-peer |
| Connect cap ignored by the physical wrapper | reval-physical-peer |

## 2. Verdict on evidence (final run `checks/rc3/final/`, on the exact final bytes)

| Check | Result |
|---|---|
| `typecheck`, `ui:typecheck`, `db:generate`, `schema:validate`, `db:check:drift`, `db:check:pg17`, `api:build` | all exit 0 |
| `test:pg` (Docker PG17 + REQUIRED native fixture) | **exit 0, 725/725**, 0 failed/skipped/cancelled |
| `test:ui` | **exit 0, 86 passed** |
| Unit, complete and unfiltered, `tests/*.test.ts` (88 files): the qualifying paired run (rerun, §3) | **exit 1 — QUALIFIED NONZERO**: 509 reported, 501 pass, 8 fail; all identity-only |
| RC5 files only (13 files) | 46 reported = 38 pass + 8 fail; per-name reconciliation exact |
| Historical RC5 (FINAL archive proof; referenced, NOT rerun) | `HISTORICAL_RC5_FINAL_CHECKS.json` `d90892a8…c589`: 110/110 |

**This is not a green unit run.** No unit test fails except the unchanged RC5 identity-only set.

**The first unit run of the final suite also failed, and I report that honestly.**
- `final/unit-paired.log` `4657c6ae…`: 509 / 500 / **9 fail**.
- The extra failure was TAP 204, `tests/m365-database.test.ts` "M365 migrations need no pre-created role …", with `P0001 the root leaf has the attempt bounds`.
- **Diagnosis.** The unit step started at 16:59:56Z and crossed 17:00:00Z. The baseline helper `tests/m365-sql-invariants.ts` anchors its sign-in window at `date_trunc('hour', now()) - interval '2 hours'`, evaluated separately in each autocommit statement. Across an hour boundary, an attempt's `coveredFrom` and its root leaf's `fromInclusive` therefore differ by one hour, and the M365 trigger correctly refuses.
- That file is pinned in the R-C manifest and is part of the 1540-file baseline; RC3 does not touch it or the M365 migration. I did NOT edit it.
- **Remedy.** The identical complete unfiltered paired unit script was rerun away from the boundary: `final/unit-paired-rerun.log` `e5722b52…`, 17:10:10Z→17:11:42Z, recorded in `final/unit-rerun.tsv`. It gave 509/501/8 identity-only.
- **Control:** the affected file alone gives 8/8 pass (`final/m365-database-control.log`).
- Both runs carry byte-identical source/build/RC5/guard identities, so the rerun is on the same bytes.
- **Residual:** this pre-existing hour-boundary sensitivity is outside RS-A scope.

**Focused-run failure, fixed** (§1, test isolation): `focus/pg-affected.log` had 22/23 (the concurrency control). After the `datname` scoping, `focus/pg-affected-r1/r2.log` gave 23/23 twice (closure, controls, native, launch, launch-controls).

## 3. Unit qualification — the paired record (`final/unit-paired-rerun.log` `e5722b52…`)

In one log:
1. Identities BEFORE.
2. The complete unfiltered TAP run.
3. The direct child probe with the EXACT argv of `tests/ask-remote-eval-execution-pty.test.ts` (`<node execPath> --experimental-strip-types --no-warnings scripts/ask-remote-eval-execution/cli.ts session --receipt-dir <tmp>` under `/usr/bin/script`) → banner, `ExecError: CORPUS_IDENTITY_MISMATCH` (`bindCorpus` ← `loadContext` ← `interactive` ← `runOperatorSession` ← `main`), `PROBE_EXIT 1`, 0 receipts.
4. Identities AFTER: identical to BEFORE, and to both identity records of the first run.

The 8 `not ok` entries:
- TAP 12, 13, 14, 16, 17, 18, 19: the module-load wrappers of `ask-remote-eval-execution-{cli,liability,operator,receipt,repair,replay,session}`, each with `CORPUS_IDENTITY_MISMATCH` via `bindCorpus`.
- TAP 76: the registered PTY test, `PTY_TEST_TIMEOUT step 1`. It is NOT directly proven by its own output and NOT counted as passing; the root-accepted causal record is the same-log probe.

**Per-name reconciliation** (`final/rc5-files.xml` `f18579e2…`, `final/rc5-reconcile.json` `2146e193…`, against the FINAL proof's inventories): 38 executed passing (names equal) + 1 executed failing (pty) + 71 blocked/unregistered (behind 7 failed wrappers) = 110.

The RS-A unit tests total 40 (`focus/unit-rsa.log`, all pass): protocol 8, payloads 9, physical-peer 7, static 4, rc5-guard 2, deadline 5, handshake 3, reread-window 2.

## 4. RC5 coupling (unchanged by RC3)

- The guard is unchanged: `RC_SOURCE_DRIFT`/`RC_BUILD_DRIFT` only, with the same 14 source and 2 build child deltas. RC3 touched no pinned R-C path.
- `dist/apps/api/src/main.js` `7137c74d…` and `runtime-role.js` `a63c4723…` are unchanged. The six overlays are at their pins; the 120 RC5 files match.
- Copied-view tampers in the same run: source → `[RC_SOURCE_DRIFT]`; build → `[RC_BUILD_DRIFT]`; overlay → `[ADMIN_OVERLAY_DRIFT, OFFLINE_FILE_DRIFT, RC_SOURCE_DRIFT]`; untampered → ok.

## 5. Native production chain and timings (`final/test-pg.log` `aa0139bd…`)

- Native fixture: descriptor `13de8799…`, PostgreSQL 17.11; owner/runtime/reader super and bypass false; start equality `1791720581`.
- APPLIED and NO-OP closures; ref `rsa-peertoken-unixphys-v1`, `UNVERIFIED`.
- Negatives → `FAILURE REGISTRATION_MISMATCH`; wrong owner password through the PRODUCTION E connector (now `productionExecConnect`, 300 ms cap) → `OWNER_REQUIRED` ×2.
- Real catalog-lock stall: `DeadlineExceeded` 801 ms (budget 800); cancelled ≤ 56 ms later with the lock held; backend gone 1 ms after release.
- Docker PTY timings (regression only): IDENTITY p50 5.8 / max 7.1 ms; PAUSE_EXPORT p50 221.6 / max 250.1 ms.

## 6. Reproducibility, hygiene, manifest (`final/repro.log` `79d25217…`)

- **Helper:** `9624a353768cfd528538c4c965ad462295da4f8124a17c6d9bc0118248a983c1` from two checkout builds and the clean copy.
- **Clean production copy:** `api:build` + `build-peer` exit 0; all 203 dist JS files, inventory `5de2e5c4dc4307442f003c219bdfb81e60f59da1904f055b9b3d6284334ab4fb`, are equal in checkout and copy. The count is still 203: no new production module in RC3.
- **Whitespace:** `git diff --check` exit 0; no trailing whitespace in the RS-A files.
- **CURRENT manifest: `/tmp/atlas-reval-rsa/checks/rc3/final/manifest.out` `cf9827f3…`.** 14 changed baseline paths, none missing, RC5 delta `[]`. This supersedes `checks/rc2/final5/manifest.out` and the obsolete `checks/rc2/manifest.out`.
- **Process audit** after the final run and the repro (production entries, test entries, gated/spy/scripted children, S, `/usr/bin/script`, playwright, helper): NONE.

## 7. Exact deltas

### Final suite steps (`final/steps.tsv` `94056a52…`, runner `checks/rc3/run-final.sh`)

| Step | Exit | Time | Log sha256 |
|---|---|---|---|
| typecheck | 0 | 9s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| ui-typecheck | 0 | 1s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| db-generate | 0 | 0s | `bd6822287992145125784821004fade8b051e83201711a06a7596760e59824e7` |
| schema-validate | 0 | 0s | `1fa1e06af31f866d939dcbc2f900483ed3ca80ed28d58c5071c0556790d7092f` |
| db-drift | 0 | 1s | `892b13f6d8d0c9be510e7746fe0a02fbdcdeb853749096fa335597962305d6a2` |
| db-pg17 | 0 | 1s | `3ba8dd0aae637f81e7e201c4b7ebb3b77e3928839ed2b161906033bb0c720919` |
| api-build | 0 | 4s | `a6aa931089b464f4c65e4a923b0460b903968733081bc2b5d7806e5f32081592` |
| unit-paired | 1 | 92s | `4657c6ae9ab437b14002f95c5f460722dea0c37a9c6a13cd53fbc61e5751419c` |
| rc5-files | 1 | 91s | `7640d3e14e03179290112ad8ecb075f2dab031b6dd58042482986f72c365fe28` |
| test-pg | 0 | 209s | `aa0139bd64c1d696ce63d6aa362bb37de84804449f6ce661e2e1a50cf766ec38` |
| test-ui | 0 | 131s | `ede0de7343afeea5a33181d9c33f8d4b38e17f38c179da59c3d9b2e8c2ac0ecd` |
| unit-paired-rerun (qualifying; `final/unit-rerun.tsv`) | 1 | 92s | `e5722b52133f23bc1d2e7b947c8f8a64cd3c79e29bfdc531e222459ea2c8db4b` |

### RC2 → RC3 (against frozen `S5ASKREMOTE_REVAL_RSA_RC2_MANIFEST.json`, packageHash `cd13f162c0eabc555bff18460820127aa3b7aeef82396be6e0739726e11817df`; `final/rc2-to-rc3-delta.json`)

Author-changed (19; missing none):

| Path | RC2 | RC3 | lines |
|---|---|---|---|
| `apps/api/src/reval/bridge.ts` | `40369ed1b72d8f8c…` | `741316510a7a763ec987ec7697a1b1786e4360c9e755de36376084ac9be29fcd` | 119 |
| `dist/apps/api/src/reval/bridge.js` | `b9de0c144b503f13…` | `d8ab819c948715e649082011f1c267c84e28b0ec608f15345f08d8899ec2a0ea` | 139 |
| `dist/packages/reval/channel.js` | `e370409b8ea88d07…` | `3d0ab66ffcda967708e6101eadeba9b7e80d161b8164942722febdad5eef3746` | 128 |
| `dist/packages/reval/owner-exec.js` | `cab74fd06c71e4d8…` | `a9fdf58f1976dd4b2b4a18865991d5287adb4f1ccd90df1797e7b887a2a764a9` | 176 |
| `dist/packages/reval/pause.js` | `36809e68e243074d…` | `c15b2d646621bcaa3247fe2d743b6f742307e1548964606b504756505a237779` | 103 |
| `dist/packages/reval/physical.js` | `3b55b895cda4a449…` | `14bd64e83e6b1f696e094a67a52598a73d4daf327e9d60f0cd4bf7c8267705bd` | 130 |
| `dist/packages/reval/server-link.js` | `541523a94d39909d…` | `d76512c028ca467a07530896bfa9b2d0dd3dd5c1f577dc0f2fa221679c4cc7fa` | 141 |
| `packages/reval/channel.ts` | `76ed5e9527a3afa2…` | `ab7589382a5c585dd7f8d80f5e67b29a6d739ef4955103c0efddc1d7c536a392` | 88 |
| `packages/reval/owner-exec.ts` | `4f4f9369ad2f9134…` | `eecb7e462317fc13f083a20f43d10143c8180d9023a3a79a3d86eb68517cbe74` | 162 |
| `packages/reval/pause.ts` | `71e7a8e3a868944c…` | `fb6118bef33e2297ae6b6852f85aa9d17d2a5a999386edfaa1ccf509b993b6cb` | 102 |
| `packages/reval/physical.ts` | `1c1eef2bc7ffe37d…` | `036c407dfd5fce015086de2e0b7dd0a1ffdd65cbb169397fc95aa7f0955b1fc5` | 140 |
| `packages/reval/server-link.ts` | `ead46701ac10cf76…` | `00b37299d5809904b4b513dd0a3e3582399eb612638cbfafa8a00b054ef660a6` | 120 |
| `scripts/reval-server/owner-exec.ts` | `e9a1566b6b37460a…` | `325430ad457d7756716226064875ef4290a19cacbbb4b1c5e33e74ef0b2916c6` | 10 |
| `tests/pg/reval-closure.pg.test.ts` | `20b7701f169ab477…` | `e419f88814b7a040ef7e9c655a54c58f761f27d56c6ad7ec4fae2cb849c7fd2b` | 181 |
| `tests/pg/reval-controls.pg.test.ts` | `f7c64a8bdd03333d…` | `3219ecfcdcfa8a1459676ae03b59cede9f21fed20da2cefbe02134c9dfe6cf17` | 144 |
| `tests/pg/reval-launch.pg.test.ts` | `caeae943dc19abdd…` | `7a20dcc813203af66a4f9e08aac03b1f7625cda9f055aa1f7fdd7ea7abe826c2` | 204 |
| `tests/reval-physical-peer.test.ts` | `caa77b214b5d7590…` | `b4e7b0ca1756896369f140c9438eef00a498c83e8d70bb00e5e71f982ebd15b7` | 229 |
| `tests/support/reval-test-deps.ts` | `800966dc8a7c6b02…` | `4b281281a7e25c3f3ee27cc8c27098ae4ba37dd009e7b1ad484445a2979a04e6` | 101 |
| `tests/support/reval-test-exec-entry.ts` | `a452636d14147e87…` | `f6c32dde4910067bc892ce4dd06a9f5bd98d7fa4382189c572f9887a515b9b78` | 42 |

New (2):

| Path | sha256 | lines |
|---|---|---|
| `tests/reval-reread-window.test.ts` | `d3d7f659367a26a49a987bdfbd3ced46a1c53ee23bf5ec59afd72e8c5d8e7bde` | 79 |
| `tests/support/reval-gated-executor.ts` | `f7c362c36ebffc085f05778d3314c075a7151546557b7ee7a0c2faa0c70f81ea` | 33 |

Root-owned, changed by root (admin), NOT by me: `verification/stage5/S5ASKREMOTE_REVAL_RSA_OWNER_EFFORT_STEERING.json`.

### RC1 → CURRENT (against frozen `S5ASKREMOTE_REVAL_RSA_RC1_MANIFEST.json`, packageHash `1f5cd250970daab57b5004ce291abe04d4ef42961c57450d6a15ac2fcea0a05c`; `final/rc1-to-current-delta.json`)

Author-changed (36):

| Path | current sha256 | lines |
|---|---|---|
| `apps/api/src/reval/bridge.ts` | `741316510a7a763ec987ec7697a1b1786e4360c9e755de36376084ac9be29fcd` | 119 |
| `dist/apps/api/src/reval/bridge.js` | `d8ab819c948715e649082011f1c267c84e28b0ec608f15345f08d8899ec2a0ea` | 139 |
| `dist/packages/reval/channel.js` | `3d0ab66ffcda967708e6101eadeba9b7e80d161b8164942722febdad5eef3746` | 128 |
| `dist/packages/reval/controller.js` | `14bfd7c1c7a5df4bcdad8e556756d3eecb19504f899b870f36082c74981af7e2` | 357 |
| `dist/packages/reval/deps.js` | `8f159cac950527b2be0c6efdbf85b8fda14fff26dd95430ab6803bed995ae457` | 49 |
| `dist/packages/reval/frame.js` | `dfbd3fb704dbaa78ca49ce5bd57483094d091922c4fb4b586a25a35b549aced5` | 102 |
| `dist/packages/reval/owner-exec.js` | `a9fdf58f1976dd4b2b4a18865991d5287adb4f1ccd90df1797e7b887a2a764a9` | 176 |
| `dist/packages/reval/pause.js` | `c15b2d646621bcaa3247fe2d743b6f742307e1548964606b504756505a237779` | 103 |
| `dist/packages/reval/physical.js` | `14bd64e83e6b1f696e094a67a52598a73d4daf327e9d60f0cd4bf7c8267705bd` | 130 |
| `dist/packages/reval/server-link.js` | `d76512c028ca467a07530896bfa9b2d0dd3dd5c1f577dc0f2fa221679c4cc7fa` | 141 |
| `dist/packages/reval/snapshot-reader.js` | `a80e4146f86fdebfcb51bb38587746a4d6a525000b80134d73400f7cad26867a` | 112 |
| `packages/reval/AGENTS.md` | `ae3619d426949bea1a3dd34faf41c1d15535f409e00f3ffbb0c067fd6fbf1648` | 13 |
| `packages/reval/channel.ts` | `ab7589382a5c585dd7f8d80f5e67b29a6d739ef4955103c0efddc1d7c536a392` | 88 |
| `packages/reval/controller.ts` | `9980b700bdb1c9ddc54e37ec2ffea7b44deb16f247512760218d200e6fa72d81` | 242 |
| `packages/reval/deps.ts` | `eb7ebf87cd91c4f5fad328b281e90929f65a53fad21ab4ca2bfd062fd4922f19` | 72 |
| `packages/reval/frame.ts` | `1ff9a4e2ade4acf3569e3ba49154966d5d2ccc5c91321f5990464caad3b25873` | 78 |
| `packages/reval/owner-exec.ts` | `eecb7e462317fc13f083a20f43d10143c8180d9023a3a79a3d86eb68517cbe74` | 162 |
| `packages/reval/pause.ts` | `fb6118bef33e2297ae6b6852f85aa9d17d2a5a999386edfaa1ccf509b993b6cb` | 102 |
| `packages/reval/physical.ts` | `036c407dfd5fce015086de2e0b7dd0a1ffdd65cbb169397fc95aa7f0955b1fc5` | 140 |
| `packages/reval/server-link.ts` | `00b37299d5809904b4b513dd0a3e3582399eb612638cbfafa8a00b054ef660a6` | 120 |
| `packages/reval/snapshot-reader.ts` | `806670058ed43294936af4eb7ab040f6c1c08237006043393e889c7b7e04fce9` | 92 |
| `prisma/migrations/202610131000_stage5_reval_registration/migration.sql` | `88e02e08aaec83a86729e0ce23b8fe1b97972f644da5af16c1753df37ae48edb` | 297 |
| `scripts/reval-server/owner-exec.ts` | `325430ad457d7756716226064875ef4290a19cacbbb4b1c5e33e74ef0b2916c6` | 10 |
| `tests/pg/reval-closure.pg.test.ts` | `e419f88814b7a040ef7e9c655a54c58f761f27d56c6ad7ec4fae2cb849c7fd2b` | 181 |
| `tests/pg/reval-launch.pg.test.ts` | `7a20dcc813203af66a4f9e08aac03b1f7625cda9f055aa1f7fdd7ea7abe826c2` | 204 |
| `tests/pg/reval-native-unix.pg.test.ts` | `cb3043173282b8a2b107fbab8f9d11711f3966b5e4460b64c3d95b943dd2258d` | 168 |
| `tests/pg/reval-snapshot.pg.test.ts` | `57a49dfc676579af29c0cdb7fa740be53bb8e39c2d2284ef95ed99789db91b8b` | 254 |
| `tests/pg/reval-upgrade-guard.pg.test.ts` | `f091420c8984e7e4c1424c097a5e0fbc3865be0cf1ad988ed6469d57c4eebe4a` | 154 |
| `tests/reval-physical-peer.test.ts` | `b4e7b0ca1756896369f140c9438eef00a498c83e8d70bb00e5e71f982ebd15b7` | 229 |
| `tests/support/reval-pg.ts` | `a6b455c6d2e338fe4916df109aecd29f90051c7259c7494bda767480ea57957d` | 78 |
| `tests/support/reval-pty.ts` | `7b4268f47ac6b4d4be89215ad6edb3e172e3649b0915f2085827129ee7e62a82` | 82 |
| `tests/support/reval-test-controller-entry.ts` | `2bd4211ee348dc2cb82f9343971454f9fe07755f99cd6d77de4d75826000db2d` | 81 |
| `tests/support/reval-test-deps.ts` | `4b281281a7e25c3f3ee27cc8c27098ae4ba37dd009e7b1ad484445a2979a04e6` | 101 |
| `tests/support/reval-test-exec-entry.ts` | `f6c32dde4910067bc892ce4dd06a9f5bd98d7fa4382189c572f9887a515b9b78` | 42 |
| `tests/support/reval-test-pause-entry.ts` | `b76b14ec14324e9f41ecc925e240e5a9b9827a13c892b1bd1717062de561e2d8` | 19 |
| `tests/support/reval-test-server-entry.ts` | `23ff4891c056706e4a5128b5ac337302fb02a3d0d4e28f82f562490c498a253c` | 31 |

New RS-A paths since RC1 (13, including the compiled `dist/packages/reval/deadline.js`):

| Path | sha256 | lines |
|---|---|---|
| `dist/packages/reval/deadline.js` | `5985e65bd039ae2d175a24cb30038f3e694ab4ea508b44945e47039284337202` | 29 |
| `packages/reval/deadline.ts` | `e5dfec29b382b976b1f62d1ddfa6cf62e41c219eeca33cf380f1e091602629ae` | 28 |
| `tests/pg/reval-controls.pg.test.ts` | `3219ecfcdcfa8a1459676ae03b59cede9f21fed20da2cefbe02134c9dfe6cf17` | 144 |
| `tests/pg/reval-launch-controls.pg.test.ts` | `714a0107d0ed6ec81a84f2d6d874774dfdfad6ccc1806d5cc2b832727ecc3000` | 108 |
| `tests/reval-deadline.test.ts` | `75339742e30609eaeddaf034e7b132b232d7af1f00897541d9a0646ef94e4145` | 124 |
| `tests/reval-handshake.test.ts` | `b2157e42d45100049868c119eafb8807409af7158dc03d35e3eefdda58986d19` | 127 |
| `tests/reval-reread-window.test.ts` | `d3d7f659367a26a49a987bdfbd3ced46a1c53ee23bf5ec59afd72e8c5d8e7bde` | 79 |
| `tests/support/reval-closure-harness.ts` | `c63323a51cd79ff0f15d60067d6d32406fe9ac642564f6a8361a3ba3872e7ba0` | 84 |
| `tests/support/reval-controller-harness.ts` | `9b33bc75eb1a755931df6eae68b45d9034bd6126ee6ffd66bf26bf76f6baf556` | 109 |
| `tests/support/reval-gated-executor.ts` | `f7c362c36ebffc085f05778d3314c075a7151546557b7ee7a0c2faa0c70f81ea` | 33 |
| `tests/support/reval-launch-harness.ts` | `f18afe8fb20a9e8164a82acc6cb3ae6f099fda7f87439c58298107b92502d7dc` | 57 |
| `tests/support/reval-scripted-child.ts` | `9e38217da596c02eca499d1ade0dc7a9f2d323e337810a70b7692ca6a2675922` | 26 |
| `tests/support/reval-spy-child.ts` | `95798a6cdf95d3fdab52d449e8f85d222da8ac762a5287ec662da288a324f9d5` | 14 |

Root-owned since RC1, changed by root: `verification/stage5/S5ASKREMOTE_REVAL_RSA_AUTHOR_MODEL_EVIDENCE.json`.

## 8. Earlier rounds (unchanged, preserved)

- RC1 R1–R4 / Opus F1–F5 → fixes and tests: see `checks/rc3/IMPLEMENTATION_REPORT.rc2.md` §1. Both RC2 reviews recorded them as closed, apart from the R2 reread interval repaired here.
- RC2 self-found items (the PTY teardown leak; the guard reference checks under replica) remain fixed and tested. The PTY fixture SIGHUPs O and reaps the whole tree; every PTY test asserts `forced: []`; native negatives `quit`.

## 9. Residuals (disclosed; no known requirement violation)

- Receive-time private phases (the S launch frame carries no nonce by contract).
- PostgreSQL's backend teardown waits for an external superuser lock on `pg_database`.
- E per-statement timeouts follow the brief's formula.
- Ancestor-dir check is mode-based (same-UID boundary).
- Helper TOCTOU / full image `UNVERIFIED` (RS-D); socket swap between checks; JS password strings; same-UID/kernel trust.
- A SIGKILLed terminal emulator without a hangup could leave O and C running until a SIGHUP.
- The pre-existing hour-boundary sensitivity of the baseline M365 invariant helper (out of RS-A scope; §2).
- RC5 compatibility PENDING / NOT_ADMITTED; A3 refuses until RS-B; RS-B/C/D, data, budget, customer and deployment remain separate.

## 10. Cleanup, processes, ownership

- **Docker:** only the 5 older foreign DBs remain (`final/cleanup-docker.json`); 0 `atlas_rv_*` roles. The only other `atlas_*` roles found belong to the foreign `atlas_pilot_20261008…` DB (not mine, left).
- **Native cluster:** no databases; the only `atlas_*` role is root's admin (`final/cleanup-native.json`). The cluster is left READY for root's end cleanup.
- **Processes and temp copies:** none (audit after the final run and the repro).
- **Not done:** no commits, pushes, deploys or activation; root-owned requirements, resolutions, status, model and effort metadata, seals and history were not edited.

**Checkout write ownership is explicitly RETURNED to root** as the last recorded action, after all code, tests and cleanup. No checkout write follows. The purpose is root's RC3 freeze and both independent own-session xhigh bounded re-reviews; I claim no stage acceptance. Related fixes remain in this same session at xhigh.
