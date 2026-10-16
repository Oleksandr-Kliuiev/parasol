# OPUS — RS-A rc1 independent INITIAL code acceptance review

- **Artifact:** `S5ASKREMOTE-REVAL-RSA-rc1`. packageHash `1f5cd250970daab57b5004ce291abe04d4ef42961c57450d6a15ac2fcea0a05c`.
- **Frozen files:**
  - `verification/stage5/S5ASKREMOTE_REVAL_RSA_RC1_MANIFEST.json` sha256 `f68c45bf…34ee`
  - `…_RC1_CHECKS.json` `02d49195…0f50f`
  - `…_RC1_PACKAGE.zip` `084b5cfb…b014`
  - `…_RC1_BUILD_INVENTORY.json` `a32ad733…605a`
  - `…_RC1_LINEAGE.json` `752909a4…7fb`
- **Requirements (inputs, approved):**
  - BRIEF rc4 package `e8f87336…f85040`: `IMPLEMENTATION_BRIEF.md` `caa8a5b4…aaa`, `ACCEPTANCE_CHECKS.md` `5b2b3062…410`.
  - `VERIFICATION_ADDENDUM.md` `59c2fd7f…dc99dc` (DUAL_APPROVED seal present).
  - Parent SERVER-DESIGN rc4 `9fa16222…8163`.
- **Reviewer role:** fresh, independent, read-only code acceptance reviewer, RS-A gate (Opus side).
  - I did not read the implementer conversation or stream, any other reviewer's verdict or report, or `docs/stage5/reviews/*`.
  - I made no repository edits, DB mutations, network or provider calls, or activation. Paid product calls: 0.
- **Date (UTC):** 2026-10-11.

## Verdict: **CHANGES_REQUIRED**

The RS-A core is largely sound and well tested:
- SQL scope, the atomic census, confinement, the ALWAYS guard, the E transaction, the Darwin peer proof, physical binding, and the native production PTY chain.

However, one protocol defect is confirmed on the frozen code: the brief-mandated byte-cap outcome is not delivered (F1). Two smaller contract deviations, several unexercised required acceptance checks, and two evidence and scope qualifications also need resolution before RS-A can be accepted. Required findings: **5** (1×P2, 4×P3).

Approval of any later revision covers only that exact code, checks and evidence identity.

---

## 1. Identity and integrity verification (performed by me)

**Artifact integrity**

| Check | Result |
|---|---|
| packageHash recomputed: sha256 of the compact sorted `{path,sha256}` array of 338 entries (sorted, unique) | `1f5cd250…a05c` ✔ |
| All 338 worktree files vs manifest | 0 mismatches ✔ |
| ZIP: 338 entries vs manifest (extra, missing or hash) | 0 mismatches ✔ |

**Baseline and frozen dependencies**

| Check | Result |
|---|---|
| Baseline `S5ASKREMOTE_REVAL_RSA_IMPLEMENTATION_BASELINE.json` (sha `62328bcb…4347`, 1540 entries) vs checkout | exactly the 14 declared changed paths, 0 missing ✔ |
| RC5 execution manifest, 120 files | all unchanged ✔ |
| RC4 design manifest, 38 entries | only `prisma/askremote.prisma` and `prisma/roles.sql` differ: allowed child modifications; the RC4 normative docs are exact ✔ |
| Accepted migrations, `packages/ask/**`, `apps/operator/**`, connectors, `package.json`, `package-lock.json` | unchanged vs baseline ✔ |
| Tracked `verification/` and historical seals | unmodified ✔ |
| Six RC5 admin overlays (current checkout) | all AT_PIN ✔ |

**Baseline bytes of the changed files**
- I extracted them from the pinned R-C source ZIP (`4cace5d3…d3c4`); each matches its baseline hash exactly. All deltas reviewed in §4 are true baseline→current diffs, not HEAD diffs.

**Build identity**

| Check | Result |
|---|---|
| Manifest dist entries vs on-disk `dist/{apps,packages,native}` | 203 = 203, exact set ✔ |
| R-C builtInventory drift | only `dist/apps/api/src/main.js` and `dist/packages/graph/runtime-role.js` ✔ |
| Clean JS rebuild: `tsc -p apps/api/tsconfig.json --outDir /tmp/…` | all 202 `.js` byte-identical to checkout `dist` ✔ |
| Helper rebuild into `/tmp` with the fixed clang command | sha `9624a353…83c1` = checkout `dist/native/reval-peer` = report ✔ |

**Durable historical preservation (read-only)**

| Check | Result |
|---|---|
| `RC5_PINNED_ADMIN_OVERLAYS.zip` | sha `2fade663…7619`, 6 entries, each at its pin ✔ |
| `RC_RC1_VERIFIED_BUILD.zip` | sha `b2dc34c4…d001`, 244 entries, all = R-C builtInventory, none missing ✔ |

**Evidence log hashes (all equal the CHECKS and report values)**
- `repair/unit.log` `7aae404a…`
- `repair/pg-focused.log` `230bd383…`
- `repair/rc5-current.tap` `be8c0d7b…`
- `repair/rc5-reconcile.json` `2146e193…`
- `repair/mutation.log` `717cd73e…`
- `repair/repro.log` `f6170bfe…`
- `final2/test-pg.log` `ed76f3c9…`
- `final2/test-ui.log` `fbd37772…`
- `historical-rc5-final-tests.log` `0eb98e5c…`
- `HISTORICAL_RC5_FINAL_CHECKS.json` `d90892a8…`

**Post-review re-verification:** packageHash, files and ZIP were unchanged after all my pure runs. These wrote only under `/tmp/rsa-review-*` and touched no checkout, dist, archive or DB.

---

## 2. Required findings (prioritized)

### F1 — P2 — The 256 KiB byte-cap outcome is not delivered: the SNAPSHOT response skips a sequence number, and the reread has no byte cap

**Paths and lines**
- `packages/reval/controller.ts:86-92` (`respond`). The first attempt calls `state.send.take()` (`:88`). On `FrameError` from `owner.send`, the fallback calls `state.send.take()` again (`:90`).
- `packages/reval/envelope.ts:84`: `Sequence.take()` always advances.
- `packages/reval/owner-cli.ts:91-96`: O validates with `checkResponse` (exact next sequence), prints `FAILURE PROTOCOL_INVALID` and ends the session.
- No reader-level size check exists:
  - `packages/reval/snapshot-reader.ts:68-76` (`exportSnapshot`)
  - the reread closure `packages/reval/controller.ts:73-77`
  - `packages/reval/pause.ts:63-66`

**Trigger (confirmed by an in-process repro on the frozen code)**
- I drove the real `createController` with fake deps (no DB) and a schema- and relation-valid snapshot of 700 registered attempts. That is within the routine's 1000-attempt bound, and the envelope is over 256 KiB.
- C answered `FAILURE {code:CENSUS_LIMIT_EXCEEDED}` with `sequence:"2"` for request sequence `"1"`. The production requester check returned `SEQUENCE_INVALID`.
- Control run with 10 attempts: `sequence:"1"`, check `null`.

**Impact**
- BRIEF §7 requires "Envelope >256 KiB → `CENSUS_LIMIT_EXCEEDED`. Never a truncated success." The no-truncation half holds. The mandated code never reaches O: O shows `FAILURE PROTOCOL_INVALID` and tears the session down.
- BRIEF §4 and ACCEPTANCE_CHECKS list "byte cap" among reread failures after `CONFIRMED_COMMIT` (→ `CONTAINMENT_UNCONFIRMED` + latch). §4 also notes as a residual that "census limits … block confirmation". The reread path applies no byte cap, so an over-cap census after a confirmed commit yields a `CLOSURE` where the closed phase map requires latch/no closure.
- The closure content itself (policy/fence) is still correct. The deviation is from the closed outcome map, not a false containment claim.

**Existing tests miss it**
- `tests/pg/reval-snapshot.pg.test.ts:154-166` only asserts that `encodeFrame` throws.
- `tests/reval-payloads.test.ts:93` exercises only the pure `closureAfterReread(…, null, …)`.
- Neither covers the controller response path nor the real reread.

**Required**
1. Make the byte cap a deterministic reader-level check: same measure for SNAPSHOT and the reread, on the would-be exported envelope.
2. Fix the response sequencing so one request yields exactly one response with the next sequence number.
3. SNAPSHOT over cap → `FAILURE CENSUS_LIMIT_EXCEEDED` delivered and validated by O. Reread over cap → `CONTAINMENT_UNCONFIRMED` + latch.

**Required check:** add both cases through the real controller/O validation path and through `pauseExport` with the real reread (PG17 synthetic ledger as in the existing 700-row test), plus a sequence-continuity assertion on the subsequent request.

### F2 — P3 — Owner authentication failure at E's connect maps to `REGISTRATION_MISMATCH`; the §6 `OWNER_REQUIRED` row is unreachable

**Paths and lines**
- `packages/reval/physical.ts:76-77` wraps every `connect` rejection, including SQLSTATE 28P01 and 28000, into `PhysicalMismatchError('connect')`.
- `packages/reval/owner-exec.ts:62-63` maps that to `REGISTRATION_MISMATCH`.
- `refusedCodeFor('28P01'|'28000') → OWNER_REQUIRED` (`packages/reval/closure.ts:49`) is therefore never reached from the production E chain. Authentication only happens at connect.

**Trigger:** a valid physical tuple with a wrong or rotated owner password, or an owner role that cannot log in.

**Impact**
- The closed phase/outcome map (BRIEF §6: "Valid REFUSED: 28P01/28000 auth failure, 42501 not owner → `OWNER_REQUIRED`") is not implemented for its only reachable occurrence. The operator gets a misleading `REGISTRATION_MISMATCH`.
- Fail-closed and no latch, so no safety impact.
- I note the tension with §3 ("Any failure → `REGISTRATION_MISMATCH`" for steps 1–6). The §6 row is more specific and would otherwise be dead.

**Required:** either
- (a) let the physical connect step surface a pg authentication SQLSTATE distinctly, so that E answers `OWNER_REQUIRED` (filesystem, socket and identity mismatches stay `REGISTRATION_MISMATCH`), or
- (b) obtain an explicit root/brief clarification that §3 supersedes the §6 row for E.

**Required check:** a real-E PG test with a wrong owner password asserting the chosen code. The ACCEPTANCE_CHECKS "each REFUSED code mapping (…, 28P01, …)" is currently satisfied only by the pure mapping unit.

### F3 — P3 — Several listed ACCEPTANCE_CHECKS have no test (the checks file: "Every listed check is required")

I verified each by targeted search of `tests/reval-*.test.ts`, `tests/pg/reval-*.pg.test.ts` and `tests/support/reval-*`.

1. **§2e handshake-order negatives are absent.**
   - Not tested: "child that receives any frame before its HELLO, or no HELLO in 1 s, aborts"; C refusing "HELLO after another frame" or a missing HELLO.
   - Code paths: `server-link.ts:48` (1000 ms), `pause.ts:44`, `owner-exec.ts:132-133` (helloNonce binding), `apps/api/src/reval/bridge.ts:72-74`.
   - Note: E structurally rejects a pre-HELLO frame via helloNonce. S's `RevalServerLaunchV1` carries no nonce (per the brief's field list), so S cannot detect it. Either test the detectable cases or record that limitation explicitly.
   - The "secret-read/DB-connect not before the verified frame" property holds structurally (paths arrive only in the verified frame).
2. **Closure: "concurrent reserve/revoke/settle" is not exercised.**
   - `tests/pg/reval-closure.pg.test.ts` has a policy lock holder and drift-between-commit-and-reread, but no concurrent runtime reserve, revoke or settle against an in-flight E.
3. **"REVOKED/TOMBSTONE refused without call": only REVOKED is tested** (`reval-closure.pg.test.ts:130`). There is no TOMBSTONE pre-state case (`owner-exec.ts:84`).
4. **Snapshot "pricing as actual confined definer: … >8 tuples (RV004)" is not run against the real routine on PG17** (`migration.sql:184-186`). Only the SQLSTATE→code mapping is unit-tested (`tests/reval-payloads.test.ts:131`).
5. **Platform/helper gate: "O displays the locally mapped code" is not tested.**
   - Covers `exitCodeDisplay` (`codes.ts:72-78`), `owner-cli.ts:71-74` and the C exit-12 peer path (`controller.ts:52`).
   - The gate test (`tests/reval-physical-peer.test.ts:147-159`) covers only 10/11 and the static set {10,11,12}.

**Impact:** required checks for confinement, ordering and outcome codes are claimed covered (`requirementViolationsKnown: 0`) but are not. Item 4 also leaves the RV004 SQL unexecuted on PG17.

**Required:** add the missing tests (meaningful, with negative controls where applicable) or obtain an explicit root waiver per item, recorded in the next CHECKS. Do not weaken existing tests.

### F4 — P3 — §10 allowed-path conformance: undisclosed additional new paths

**Additional new paths**
- `packages/reval/{channel,config,deps,pause,server-link}.ts`: 5 production modules, absent from BRIEF §10's enumerated `packages/reval/{…}.ts` list.
- `tests/support/{reval-nonsuper,reval-pg,reval-pty,reval-test-pause-entry}.ts`: 4 helpers, outside the enumerated `tests/support/reval-test-{deps,owner-entry,controller-entry,server-entry,exec-entry}.ts`.

**Why this matters**
- ACCEPTANCE_CHECKS requires "changed/new file list equals brief §10".
- The report's §3 "delta classification" and CHECKS `requirementViolationsKnown: 0` do not disclose them.
- Each file is ≤500 lines and lies inside RS-A-owned directories. The static test does cover the production modules, so I see no security impact. This is a scope and record defect.

**Required**
- Disclose the deviation.
- Then either obtain an explicit root classification of these 9 paths as within §10 intent (recommended: no code churn), or fold them into enumerated modules.
- Record the decision in the next manifest/report.

**Same record: `tests/support/poweroffice-envelope.ts`.** It is a support module rather than a test file. I accept its delta on the merits (§4), but root should record its classification under "existing parity/invariant … only where needed".

### F5 — P3 — Evidence renewal and qualification

1. **Required suite not rerun on the current revision.**
   - The current revision (rev 2) has no full `test:pg` or `test:ui` run on its own bytes. The 712/712 and UI 86 results belong to rev 1, before the bounded contract repair.
   - The rev-2 edits (`packages/reval/{physical,snapshot-reader,deps,controller,codes}.ts`) are reached outside RS-A tests only through `apps/api/src/main.ts`→`bridge.ts` module load.
   - Module load of the current dist is shown by the bridge-mode spawns in the focused launch/native tests, and the non-bridge `main.ts` path is source-unchanged. So I judge the residual risk low for rev 2 itself.
   - However, the F1–F3 repairs will change code. The complete required suite must run on the repaired identity:
     - `npm run test:pg`, all PG17 files with the native fixture set and no skip
     - `test:ui`, `ui:typecheck`, `schema:validate`, `db:check:drift`, `db:check:pg17`, `typecheck`, `api:build`
     - the complete unfiltered unit run with exact identity-only qualification
     - helper and dist reproducibility, and the copied-view tamper test
   - Do not label rev-1 full results as current.
2. **TAP 76 qualification is indirect** (`tests/ask-remote-eval-execution-pty.test.ts`).
   - The test's own output is `PTY_TEST_TIMEOUT step 1`. Addendum §3 requires that each failure's "output must directly establish CORPUS_IDENTITY_MISMATCH".
   - The causal chain is persuasive but out-of-band:
     - Step 1 means the banner printed.
     - `repair/pty-probe.log` shows the identical argv printing the banner and then `ExecError: CORPUS_IDENTITY_MISMATCH`, `exit=1`.
     - The same unmodified test passes in the historical view (110/110).
   - **Required:** in the renewed evidence run, either capture direct per-run causal evidence for TAP 76 within the same run (e.g., a differential with the RC5 PTY test and the probe recorded together), or have root explicitly accept the probe as the causal record under the addendum. Do not count it as directly established otherwise.

---

## 3. Obligation-by-obligation assessment (current frozen code)

### SQL scope and atomic census (`prisma/migrations/202610131000_stage5_reval_registration/migration.sql`) — ✔ except F1/F3.4

**Snapshot routine**
- No arguments, SECURITY DEFINER, VOLATILE, `SET search_path = pg_catalog, pg_temp`.
- Every relation and function is schema-qualified. Operators and functions are never resolved from pg_temp, and pg_catalog types win.

**Selection and scope**
- Requires RR + read-only + `role='none'` (RV002).
- Clears five `app.*` settings first, then selects by the explicit predicate `evidenceReaderRoleOid = session_user OID`: exactly 1 row, else RV001.
- Re-selects by registrationId plus the predicate with whole-row equality, then requires the policy, the client admission row (`:176-179`) and the fence.

**Pricing and bounds**
- Pricing tuples: the policy and DISTINCT tuples over all project attempts; >8 → RV004 (`:184-186`).
- Binding missing → RV005.
- Bounds checked before output: attempts ≤1000; all project counter rows (orphans included) plus synthesized current periods ≤2000 → RV003.

**Integrity**
- Missing referenced counter → RV006.
- Every counter row, orphans included, is compared with the SUM over its period → `consistent`.
- Exported `chargedMicroUsd` is the actual counter value.
- Times use `date_trunc('milliseconds')` then UTC formatting (truncate, never round).
- Periods are ordered MONTH then DAY; attempts are limited to registered client+actor with a foreign count only.

**RLS semantics**
- RemoteAsk tables have workspace-only policies, and attempt `clientId`/`actorId` are NOT NULL. So the census and foreign counts are complete once `app.workspace_id` is set from the registration.

**PG17 evidence (rev 2):** cross-registration isolation, stale `app.*` ignored, recreated OID → RV001, SET ROLE/RC/RW → RV002, the VOLATILE split-read counterexample, foreign counts, late settlement, zero synthesis, RV006, orphans/2000, 1001 → RV003, ACCESS EXCLUSIVE timeout, concurrency stability, RV005, pg_temp shadows, and the admission-row RV001 case all pass.

### Grants and complete effective capability (`prisma/roles/reval.sql`, `packages/graph/reval-role.ts`) — ✔

**Provisioning and distinctness**
- `roles.sql` delta: 3 doc lines plus `\ir roles/reval.sql` (650→654 lines). The accepted block is byte-unchanged vs the pinned copy.
- The definer and reader are distinct from each other and from the eight principals.
- Create/validate enforces NOINHERIT/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS and `rolconfig` NULL.
- No memberships except the owner link. The owner's `INHERIT FALSE, SET TRUE` link on the definer matches the accepted precedent for the other definers (`roles.sql:320/343/365/413`).

**Grants**
- Definer: exact column allowlist, including both attempt rates (byte-equal TS/SQL lists, static test), plus the role-specific registration policy.
- Snapshot owned by the definer, with an ACL reset; reader EXECUTE only, no grant option.
- Guard owned by the table owner, owner-only.
- Runtime: no Reval privilege and no EXECUTE.

**Postconditions, for both roles**
- Every user relation, column, sequence and type.
- Routines (only the PUBLIC, non-SECURITY-DEFINER, `v_reval_shared` byte-equal helpers).
- Schema CREATE/ownership/ACL, grant options, built-in escalation via `pg_init_privs`, database CREATE, parameter ACL, language/type/LO/FDW/server/user-mapping/default-ACL/shdepend/tablespace.
- Plus `atlas_reval_%` = 2 and four ALWAYS triggers.

**Readiness and evidence**
- `reval-role.ts` (240 lines) mirrors the rules structurally, plus FORCE RLS, exact policies, contract CHECKs, FKs and runtime negatives. `runtime-role.ts` adds +6 lines.
- PG17 role tests cover every listed EXECUTE/membership/parameter/default-privilege/ownership/grant-option negative, plus idempotent reprovisioning (catalog equality).

### ALWAYS guard and upgrade — ✔

**Guard (`migration.sql:74-112`)**
- Plain invoker function with a fixed search_path.
- Writer identity requires current_user to own both the guard and the target table.
- Registration UPDATE/DELETE/TRUNCATE and binding DELETE/TRUNCATE are refused, also for the owner.
- Binding identity is immutable, generation strictly increases, and `installedAt` is forced to DB time (ms).
- All four triggers are ENABLE ALWAYS.

**Tests:** the pre-roles.sql window, an explicit non-owner INSERT, replica mode, a pg_temp `clock_timestamp` shadow, FKs, and the upgrade from `202610121000` + `roles-s5remote.sql` with remote data unchanged all pass.

**Prisma:** exactly the 4 inverse relation lists (Client, Actor, RemoteAskPolicy, RemoteAskClientAdmission), none on Workspace. `schema:validate` and `db:check:drift` were exit 0 in rev 1, and rev 2 touched no schema.

### Darwin peer proof, TTY, inheritance and HELLO order — ✔ except F3.1

**Native helper (`native/reval-peer/peer.c`)**
- Race-free order: token1 → pidinfo → `proc_pidpath_audittoken(token1)` → token2==token1.
- Exact 8-key output, `e_tdev` for the TTY.

**`packages/reval/peer.ts`**
- realpath/uid/mode/sha pin check, fds 0–4 only, 500 ms kill, closed parser.
- `childPeerOk`/`parentPeerOk` cover exactly pid, ppid, euid, exe and TTY.
- Re-proof uses `sameIncarnation` (pid and pidversion).

**Controller order:** platform → helper (exits 10/11) → O's first frame → peer proof plus unchanged ppid plus C has no TTY (exit 12). After the proof, failures are authenticated `FAILURE` responses.

**Evidence**
- Real helper tests (grandchild, wrong exe, hang, changed incarnation).
- Live C/S have no TTY; S has no children.
- The fd-leak detector covers parent sentinels and has a self-test, and the helper's fds are inspected externally with lsof.
- Disclosed deviation: libuv touches fd 3, so a pre-HELLO token names the creator or the child, never a third process. The security property holds because proof runs only after HELLO and must match the exact pid, pidversion and path.

### Physical binding of the reader, S and E; credential absence — ✔ except F2

**`packages/reval/physical.ts`**
- realpath identity, no symlink, ancestors not group/world-writable unless sticky.
- Socket dev/ino and postmaster.pid lines equal and the pid is live; connect only with `host: socketDir`.
- Fixed physical query with exact equality, including the start epoch (the rev-2 tolerance removal is verified, with ±1 s negatives).
- Repeats the filesystem check after connecting; any failure ends the connection before another statement.

**Per process**
- C: reader recheck on every IDENTITY.
- S: verifies itself (`bridge.ts:77`), then C compares the observed tuple and `pg_stat_activity` (VERIFIED, `server-link.ts:56-63`).
- E: verifies before any statement.
- Native test: `client_addr IS NULL` for every RS-A backend, including S's Prisma pool.

**Credentials**
- Closed secret format (regex, O_NOFOLLOW, inode recheck); the Buffer is zero-filled.
- C opens only the reader secret (spy).
- No credentials in frames, argv or env (`ps eww`, transcript and probes).

### Strict protocol and fail-closed deferred operations — ✔ except F1

- Framing: u32 BE length, cap checked before buffering, strict UTF-8 with no BOM, `parseStrictJson` duplicate rejection, lone-surrogate rejection, no trailing data.
- Private frames are ≤4 KiB with separate decoders, and cross-decoding is refused.
- Envelopes are exact. Sequence, challenge, binding and `OPERATION_BUSY` follow the brief.
- The direction table and pure authorizer apply `OWNER_REQUIRED`/`WRONG_DIRECTION` before effects.
- Exact fail-closed codes, with S answering non-IDENTITY operations the same way.
- `FailureCode` is exactly the 43 codes, tested against the 06 text.

### Owner pause: SQL preservation, pre-state branch, whole-row check, exact one row, call always, no-op COMMIT — ✔ except F2/F3.2–3

**E transaction (`packages/reval/owner-exec.ts:57-113`)**
- READ COMMITTED, then clear/set `app.*`.
- FORCE-RLS registration read on all six identifiers, before any lock.
- Fence `FOR UPDATE`, then policy `FOR UPDATE` (fence-first is proven by NOWAIT).
- Expected version check, then REVOKED/TOMBSTONE → refuse with no call.

**Fingerprints and the revise call**
- SQL-side `sha256(convert_to(to_jsonb(p)::text,'UTF8'))` full and rest fingerprints.
- The revise is ONE statement passing every argument from the locked row, so microseconds are preserved: APPLIED keeps `expiresAt` with nonzero µs.
- Exactly one row with value `expected`/`expected+1`, else `POLICY_CHANGED`.

**Postconditions, bound to the pre-state**
- PAUSED → full equality, same version and fence.
- ACTIVE/INACTIVE → rest equality, v+1, PAUSED/OWNER, fence+1.

**Commit handling**
- COMMIT gives `CONFIRMED_COMMIT`; failure after COMMIT was sent gives `COMMIT_UNKNOWN`. REFUSED is returned only before COMMIT is sent.
- MODEL_MISMATCH stays unchanged on the no-op path, and the routine call is captured.
- Test seams (`ExecHooks`) are reachable only from test entries; the production `scripts/reval-server/owner-exec.ts` passes none.

### Budget, lifetime, parent loss, cleanup, no retry, latch, reread, four keys — ✔ except F1

**Budget**
- One `B=1800`. `requestBy=D−1200`, `DE=D−400`, `rereadBy=D−50`.
- `remainingMs` clamped to 1..1400. E timeouts are `max(1,min(1400,…−50))`; E's timer is relative and monotonic.

**Lifetime and cleanup**
- E exits on fd-3 close or its deadline. Cleanup is SIGKILL plus reap, run after the response.
- A single spawn with no retry, and a latch with no spawn afterwards.

**Reread and closure:** exact equality with E's committed tuple, strictly above both floors (BigInt), and exactly four keys.

**PG17 real-E tests**
- blackhole, then lock-blocked (`DEADLINE`, no latch, no owner backend within 1500 ms)
- killed after COMMIT (latch), then parent SIGKILL mid-transaction (E exits, transaction aborted)
- ack lost (latch), then drift via revise, client_set or fence bump (latch)
- skipScope, then a wrong owner DB (refused before any lock or statement)

### Pricing and actual columns — ✔ except F3.4

- The policy tuple (profile, priceRevision, reserve) is compared with the accepted constants plus `approvedPriceRevision`; attempts must be empty or the exact single tuple; otherwise `POLICY_CHANGED`.
- Literals 275/825/300000 are pinned against the accepted CHECK text (static test).
- Pricing and priceRevision are never exported.

### No DI bypass in production; native production PTY end-to-end — ✔

**Production entries**
- `scripts/reval-server/{owner,controller,owner-exec}.ts` use only `PRODUCTION_ENTRIES`/`productionDeps()`.
- The static test forbids test-support imports and TCP, fixture, TTY or peer selectors, and restricts env reads (≥24 production files).
- `main.ts` has a 4-line hook plus a comment; without `ATLAS_REVAL_BRIDGE_FD` it is unchanged. In bridge mode, Ask, operator UI and an env URL are refused (exit 40/42 tested).

**Native chain (rev-2 log, PG 17.11 Homebrew, descriptor sha `13de8799…69ff`)**
- Production `owner.ts` under `/usr/bin/script` → `productionDeps` → built `main.js` bridge → production E → pinned helper.
- Owner/runtime/reader: super=false, bypassRls=false.
- `postmaster.pid` start equals the query floor.
- IDENTITY `UNVERIFIED`/`rsa-peertoken-unixphys-v1`, an exact SNAPSHOT, and APPLIED and NO-OP closures.
- Five physical negatives give `FAILURE REGISTRATION_MISMATCH` with no S or E backend. Ran, not skipped.

### Six parity/invariant deltas (bounded §10 review) — accepted on merits

All six were reviewed as baseline→current diffs. Each is the minimum needed for the new migration, role or readiness facts, and none weakens its original invariant:
1. `tests/context-mapper.test.ts` adds the rv* facts to the "ok" object and one fail-closed case per fact.
2. `tests/m365-database.test.ts` adds the 4th password, its no-leak assertion and the extra boolean status row.
3. and 4. `tests/pg/action-upgrade-s3{b,c}.pg.test.ts` append the new migration to the frozen later-migration list; the accepted ones stay asserted.
5. `tests/pg/ask-remote-upgrade.pg.test.ts` excludes `Reval%` from the preserved runtime-privilege snapshot, mirroring `RemoteAsk%`. Runtime Reval absence is enforced by readiness and the role tests.
6. `tests/support/poweroffice-envelope.ts` requires exactly one `$reval$` block after `$roles$` and still forbids transaction control in every outside part. Classification record: see F4.

**Other bounded modifications (all within limits)**
- `roles-sql.ts`: single include inlined once, 2 settings, optional 4th password, historical renders unchanged via `PRE_RSA_PASSWORDS`.
- `pg-harness.ts`: the new role fields.
- RUNBOOK: provisioning text and owner display. Its one trailing-space line predates RS-A.

### Ancestors, UI, finance and RC5 unchanged — ✔

- No accepted migration, financial routine, `packages/ask/**`, `apps/operator/**`, connector or browser change. RC5 delta is 0.
- The six overlays are at their pins.

**Verification addendum (§1–§4)**
- §1: durable archives verified (see §1).
- §2: historical view proof. Guard ok with exact identity before and after, 1252 source / 244 build / 120 RC5 files, Node v25.8.1 and lock sha recorded, all 13 files 110/110 with 0 skip/cancel/todo.
- §3: current unfiltered unit run qualified nonzero: 496 reported, 488 pass, 8 fail.
  - 7 module-load wrappers, each with a `CORPUS_IDENTITY_MISMATCH` stack in the log.
  - 1 registered PTY test (TAP 76; see F5.2).
  - Reconciliation: 38 executed and passing + 1 failing + 71 blocked/unregistered = 110 historical, names equal, all 13 RC5 test files byte-equal to their pins.
  - Current `verifyArtifact().drift` is exactly `[RC_BUILD_DRIFT, RC_SOURCE_DRIFT]`, and the path sets equal the 14 source and 2 build deltas.
- §4: the three copied-view tampers each detect.
  - The overlay tamper reports `ADMIN_OVERLAY_DRIFT` plus `OFFLINE_FILE_DRIFT` and `RC_SOURCE_DRIFT`, because the overlay is also a pinned source/offline file; the test asserts inclusion. The tampers are isolated by separate copies, and I consider this conformant.
- RC5 compatibility with the RS-A image remains PENDING; no re-pin was adopted.

---

## 4. Tests: verified by me vs not run

**Run by me** (pure; no DB, network, provider or checkout writes)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `tsc -p apps/api/tsconfig.json --outDir /tmp/rsa-review-build` | exit 0; 202/202 `.js` byte-identical to `dist` |
| `node scripts/reval-server/build-peer.ts /tmp/rsa-review-peer` | sha `9624a353…83c1`, identical |
| `node --test tests/reval-{protocol,payloads,static,physical-peer,rc5-guard}.test.ts tests/context-mapper.test.ts tests/m365-database.test.ts` | 39 tests: 38 pass, 0 fail, 1 skipped (tamper test without the view env) |
| `ATLAS_REVAL_RC5_HISTORICAL_VIEW=<root view> node --test tests/reval-rc5-guard.test.ts` | 2/2 pass; tamper outputs identical to the evidence |
| F1 repro (`/tmp/rsa-review-scripts/seq_repro.ts`, real `createController`, fake deps) | confirms the defect; 10-attempt control passes |
| `git diff --check` | exit 0 |
| Whitespace and line limits on the new and changed files | `packages/reval` ≤500 lines, `reval-role.ts` 240, `roles.sql` 654, routing AGENTS 12/6/5 lines |

**Not run by me** (inspected frozen logs and hashes only; mutating, DB-bound or long)

| Check | Status |
|---|---|
| Full `npm run test:pg` | rev 1: 712/712, 0 skip, native ran. Includes `api:build`, so mutating |
| Focused PG, 6 RS-A files | rev 2: 26/26, 0 skip, native ran |
| `test:ui` | rev 1: 86 passed |
| `ui:typecheck`, `db:generate`, `schema:validate`, `db:check:drift`, `db:check:pg17` | rev 1, all exit 0 |
| Complete unfiltered unit | rev 2 log inspected as qualified above |
| Historical view 110/110 | receipt and log hashes inspected |
| Mutation check | log hash only |

---

## 5. Non-blocking observations and residual risks

**Non-blocking observations**
1. **Reader state after a failed reread.** `controller.ts:73-77`: a reread failure does not set `readerDirty`. After a reread wall-timeout with an in-flight query, the next SNAPSHOT can fail once with `INTERNAL_FAILURE` (25P02) before recovering. Suggest marking the reader dirty on any reread failure.
2. **Reconnects run outside the operation deadline.** `ensureReader` reconnects (fixed 300 ms connect plus a `PHYSICAL_QUERY` without `statement_timeout`), and `recheckReader` also runs without a statement timeout. A hung backend can therefore push C past D; it is bounded by O's 2 s deadline and teardown. Suggest deriving these timeouts from the operation deadline.
3. **E's per-statement timeouts can add up past DE.** They are computed once (brief formula), so they can cumulatively exceed DE; the owner backend stays bounded at about DE+1350 < D+1500. PG17 `transaction_timeout` could tighten this.
4. **Ancestor check is mode-based only.** The socket-dir ancestor check does not verify the owner uid; a directory owned by another non-root user passes. Within the same-UID trust boundary; consider requiring owner ∈ {0, euid}.
5. **S/E inheritance probes use test spawns.** The probes run through the test controller entry's own `spawn` calls, which mirror the `launch.ts` builders' options exactly. The native chain uses the production builders, but without fd probes.
6. **The blackhole seam never resolves.** Production E would instead refuse after 300 ms. The test validly covers C's handling of a hung E.

**Residual risks** (inherent, per the brief; not findings)
- Helper TOCTOU, so the full image is `UNVERIFIED` (RS-D).
- Socket swap between checks.
- Passwords resident in JS strings.
- A3: production RS-A refuses until RS-B registers.
- Docker timings are regression evidence only.
- `pg_stat_activity` visibility (VERIFIED on PG17 here).
- S logs dropped (RS-D).

**Status that must not change**
- `loadedBinding` stays `UNVERIFIED`.
- `verifiedPass` and `liveAcceptanceEligible` stay false.
- RS-B/C/D are not implemented.
- There is no activation, no data/budget admission, no provider, customer or deploy action.

---

## 6. Identity, effort and telemetry limits (honest)

- **Model:** this review was launched as native `claude-opus-5-5` / xhigh per the root's instructions. I cannot independently verify the effective backend model, effort or routing from inside the session, and self-identification is not evidence. Effective-model evidence must be collected externally by root from launch and response metadata.
- **Usage:** elapsed time, token and quota attribution are not available to me.
- **Paid product calls:** 0. **Activation:** none. No subagents or model launches.
- **Scope of this verdict:** applies only to packageHash `1f5cd250…a05c` with the CHECKS and evidence listed in §1. Any repair needs renewed review of the exact new identity, delta and checks.
