# R-EVAL server stage RS-A — implementation report (revision 2: bounded contract repair)

- **Author session:** native Claude Code, model `claude-opus-5-5`, effort **medium**, the same session `642adc68-1d33-4c80-be48-6c8135833222`. No subagents or model launches, no API, credits, fast mode or fallback.
- **Safety:** paid product calls **0**; activation **false**. No network/provider/account/deploy/commit actions.
- **Governing documents (unchanged; verified by hash):**
  - SERVER-DESIGN-rc4 package `9fa16222…8163`.
  - BRIEF rc4 package `e8f87336…f85040`: `IMPLEMENTATION_BRIEF.md` `caa8a5b4…`, `ACCEPTANCE_CHECKS.md` `5b2b3062…`.
  - `VERIFICATION_ADDENDUM.md` `59c2fd7f…99dc`.
- **Source identity:**
  - Checkout HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `codex/reval-server-contracts-20261011`, uncommitted working tree.
  - Node v25.8.1; Docker PostgreSQL 17 (test admin); native Homebrew PostgreSQL 17.11 fixture.
- **Scope:** RS-A only. RS-B/C/D not started. Code acceptance is **pending**: no reviewer gate has started, and I make no acceptance claim.

## 0. Provenance and revision 2 summary

**Revision 1** (archived copies: `checks/repair/IMPLEMENTATION_REPORT.rev1.md` `997ca553…d483` and `checks/repair/IMPLEMENTATION_CHECKS.rev1.json` `1e7bd267…f848`):
- The complete required suite ran in `checks/final2/`; the earlier, superseded run is in `checks/final/`.
- After that run, process 44161 exited 0 and returned ownership.

**Revision 2.** Root returned sole write ownership for a bounded repair of two requirement violations I had introduced. Both are now removed; no architecture or requirement changed.

1. **Physical start tolerance (BRIEF §3 step 5).**
   - **Was:** `startMatches` accepted a queried `pg_postmaster_start_time()` floor epoch 0..5 s after the recorded `postmaster.pid` start. It was used in `verifyPhysicalEndpoint`, the reader recheck (`deps.ts`) and `wrapperBound` (`snapshot-reader.ts`). The synthetic stub positive used +2 s.
   - **Now:** `startMatches` is deleted. All three use exact string equality with the recorded tuple, and the recorded tuple is the `postmaster.pid` line 3 itself.
   - **Tests:** the stub positive now uses the equal value. The ±1 s queried start, each alone, refuses at step `database`; the connection is ended, and the only statement is the physical query. A wrapper start ±1 s alone is unbound. The test-only Docker TCP seam now also compares the start and reports the queried value.
   - **Native production proof:** `postmaster.pid` start `1791720581` equals the production `PHYSICAL_QUERY` floor `1791720581` (`equal=true`). The full native production chain passes with no tolerance. Native config negatives at start −1 s and +1 s refuse (§5).
   - **Mutation check** (temporary copy, never the checkout; `checks/repair/mutation.log` `717cd73e…`): restoring the old 0..5 s tolerance makes both new negatives FAIL ("pg_postmaster_start_time +1 s" and wrapper "start 2"), so the tests detect the relaxation.
   - **Platform:** equality is not prevented by real platform behaviour on this fixture, so there is no stop condition. I leave no residual and request no relaxation.
2. **Controller local exits 13/14/15 (BRIEF §2: exactly "10 platform, 11 helper, 12 peer").** `CONTROLLER_EXIT` is now exactly `{PLATFORM:10, HELPER:11, PEER:12}`; `exitCodeDisplay` maps only these, and any other exit (a crash) is the generic `INTERNAL_FAILURE`. The closed 43-code wire `FailureCode` is unchanged (`reval-protocol` test).
   - **Former 13 CONFIG** (an invalid launch env or an unloadable config, before any peer proof): this fails the helper gate → **11**. The ground is BRIEF §2: "only darwin/arm64 with the pinned helper … otherwise … fixed local exit code"; without a valid launch env and config there is no verifiable helper pin. The platform check now runs first, so a non-darwin/arm64 host always exits 10.
   - **Former 14 REGISTRATION and 15 STARTUP_DEADLINE** (BRIEF §2a steps 3–5, all AFTER the peer proof): these now use the approved response path, an authenticated `FAILURE` to O's request, the same as the SNAPSHOT path does today. The codes are:
     - `REGISTRATION_MISMATCH`: digest failure, apiEntry mismatch, reader physical binding failure (§3 "Any failure → REGISTRATION_MISMATCH") or an unbound wrapper (§2d "refuse before launch").
     - The reader's own approved code, for an RV-coded wrapper failure.
     - `DEADLINE`: the first 1800 ms budget is exhausted (§6 table).

     The failure is repeated for every implemented operation of that session; direction checks and fail-closed ops keep their own codes first, and S is never launched.
   - **No new code, enum or requirement.** O displays these as `FAILURE <code>` (C-authenticated after the peer proof), never `LOCAL`.
   - **Tests:**
     - Gate unit test: the exit set is exactly `[10,11,12]`; non-darwin → 10 even with an invalid env; invalid env and config-load failure → 11; nothing fires before the gate.
     - New PG launch test under a real PTY: build digest ≠ registration, reader physical OID mismatch, and a test-only clock skew after a bound startup wrapper each give `FAILURE <code>` ×3 (identity, snapshot, pause-export), with S never started and no S or E backend.
     - Native negatives now expect `FAILURE REGISTRATION_MISMATCH` ×2.

**Files changed in revision 2.** All are RS-A-owned paths:
- `packages/reval/{physical,snapshot-reader,deps,controller,codes}.ts`
- `tests/reval-physical-peer.test.ts`, `tests/reval-payloads.test.ts`
- `tests/pg/reval-launch.pg.test.ts`, `tests/pg/reval-native-unix.pg.test.ts`
- `tests/support/reval-test-{deps,controller-entry}.ts`
- `docs/RUNBOOK.md` (owner display and start equality)

None of these is an RC5 file, pin, manifest, admin overlay or RC4 norm, and no root-owned document changed. The RC5 coupling result is unchanged (§3).

## 1. Verdict on evidence (honest)

| Check | Result |
|---|---|
| `typecheck` | revision 2: exit 0 (`checks/repair/typecheck.log`) |
| `api:build` | revision 2: exit 0 (`checks/repair/api-build.log` `a6aa9310…`) |
| `ui:typecheck`, `db:generate`, `schema:validate`, `db:check:drift`, `db:check:pg17` | revision 1 full run: exit 0. Not repeated: no schema, migration, roles or UI file changed |
| `test:pg` | revision 1 full run: exit 0, **712/712** (`final2/test-pg.log` `ed76f3c9…`). Not repeated in full: no new concern outside RS-A |
| `test:pg` focused, revision 2 | all 6 RS-A PG files including native: exit 0, **26/26** (25 earlier + 1 new), 0 skipped/cancelled (`checks/repair/pg-focused.log` `230bd383…`) |
| `test:ui` | revision 1: exit 0, 86 passed. Not repeated: no UI or API-route change |
| Unit, complete and unfiltered, revision 2 | **exit 1 — QUALIFIED NONZERO**: 496 reported, 488 pass, 8 fail; every failure is RC5 identity-only (§4) |
| Historical RC5 (root FINAL proof; referenced, not rerun) | `/tmp/atlas-reval-rsa/HISTORICAL_RC5_FINAL_CHECKS.json` `d90892a8…c589`: exit 0, 110 tests, **110 pass**, 0 fail/skip/cancel/todo, 13 per-file inventories, 120 RC5 files, 1252 source + 244 built entries, log `0eb98e5c…`, junit `c1fa398c…` |

**This is not a green unit run.** The 8 failures are the RC5 execution files refusing on `CORPUS_IDENTITY_MISMATCH` because of the authorized source/build child deltas (§3). No other unit test fails, and none is skipped or cancelled.

## 2. Exact commands, exit codes and log hashes

**Revision 2** (`/tmp/atlas-reval-rsa/checks/repair/`):

| Step | Command | Exit | Log sha256 |
|---|---|---|---|
| typecheck | `npm run -s typecheck` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| api-build | `npm run -s api:build` | 0 | `a6aa931089b464f4c65e4a923b0460b903968733081bc2b5d7806e5f32081592` |
| focused unit | `node --test tests/reval-{physical-peer,payloads,protocol,static,rc5-guard}.test.ts` | 0 | 27/27 (console) |
| focused PG | `node --test tests/pg/reval-{roles,snapshot,upgrade-guard,closure,launch,native-unix}.pg.test.ts`, with the native fixture env | 0 | `230bd383376226ef6136b4629ac1375539d816eb64a8124ddbd50be2125cbc4a` |
| unit (complete) | `node --experimental-strip-types --test --test-reporter=tap tests/*.test.ts` (85 files), with the view env | 1 | `7aae404aefefc259fd695411ea2847fb4d141ec1d37ad9437caeb2e18bc36503` |
| RC5 files only (reconciliation) | `node --test` TAP + JUnit of the 13 historical files | 1 | tap `be8c0d7b…`, xml `76b1f916…`, reconcile `2146e193…` |
| PTY probe | `checks/pty-probe.sh` | — | `ac790dfb31569394d5fc1cbd9c0af8bbb8c9e2a740d19ed21622dc05cde35392` |
| mutation check | old tolerance restored in a temp copy | 1 (expected: 2 fail) | `717cd73e52bfaf0de25b1d99e4f17a77fad341d1698e2eb59365ad6f25722fa3` |
| repro | helper build + clean copy (§6) | 0 | `f6170bfe754eaadd6b77945ce7a6737729b9e811653f3f989a846add7aebb526` |

**Revision 1 full suite** (`checks/final2/steps.tsv`, runner `checks/run-suite2.sh`, unchanged since):

| Step | Exit | Time | Log sha256 |
|---|---|---|---|
| typecheck | 0 | 9s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| ui-typecheck | 0 | 1s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| db-generate | 0 | 1s | `d33343a4b665f38d3431f51efee9cd3231ce7518266c33c16bf042b52f2e544e` |
| schema-validate | 0 | 0s | `1fa1e06af31f866d939dcbc2f900483ed3ca80ed28d58c5071c0556790d7092f` |
| db-drift | 0 | 1s | `892b13f6d8d0c9be510e7746fe0a02fbdcdeb853749096fa335597962305d6a2` |
| db-pg17 | 0 | 1s | `3ba8dd0aae637f81e7e201c4b7ebb3b77e3928839ed2b161906033bb0c720919` |
| api-build | 0 | 4s | `a6aa931089b464f4c65e4a923b0460b903968733081bc2b5d7806e5f32081592` |
| unit | 1 | 91s | `593b9c6d7b20c6eef12cd7c2f06d14f5d26a171aa1e348bdf62b79edaaa7a38b` |
| test-pg | 0 | 220s | `ed76f3c9bcecca12ac9473f0b461c9c47dd4a64b6e1e40cf29915be5a49bf4ef` |
| test-ui | 0 | 130s | `fbd37772339befa5e7f12fd6effa9b6178968275417decc0ab2e72ce098ee18b` |

Revision 1 earlier superseded run (`checks/final/`): unit 10 fail, test:pg 6 fail; all fixed before `final2` (see the rev1 report §4). That run leaked three throwaway DBs, which I dropped (`checks/cleanup/drop-leaked.log`).

## 3. RC5 coupling (addendum §3/§4) — `tests/reval-rc5-guard.test.ts`

Revision 2 rerun: pass, 2/2. The result is unchanged from revision 1 because revision 2 touched no pinned R-C path. The only built files whose bytes changed are new RS-A outputs under `dist/packages/reval/`, which are outside the RC5 build inventory; `dist/apps/api/src/main.js` and `dist/packages/graph/runtime-role.js` keep their hashes.

**Current tree.** The unchanged `verifyArtifact()` returns `ok:false` with drift exactly `["RC_BUILD_DRIFT","RC_SOURCE_DRIFT"]`.
- **Drifting source paths:** exactly the 14 entries in §7, with old pins asserted.
- **Drifting build paths:** exactly `dist/apps/api/src/main.js` (`0877bd43…` → `7137c74d…`) and `dist/packages/graph/runtime-role.js` (`96b0db70…` → `a63c4723…`).
- **Unchanged:** all six admin overlays are at their RC5 pins, and all 120 RC5 execution files match `S5ASKREMOTE_REVAL_EXECUTION_RC5_MANIFEST.json`.

**Copied immutable views** of the root view (the guard is imported from inside each copy):

| View | Change | Guard result |
|---|---|---|
| Untampered | none | `{ok:true, drift:[]}`, before and after the tampers |
| Source tamper | 1 byte in `packages/actions/approvals.ts` | `["RC_SOURCE_DRIFT"]` |
| Build tamper | 1 byte in `dist/packages/ask/audit.js` | `["RC_BUILD_DRIFT"]` |
| Overlay tamper | wrong hash for `AGENTS.md` | `["ADMIN_OVERLAY_DRIFT","OFFLINE_FILE_DRIFT","RC_SOURCE_DRIFT"]` |

**Delta classification.** Each delta below falls in a BRIEF §10 category and needs the reviewers' decision; I make no acceptance claim.
- **§10 bounded modifications:** `apps/api/src/main.ts`, `packages/graph/runtime-role.ts`, `prisma/{roles.sql,schema.prisma,askremote.prisma}`, `tests/support/{roles-sql.ts,pg-harness.ts}`, `docs/RUNBOOK.md`.
- **§10 "existing parity/invariant tests only where needed":**
  - `tests/context-mapper.test.ts` (rv facts) and `tests/m365-database.test.ts` (status row); the addendum names these two only as candidates.
  - `tests/pg/action-upgrade-s3{b,c}.pg.test.ts` (the new migration added to the frozen later-migration list).
  - `tests/pg/ask-remote-upgrade.pg.test.ts` (`Reval%` excluded from the preserved-privilege snapshot, exactly as `RemoteAsk%` already is).
  - `tests/support/poweroffice-envelope.ts` (excises exactly one inlined `$reval$` block before its unchanged transaction-control scan).

## 4. Current unit failure inventory (exact, per addendum §2)

The revision 2 complete unit log (`checks/repair/unit.log`, sha `7aae404a…6503`) reports `# tests 496, pass 488, fail 8, cancelled 0, skipped 0, todo 0`.

| TAP id | Kind | File / test | Direct cause in the log |
|---|---|---|---|
| 12 | module-load wrapper | `tests/ask-remote-eval-execution-cli.test.ts` | `ExecError: CORPUS_IDENTITY_MISMATCH` from `reject` ← `bindCorpus` (corpus.ts:27) ← `loadContext` (corpus.ts:33) ← test file module load |
| 13 | module-load wrapper | `…-liability.test.ts` | same chain |
| 14 | module-load wrapper | `…-operator.test.ts` | same chain |
| 76 | registered test | `…-pty.test.ts` "real pty: kernel echo stays off …; Ctrl-C finalizes" | `PTY_TEST_TIMEOUT step 1`; identity-caused (probe below) |
| 16 | module-load wrapper | `…-receipt.test.ts` | same chain |
| 17 | module-load wrapper | `…-repair.test.ts` | same chain |
| 18 | module-load wrapper | `…-replay.test.ts` | same chain |
| 19 | module-load wrapper | `…-session.test.ts` | same chain |

**PTY probe** (revision 2 rerun, `checks/repair/pty-probe.log`, sha `ac790dfb…5392`, identical to revision 1): the identical `cli.ts session` argv under a real pty fails with `ExecError: CORPUS_IDENTITY_MISMATCH` via `bindCorpus` ← `loadContext` ← `interactive` (operator.ts:100) ← `runOperatorSession` (operator.ts:68) ← `main` (cli.ts:59), with `exit=1 receipts=0`. Under the test's `cat FIFO | script` pipeline that exit appears as the 90 s timeout.

**Reconciliation against root's FINAL historical inventory** (`HISTORICAL_RC5_FINAL_CHECKS.json` `perFileTestInventory`; its 13 per-file name lists equal my earlier inventory exactly):
- All 13 RC5 test files are byte-identical to their RC5 pins and to the historical view.
- Current result (`checks/repair/rc5-reconcile.json`): corpus 7/7, fixtures 11/11, offline 5/5, supervisor 14/14 and context-budget 1/1 are registered and passing, with names equal.
- The pty test (1) is registered and failing (identity), with its name equal.
- Seven files fail at module load (cli 6, liability 27, operator 4, receipt 5, repair 13, replay 5, session 11), so their tests are blocked and unregistered.

**Totals.**

| Category | Count |
|---|---|
| Executed and passing | 38 |
| Executed and failing (identity) | 1 |
| Failed module-load wrappers | 7 |
| Blocked, unregistered | 71 |
| Historical passed | 110 |

38 + 1 + 71 = 110, with no unexplained difference; the 71 blocked tests are not claimed to have run. All other unit tests pass. That includes the RS-A unit tests (protocol 8, payloads 9, physical-peer 4, static 4, rc5-guard 2 = 27).

## 5. Native fixture proof (required; ran, not skipped) and timings

From `checks/repair/pg-focused.log`, revision 2:
- **Fixture:** descriptor sha256 `13de87997355e8ef5e89f35b982f48494157502eecfd15286b53bde4487969ff`; **PostgreSQL 17.11 (Homebrew)**.
- **Role flags** (actual table owner, runtime, reader): all `super:false, bypassRls:false`. The owner is the dedicated NOSUPERUSER NOBYPASSRLS role that ran the migrations and the `roles.sql` non-superuser branch; admin is used for bootstrap/cleanup only.
- **Start equality:** `postmaster.pid=1791720581`, `pg_postmaster_start_time` floor `1791720581`, `equal=true`. The test asserts this equality, and the full production chain then binds every reader/S/E connection with strict equality.
- **Production chain:** O under a real PTY → C → S → E. APPLIED and NO-OP closures are confirmed; identity ref `rsa-peertoken-unixphys-v1`, `loadedBinding` `UNVERIFIED`.
- **Negatives:** each a fresh config/session. Socket inode, postmaster pid, start −1 s, start +1 s and database OID each give `FAILURE REGISTRATION_MISMATCH` for identity and snapshot, with no S or E backend.
- **Docker launch:** the `pg_stat_activity` cross-check is visible to the reader: VERIFIED.

**Timings** (PTY inter-arrival, Docker TCP seam, regression only):
- IDENTITY: p50 5.7 ms, max 8.6 ms.
- PAUSE_EXPORT: p50 159.6 ms, max 289.6 ms (revision 1: 208.6/255.6 ms). All are inside the 1800 ms budget.

## 6. Reproducibility, build identity and hygiene (`checks/repair/repro.log`, sha `f6170bfe…b526`)

- **Helper:** `node scripts/reval-server/build-peer.ts` exits 0 and gives `9624a353768cfd528538c4c965ad462295da4f8124a17c6d9bc0118248a983c1`. That is identical to revision 1 (two builds there) and to the clean copy.
- **Clean production copy:** `git ls-files -co --exclude-standard` minus `dist/`, copied to a fresh `/tmp` dir with `node_modules` symlinked, then `api:build` and `build-peer`, both exit 0.
  - Inventory of all 202 `dist/{apps,packages}/**/*.js`: `517cc5f8637bbb928a4a946944145bcf5ccdc71d73d7344e3e983bad14281e98` in both checkout and copy.
  - Per-file hashes, equal in both: `main.js` `7137c74d…`, `reval/bridge.js` `4dced89b…`, `runtime-role.js` `a63c4723…`, `packages/reval/physical.js` `c735686b…`, `controller.js` `5d223fa0…`, `codes.js` `b1864509…`, `snapshot-reader.js` `7d42dab8…`, `deps.js` `6573890b…`.
  - The copy was removed afterwards.
- **Whitespace:** `git diff --check` exit 0; no trailing whitespace in the new RS-A files.
- **Manifest** (`checks/repair/manifest.out`, sha `d2763575…`):
  - 14 changed baseline files; missing none; RC5 delta `[]`.
  - The delta versus revision 1 is exactly the 12 revision-2 files listed in §0.
  - Every new RS-A file is ≤ 500 lines, except the byte-exact fixture `tests/support/roles-s5remote.sql` (650).

## 7. Changed and new paths (baseline → current sha256)

| Path | Baseline (RC1 pin) | Current |
|---|---|---|
| `apps/api/src/main.ts` | `278af78d0389619b8801e29c74832dac0db100eada353527725c526c56ce99cc` | `8a83b5ad683ebb91eb8a2d9be683083e4da070c84a53cdf92fbf6fa39f2a9309` |
| `docs/RUNBOOK.md` | `5adc9447bd99a8cab020d02e7a940c7a8446aa9cdd598594bda37902db9a9f4c` | `f36152edc745115aacae8f2e7f50995b1e88b6bbc5d874232ba76d989832e02a` |
| `packages/graph/runtime-role.ts` | `6aac5e454c52de04c27241bd68ff3dc1980428397a37290b7dcbc720324818eb` | `ac0c6c2921e79959cf214e177ab6cce52a999aab02cdc0b7b1f558dde9c74b7f` |
| `prisma/askremote.prisma` | `39455ebf57c1aff9b958e9d6fa3bff7387b6c56829a8e900a273a71647498619` | `83fc46ba34f4cd29a223b40700298a1828bf2672c46442513cdf93729217d0d8` |
| `prisma/roles.sql` | `7a9419b37d1d575ad073abf0837850350879ae9b15c018cc6f0c19809b0d3f69` | `3fde4eca919fe1461f58025be2cf50da1e371f18429ac0f12232d23a269edee8` |
| `prisma/schema.prisma` | `d4ce4995d9dd4540c51cd3beaa4e1f4ecb04d6362d06cd8692a3a4e3b9052bb5` | `b03b28de2cad956949d7170b2311e37c8edeed6ce1ac876e151e03b4f732b898` |
| `tests/context-mapper.test.ts` | `61575892cc6610c2bb265a6e7180ab7b1fb75edd9ab247d990dba791dd98bfd9` | `130c6d05f375956b4232c587bf26b84e1a9e7478ee4a060b98fd887cd522a826` |
| `tests/m365-database.test.ts` | `944fe27dc99f160c4f6ae4d8ce2583b7404b82d0eecec53761cf0a4c5fc6ec78` | `fd04928d1d0a8a0d2b2b35cb0e2b0e4b4df5b0b44ec731ffad91ed0390961e8c` |
| `tests/pg/action-upgrade-s3b.pg.test.ts` | `ba143ca0cbbfc9b08fd060981738801d1f68dde78be9c756193f7de733f33f3b` | `584f43177300fe8e52c99f89211ae1d7484d65b749e72b2ec62f3213f4379227` |
| `tests/pg/action-upgrade-s3c.pg.test.ts` | `65713bd629406ef3ca5affbb1cd384962dda29f5ce7ea4981f179aa035a4fcd2` | `b552d0cb15be4136d62b7dce6c80fe66b26f157df7a432b895685da1981aebb6` |
| `tests/pg/ask-remote-upgrade.pg.test.ts` | `565dcac053af261714c7e03cf9a6e9e755a6bf3db5a87ea3e9cdd0da3f720906` | `35326973cfbef90692e4ba6e7ada0dd8bc14caf55043473d160bfce282b82190` |
| `tests/support/pg-harness.ts` | `5ef48f7e58e314124f1a0db23f1b9a6b09c0238eeaa7cd5cad392e5875bcd56c` | `0fa0842d88ce82dd1a43ee2667b70af14a93011711b275e08f3cf4e5042d90de` |
| `tests/support/poweroffice-envelope.ts` | `681c4458cd223ed37ce7cdbec2c40f6e189d319665d6ab827fcf47d8a0f4a382` | `21f6b61a1b6f9377702aac4b4d9700a263174bb65d477db7cbc8b6bf7d1cd0c4` |
| `tests/support/roles-sql.ts` | `a88d5a22b75e2bca138ac843d2aeeeb8df8dbc4baae6682c66eb8b3fe1b60693` | `f6ae8f486a14e954a601c84b81f2c411a2975a0564d557a56bdb7f642d9b04a4` |

| New path (RS-A, this session) | sha256 | lines |
|---|---|---|
| `apps/api/src/reval/bridge.ts` | `6a73777c8ebcc7d535eb8f41b23843737d15e8c6d05d0ef88b76fe7362b4f92d` | 116 |
| `native/reval-peer/AGENTS.md` | `62cc3e7f962e8e092f8eb26ef0b582a5dabc15cb456bfc0d85293b2366a45a15` | 5 |
| `native/reval-peer/peer.c` | `bc6eb68b9e6ed08d9b4a785028b897ad83d9e8b77cfb10552aa11a09f9bc85bf` | 64 |
| `packages/graph/reval-role.ts` | `7daf4d202867e9b7e0dc4f4496cccee4131482715c91267afd64cf08602105dd` | 240 |
| `packages/reval/AGENTS.md` | `7df14fd32498d7d2980ac0f91b6f4e760afbdd781f7aab87e9af651c7adf0de3` | 12 |
| `packages/reval/channel.ts` | `a41f8c52e656537e62542ef30e5989c7b4392f4ebbe26d9a8fd78cfe547abc34` | 70 |
| `packages/reval/closure.ts` | `4f1697d81639cf5ea2a5dedc708f0148de16874e963bacb41de061528278e0bd` | 66 |
| `packages/reval/codes.ts` | `eef4482054262e9ebd695ebfc7b24bba4774f0aefcf216d1cf89d2bd854a534c` | 84 |
| `packages/reval/config.ts` | `1cfccaf2573210c1366f61782944921f80f1a0b50a36923a9c38b2b2416f7249` | 57 |
| `packages/reval/controller.ts` | `b3fec5494b8da7cb9a04bc27bc6e2d02fbc6c1f5997798676de0e3c6031ea0dd` | 174 |
| `packages/reval/deps.ts` | `33ba93c2c9005dba0edc22f567b73f7515799fddf5898c2f02863a452ffd28a2` | 80 |
| `packages/reval/envelope.ts` | `46573487aec1c294ffe384186eecea0ec101ace4d4d47c18b730fbfc7d182048` | 131 |
| `packages/reval/frame.ts` | `a405e2cea2fa8a2232af7dac140178c8844b7697b9d1c1c13c6f0348bbef7f7e` | 76 |
| `packages/reval/launch.ts` | `cddac72ca0b18dc78f3497d7d06b9caec21ecfeca970aed030b2ba1f12b9e16a` | 81 |
| `packages/reval/owner-cli.ts` | `4f23ebf40c0179890b8c514344744dc576967b7ede86c61bcb8ab2a344996769` | 100 |
| `packages/reval/owner-exec.ts` | `15d1384b3c1958d91a7731d864a50fb9e28a1a807e363275e10429e1ffc494d8` | 141 |
| `packages/reval/pause.ts` | `043d0a54d38ae432e97ec3ea9f8a6217f09e709f92c919369450763a9e47c0e9` | 77 |
| `packages/reval/payloads.ts` | `d8af5f89662891f9cd63998b54031b89f08ed787f27663b543e9cbf599ca065c` | 171 |
| `packages/reval/peer.ts` | `6fed50ef2e0cbb76a8a6bd6a0285f57c534d6f29b23027167f56850d2b7fd454` | 75 |
| `packages/reval/physical.ts` | `9b40f5e9fa1692e41ad0e36c5acfdb8ee36d68694d6730b49b7451b9f7930695` | 93 |
| `packages/reval/private-frames.ts` | `4cf0daa2a63b25e57fb97e132a6ccd075e685fee6fef4732f1d464430a3e498a` | 105 |
| `packages/reval/scalars.ts` | `6352eb1f730a9a5542d773982fd4ec54be2f524b0f6e5c4aaa92e50a90579f25` | 76 |
| `packages/reval/secret-file.ts` | `775b6a9ad3c609c49ad870b35944ce89bc8f1f6207825e485ac6cfdc4079764e` | 55 |
| `packages/reval/server-link.ts` | `2f530f39442c1be86de1602243b7dc24bfe6e0179d23e5c13372656d61702434` | 114 |
| `packages/reval/snapshot-reader.ts` | `59a27cab20e5a0fedaecd3dd4806537b610b465a5853e8ea2288159423a1018f` | 76 |
| `prisma/migrations/202610131000_stage5_reval_registration/migration.sql` | `677aacd5406d0b3ef3545138583bf5b85c49417f5fbfd317c68ca4804b9a8869` | 279 |
| `prisma/reval.prisma` | `631cc117bc198f292442b48668e66166596e3571050b2881000d31eb4cc75cfa` | 38 |
| `prisma/roles/reval.sql` | `a656199369a577619e90312eb68cbb86e4fa99e22da732b912c75d5e5de075f6` | 232 |
| `scripts/reval-server/AGENTS.md` | `d89f85aab75de2ff181b4e75fdf2eba180082e806f4ff993a7707273ec1a446a` | 6 |
| `scripts/reval-server/build-peer.ts` | `7fd537efb495da6150d91c65a943c9c6af9f0a85adc8bbca94ad1af6ac14f7b3` | 29 |
| `scripts/reval-server/controller.ts` | `e062764aaeace36023ccebfd4b560b051f7366e5b5250112b74092e38cf5ca94` | 5 |
| `scripts/reval-server/owner-exec.ts` | `6a331d2bb5c08d261c89e44d123fcc25b6dee36d4b1ad7c4b2ae828a165e144a` | 15 |
| `scripts/reval-server/owner.ts` | `14f21f7a5a4d3a792f1090a244c034a2f95ad2169d78ba022e98e0d13e316353` | 6 |
| `tests/pg/reval-closure.pg.test.ts` | `ef3451d3919271debce923c618a077ee085d0b64cbc14d0f00a60ca8458a6de7` | 227 |
| `tests/pg/reval-launch.pg.test.ts` | `307a421004ccecbb1078a6cae3b8d1e8554ef0edb8f8f366782eee74b8af9364` | 242 |
| `tests/pg/reval-native-unix.pg.test.ts` | `8d0fac5a4bb73be1ae1f32f313c83144e429561509cda572f681ad2bf284d87d` | 128 |
| `tests/pg/reval-roles.pg.test.ts` | `26113b5d4f60ed119d74d6c75135eeff6ca1841bc327bba75afbba71a575fbc3` | 125 |
| `tests/pg/reval-snapshot.pg.test.ts` | `d9775fc14537e86dfe7039b635e27791d0660945ab933f62030217af35ee2b4d` | 230 |
| `tests/pg/reval-upgrade-guard.pg.test.ts` | `cf10cc30795b3a296d95c1c8a756afcc4c579c2d33caf776522aa745e632fc3b` | 97 |
| `tests/reval-payloads.test.ts` | `152f7c686a76f1735b0c28de02f0ee1f6519f2d892af6d5c22cbcd8c165b9146` | 204 |
| `tests/reval-physical-peer.test.ts` | `28c2fe5172bb473ae7a51826ad8ac34ba86ceb26345a72fd7b38f24aab23a027` | 159 |
| `tests/reval-protocol.test.ts` | `3d286e6dd6b6c01b4b2a318d5b5d793d682aaf8747b3b09886463453e022958b` | 172 |
| `tests/reval-rc5-guard.test.ts` | `67e6ff44ace0d1817ce44aea3860ce64e497a3f80aa87dac370a4f70b2d66ff1` | 97 |
| `tests/reval-static.test.ts` | `c4e437c2332cb272be80b89c6d9446c9fa3b8ac5fb87f0de227fef6f01c82366` | 78 |
| `tests/support/reval-nonsuper.ts` | `b8d236fc75b6da5f9626c4c8eff1f411f4ae226e1e3a5bf57ca7a81809702009` | 52 |
| `tests/support/reval-pg.ts` | `88f33dabb54f2ff3a73de41f92c8e5c4c7113ed9c88cd1d760b482eb67c26ff9` | 76 |
| `tests/support/reval-pty.ts` | `23809abc1c1236bbd12672164c4fc1c630df9cd3b76e44958175096def300080` | 62 |
| `tests/support/reval-test-controller-entry.ts` | `e36598999bd62fc266c9e3b1a0688b3f3d789c2ca290d72258f2f990a3509e8b` | 66 |
| `tests/support/reval-test-deps.ts` | `bebab9d56ebaacd45193ee0ed8f22510581543dbdb7ac6d17435c5285f59caf7` | 78 |
| `tests/support/reval-test-exec-entry.ts` | `33bbeab111adcd8805e689b153efcee7877f10285fde4bcc4eceb33687a04fad` | 41 |
| `tests/support/reval-test-owner-entry.ts` | `e9c5f913b81caeb2ecb3a8d78f49e46b905f6d8adc6a37d6e3aed389612340ef` | 18 |
| `tests/support/reval-test-pause-entry.ts` | `5a8c9285b2149088e16ccb2819fc3472e9e3465c438937ad204556249d604e53` | 19 |
| `tests/support/reval-test-server-entry.ts` | `e11289b6e57d9ec6c9d0bfd1e700093cd2fdaaa0b6d0095371531141c4c661d8` | 27 |
| `tests/support/roles-s5remote.sql` | `7a9419b37d1d575ad073abf0837850350879ae9b15c018cc6f0c19809b0d3f69` | 650 |

Root-owned new paths present in the checkout, NOT authored or edited by this session (41): `docs/stage5/ask/remote/reval-server/rs-a/ACCEPTANCE_CHECKS.md`, `docs/stage5/ask/remote/reval-server/rs-a/AGENTS.md`, `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md`, `docs/stage5/ask/remote/reval-server/rs-a/VERIFICATION_ADDENDUM.md`, `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSA_BRIEF_RC1.md`, `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSA_BRIEF_RC2.md`, `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSA_BRIEF_RC3.md`, `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSA_BRIEF_RC4.md`, `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSA_VERIFICATION_ADDENDUM_V1.md`, `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSA_VERIFICATION_ADDENDUM_V2.md`, `docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_BRIEF_RC1.md`, `docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_BRIEF_RC2.md`, `docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_BRIEF_RC3.md`, `docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_BRIEF_RC4.md`, `docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_VERIFICATION_ADDENDUM_V1.md`, `docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_VERIFICATION_ADDENDUM_V2.md`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_AUTHOR_MODEL_EVIDENCE.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_APPROVED.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC1_CHECKS.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC1_MANIFEST.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC1_OPUS_MODEL_EVIDENCE.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC1_PACKAGE.zip`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC2_CHECKS.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC2_MANIFEST.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC2_OPUS_MODEL_EVIDENCE.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC2_PACKAGE.zip`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC3_CHECKS.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC3_MANIFEST.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC3_OPUS_MODEL_EVIDENCE.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC3_PACKAGE.zip`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC4_CHECKS.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC4_MANIFEST.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC4_OPUS_MODEL_EVIDENCE.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC4_PACKAGE.zip`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_DURABLE_HISTORICAL_PRESERVATION.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_HISTORICAL_RC5_VIEW_CHECKS.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_IMPLEMENTATION_BASELINE.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_STATUS.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_VERIFICATION_ADDENDUM_APPROVED.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_VERIFICATION_ADDENDUM_V1_OPUS_MODEL_EVIDENCE.json`, `verification/stage5/S5ASKREMOTE_REVAL_RSA_VERIFICATION_ADDENDUM_V2_OPUS_MODEL_EVIDENCE.json`

## 8. Implementation findings (clarifications for the reviewers)

1. **Prisma `.env` injection.** Importing `@prisma/client` loads the checkout `.env` into `process.env`. `bridge.ts` therefore snapshots `LAUNCH_ENV` when the module is evaluated (it is imported first in `main.ts`), checks URL absence on that snapshot, requires Ask and UI off in both envs, and re-checks `ATLAS_MODE` after `.env` loads.
2. **libuv fd3 token.** With libuv spawn, the child's init touches fd3, so `LOCAL_PEERTOKEN` names the creator or the child even before HELLO. The security property holds because the token is checked only after HELLO and must name the exact child (pid, pidversion, path).
3. **Socket passed as spawn stdio** permanently stops Node reading it. Fixed: the raw `_handle.fd` is passed instead.
4. **Controller reap.** The controller used to hold `busy` while reaping the executor, which caused `OPERATION_BUSY`. Fixed: reaping is asynchronous after the response and awaited at shutdown.
5. **First-exec code-sign assessment.** `warmHelper` handles it: a no-channel run must exit 65.
6. **macOS `/usr/bin/script`** rejects pipe/FIFO stdin. The test-only PTY driver feeds a 0600 regular file with leading padding.
7. **`__CF_USER_TEXT_ENCODING`** is injected by macOS and filtered from the env-allowlist comparison.
8. **fd-leak detector.** Sockets are classified structurally (only fd3 is allowed), with lsof for live processes.
9. **S inner-ack** uses zero digests and ref `rsa-server-inner-ack-v1`, a self-report and never evidence.
10. **Errno vs SQLSTATE.** `sqlStateOf()` requires `severity`, so Node errno codes are not mistaken for SQLSTATEs.

(Revision 1's items "controller exit codes 13/14/15" and "0..5 s start window" were requirement violations. Revision 2 removed both (§0); they are not residuals.)

## 9. Residuals (open, inherent to the approved design; not requirement violations)

- **Helper TOCTOU:** the binary is hashed, then exec'd by path; the full image is `UNVERIFIED` (BRIEF §2; RS-D).
- **Socket swap:** the window between checks is detected only at the next IDENTITY physical recheck (BRIEF §3 residual).
- **Passwords in memory:** they are resident as JS strings until GC or exit (BRIEF residual; E is short-lived).
- **RC5 compatibility is PENDING.** The unchanged RC5 instrument refuses the current tree (§3/§4) until a separately approved re-pin; I adopted nothing.
- **A3 production path:** RS-A refuses until RS-B registration, by design.
- **Delta classification:** 6 parity/invariant test deltas (§3) are §10-category deltas for the reviewers' decision.
- **Native fixture postgres** (root-provisioned): left running, not modified.

## 10. Process state, cleanup and ownership

- **Stopped:** all my writers and test children; `pgrep` finds none, and no background task remains.
- **Revision 2 cleanup** (`checks/repair/native-leftovers.log`):
  - Docker: only the 5 older foreign DBs remain; 0 stray test roles.
  - Native cluster: no databases, and the only `atlas_*` role is the fixture admin.
- **Root-owned state untouched:** no commits/pushes/deploys; no root-owned requirement, seal, status or historical file was modified.

**Checkout write ownership is explicitly RETURNED to root, for TWO NEW CLEAN code acceptance reviewers.** Related fixes resume in this same session (642adc68) only on request.
