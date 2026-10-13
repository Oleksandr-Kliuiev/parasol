# Independent acceptance review — S5ASKREMOTE-REVAL-SERVER-RSB-rc1 (RS-B)

Reviewer: native Claude Opus 5.5 (`claude-opus-5-5`), a new clean Claude Code session with no implementer history and no
other reviewer's verdict. Launched by the owner as the single RS-B acceptance gate at effort `max`; the effective effort is
launch metadata and cannot be verified from inside the session. Date: 2026-10-11. No provider, account, network or paid
call; no repository file was changed apart from this report. Probes and mutation experiments ran only in a temporary copy
(`/private/tmp/rsb-review-opus/copy`, `node_modules` symlinked), which was deleted afterwards.

Normative basis: SERVER-DESIGN-rc4 `03_FIXTURES_AND_CLOCK.md` (primary), the FIXTURE_CHECK, registration and runtime-grant
rows of `01`, the RS-B checkpoint row and the "Fixtures" and "Clock isolation" rows of `05`, and `06`. The implementer's brief
(`rs-b/IMPLEMENTATION_BRIEF.md`) was judged against the architecture and was not treated as approved.

## Verdict

Verdict: CHANGES_REQUIRED

Most of the engineering is sound and was confirmed independently. The fence-first switch, row-identity inventory, seed
plan, FX08 sentinel, pg→`$queryRaw` adapter, verifier V, the exact 03 payload and the runtime column grants are correct on PG17.
Ten fixtures prove ×5 under the confined runtime role through the real switch, on both the Docker seam and the native
unix-socket chain.

Four required defects remain:

- FIXTURE_CHECK does not enforce the normative PAUSED precondition (F1, shown by probe).
- D3 accepts INACTIVE on a premise that is false (F2, shown by probe).
- Two of the six FIXTURE_CHECK booleans, and the post-verifier bracket, have no negative control. Mutations survive the whole RS-B PG suite (F3).
- The required PG suite is nondeterministic: an autovacuum worker trips the census, which I reproduced and diagnosed (F4).

Separately, the 05 RS-B exit criterion "All 11×5 PG17 equality" is **not met**, because the frozen FX04 cannot be represented.
That needs an owner or architecture decision (B1). It is not an implementation defect. Even after F1–F4 are repaired, RS-B can be
accepted as complete only after B1 is resolved, or after the owner explicitly narrows the exit criterion.

## 1. Artifact identity (recomputed)

- Manifest `verification/stage5/S5ASKREMOTE_REVAL_RSB_RC1_MANIFEST.json`: file sha256
  `3c587618219a5dec48bed4dfd821b723c29000600a12b47e4954f84e9ed3f60b` — **matches**.
- The packageHash was recomputed as the sha256 of the sorted `path\tsha256\n` lines over 17 changed and 26 added entries. It is the same
  whether the manifest hashes or the actual working-tree file hashes are used:
  `5e92775279dea3248f04d939f1062cd686e7d0739e6bcad79520d522421d99c2` — **matches**. Every one of the 43 per-file hashes equals the tree.
- Baseline `verification/stage5/S5ASKREMOTE_REVAL_RSB_BASELINE.sha256`: sha256 `e5227b4f…de4c` — matches the manifest. It has
  1852 entries, and every "changed" entry's baseline hash equals the baseline file.
- I compared the tree against the baseline using git ls-files (cached plus others, exclude-standard). Receipts
  `S5ASKREMOTE_REVAL_RSB_RC1_*` and the gitignored `dist/`, `node_modules/`, `.env` and `*.log` were excluded. Result: **no file outside the manifest was changed, added or removed**.
  `docs/AI_CONTEXT_MAP.md` has a newer mtime but is byte-identical to the baseline.
- `npm run test:pg` rebuilt `dist/`. A whole-tree fingerprint taken before and after shows the rebuild was byte-identical. I
  repeated the manifest/baseline check after all runs and it still matched.

## 2. Blocking open item (owner/architecture decision — not an implementer defect)

**B1 — FX04 is unrepresentable, so "All 11×5" (05 RS-B row) is unmet.** FX04 `readerExcludedLinks` declares a CANDIDATE
`PERSON ↔ huntress agent` link. The accepted `EntityLink_type_compat_check`
(`prisma/migrations/202610081000_stage2_m365_directory/migration.sql:56-58`) admits only agent↔DEVICE and contact↔PERSON, plus the
two m365 pairs. The implementation refuses correctly: `seed-plan.ts:172` throws `LINK_TYPE_INCOMPATIBLE`, `install` returns
`PLAN_INVALID` with state unchanged, and V answers `FIXTURE_MISMATCH`. It neither weakens SQL nor alters the declaration. FX04
is used by 21 of the 200 cases.

The options (not my decision):

- **(b)** Least invasive. Read.ts reads only `l.status = 'CONFIRMED'` links (`packages/ask/read.ts:96`), so the excluded link's
  resourceType never reaches any projection. The in-memory `contact` variant proves ALL_TRUE. However, it substitutes a frozen
  declared value, so it needs explicit architecture/dataset approval and must be pinned in the reviewed mapping (with a new mapping hash),
  never applied as a code default.
- **(a)** A dataset revision is semantically cleaner, but it re-freezes the dataset: new manifest hash, offline re-acceptance, and every pin changes.
- **(c)** Excluding the 21 cases breaks the frozen RC6 200-case matrix. It is the least preferable option.

## 3. Findings

### F1 — P2 — REQUIRED — FIXTURE_CHECK does not enforce the PAUSED precondition

- Where: `packages/reval/fixture-check.ts:44-48` and `:79-86` (no `policyState` check); brief B9 omits the requirement.
- Requirement: 03 says "It permits only the registered PAUSED synthetic binding and fixed requestedFocus". Step 4 says "Run the
  read-only fixture proof below, still paused". `s1.policyState` is available but never checked.
- Evidence: probe P-A, run on the temporary copy against PG17. The policy was revised to ACTIVE through the accepted owner routine. `snapshot` then
  reported `policyState=ACTIVE`, and `fixture-check` still answered `OK FIXTURE_CHECK {… all six booleans true …}`.
- Failure scenario: a fully positive DB=fixture receipt is produced while the policy is admitting work. The payload carries no
  policy state, so the receipt cannot show that the proof happened under the pause that gates the later manual resume.
- Fix: before spawning V, refuse unless `s1.policyState === 'PAUSED'`. Also require it for `s2`. Today a state change between
  s1 and s2 only turns `financeUnchanged` false. Use a fixed 06 code, for example `CONTAINMENT_UNCONFIRMED`, chosen and justified
  in the repair brief. Add PG tests for ACTIVE, and for INACTIVE according to how F2 is resolved.

### F2 — P2 — REQUIRED — D3 accepts INACTIVE, and the stated rationale is false

- Where: `packages/reval/inventory.ts:105`, used by `register` and `install`; `docs/RUNBOOK.md:639` ("INACTIVE или PAUSED").
- Requirement: 03 line 19 says the tool "refuses … unpaused policy", and step 2 says "Verify PAUSED".
- The D3 premise is "INACTIVE never admitted anything". But `atlas_ask_remote_policy_revise` accepts `p_state` INACTIVE from any non-TOMBSTONE
  state (`202610111020_stage5_ask_remote_routines/migration.sql:307`).
- Evidence: probe P-B. The policy went ACTIVE, then was revised to INACTIVE, and `install FX03` succeeded (generation 2).
- Practical risk is low: reserve requires ACTIVE, and the census plus the EGRESS_COMMITTED check still apply. It is nevertheless a silent normative
  relaxation, and its justification is incorrect. It is also not needed for bootstrap: before the first install the owner can revise
  INACTIVE→PAUSED with the existing owner routine.
- Fix: require PAUSED. Alternatively, restrict INACTIVE to the provable creation state (`policyVersion = 1`) and obtain explicit
  owner/architecture approval for that bootstrap exception. Update the RUNBOOK, and add tests for REVOKED, TOMBSTONE and ACTIVE→INACTIVE.

### F3 — P2 — REQUIRED — Missing negative controls: two FIXTURE_CHECK booleans and the post-V bracket can pass vacuously

- Where: `packages/reval/fixture-verify.ts:62-70` (`allIntentsPass`), `packages/reval/fixture-check.ts:82,86`; tests
  `tests/pg/reval-materialize.pg.test.ts:121-129` and `tests/pg/reval-fixture-check.pg.test.ts:78-98`.
- No test ever expects `allFiveIntents:false` or `financeUnchanged:false`. The generation-bump test bumps while V sleeps *before*
  its transaction, so V itself refuses and the `s2` bracket at `:82` is never exercised.
- Evidence: mutation runs on the temporary copy, all against PG17. Every mutation survived.
  - M1: `allIntentsPass` was changed to return `true`. `reval-fixtures`, `reval-materialize` and `reval-fixture-check` still passed 12/12.
  - M2 + M11: `financeUnchanged: true` was hard-coded and the `s2` fixture/generation check was deleted. `reval-fixture-check` passed 3/3, and native `reval-native-rsb` passed 1/1.
- Fix:
  1. Assert `allFiveIntents:false` in the forged-row test. `checkAnswer` fails OBSERVATION_DATA there.
  2. Add a unit test of `allIntentsPass` and `bankMatches` with a perturbed expectation.
  3. Add a FIXTURE_CHECK test where finance changes between s1 and s2.
  4. Add a test that bumps the generation *after* V commits, using a test-only hook in the test verifier entry, and expects `FIXTURE_MISMATCH`.

  Every boolean of the exact payload must have at least one test where it turns false.

### F4 — P2 — REQUIRED — The required PG suite is nondeterministic (census false positive from autovacuum)

- Where: `packages/reval/inventory.ts:71-76`; `tests/pg/reval-fixtures.pg.test.ts:29-83`.
- A role without `pg_read_all_stats` sees every backend it lacks stats permission for with `backend_type` NULL. That
  includes autovacuum workers, which run with no user; in the superuser view `usename` is NULL. The census counts these as writers, which is fail-closed by design (D4). Fresh test databases are
  autovacuumed soon after migration.
- Evidence:
  - My full `npm run test:pg` with the native descriptor gave **739/741**. Both `reval-fixtures` tests failed with `ANOTHER_WRITER`; the second failure cascades from the first.
  - A diagnostic run of 18 parallel `reval-fixtures` runs, on a copy whose census logs offenders via a superuser view, failed 2 of 18. One capture shows `{"backend_type":"autovacuum worker","q":"autovacuum: VACUUM ANALYZE pg_catalog.pg_depend"}` on the sandbox database.
  - A second full run on the copy passed 743/743.
  - The RC1 claim "741/741" is therefore not reliably reproducible.
- Fix: make the test deterministic without weakening the census for real writers. For example:
  - Provision the test owner with `pg_read_all_stats`, and have the census exclude only visible `autovacuum worker` and `autovacuum launcher`, while still treating NULL as a writer.
  - Or use a bounded test-only retry that, through the superuser harness, asserts that the transient backend is an autovacuum worker.

  Document the occasional autovacuum `ANOTHER_WRITER` retry in the RUNBOOK RS-B section.

### F5 — P2 — OPTIONAL (carry into RS-C/RS-D) — V's executed proof code is outside every declared digest

- Where: `packages/reval/launch.ts:47,50`; `packages/reval/fixture-verify.ts:2-12`.
- `launcherManifestSha256` covers `packages/reval/**` and `scripts/reval-server/**`. `buildManifestSha256` covers `dist/**`,
  migrations and roles. V executes the TypeScript sources `packages/ask/{read,phase,projection,source,…}.ts`,
  `packages/ask/remote/answer.ts`, `packages/graph/context-mapper.ts` and `scripts/ask-remote-eval/{fixtures,expected-facts,predicates,dataset}.ts`.
  None of these is measured or reported. RS-C's phase1 will run the compiled `dist/` code instead.
- Consequence: 03's "the same source SQL/validators/projection as phase1" is assumed, not bound. The baseline-hash static test
  protects only the checkout under test. IDENTITY does not even report the code that produces the FIXTURE_CHECK booleans.
- Suggestion: extend the declared launcher set, or add a verifier-closure digest, or run V against the measured build. At minimum, record this as an
  explicit residual for RS-C/RS-D. `loadedBinding` stays UNVERIFIED regardless.

### F6 — P3 — OPTIONAL — Source-read failures are reported as proof mismatches

- Where: `packages/reval/fixture-verify.ts:109-115`.
- Any exception from `readDbSource` returns `CHECKED` with all four booleans false. That includes a statement timeout, `ASK_DEADLINE`, a lost connection, or the subsequent `COMMIT` of an aborted
  transaction, which silently rolls back.
- The behaviour is fail-closed but misattributed: an infrastructure or deadline failure looks like a DB≠fixture finding.
- Suggestion: map SQLSTATE and timeout failures to `REFUSED DEADLINE` or `INTERNAL_FAILURE`, and reserve false booleans for genuine
  source-validation outcomes.

### F7 — P3 — OPTIONAL — `seedMappingSha256` does not pin every unprojected literal

- Requirement: 03 says the reviewed mapping "pins all unprojected schema-required literals and deterministic row IDs".
- Several literals and derivation rules live in `packages/reval/seed-plan.ts` rather than in `seed-mapping.json`:
  - `payloadHash` rule, and `receivedAt`/`nextAttemptAt` equal to `occurredAt` (`:151-152`);
  - `lastSyncAt` equal to `lastSuccessAt` for OK (`:106`);
  - `decisionApplied: true` and `legacyClosure: false` (`:156-161`);
  - ExternalEntity and link ID allocation (`:175,180`).
- A change in `seed-plan.ts` would therefore leave the receipt's `seedMappingSha256` unchanged.
- Suggestion: move these rules into the JSON, or define the reviewed "seed mapping" identity as the JSON plus the `seed-plan.ts` hash in the manifest and RUNBOOK.

### F8 — P3 — OPTIONAL — The census misses visible background workers

- Where: `packages/reval/inventory.ts:72-74`.
- Only `client backend` and NULL backend types are counted. A visible same-role background worker attached to the
  sandbox database (for example, an extension bgworker running jobs as the owner) is not counted. This is the opposite of F4: a false negative.
- Suggestion: count every non-own backend on the database except an explicit allowlist of benign internal types.

### F9 — P3 — OPTIONAL — V does not verify that it runs as the confined runtime role

- Where: `packages/reval/verifier-exec.ts:30-33`, `fixture-verify.ts:91-94`.
- 03 requires "the ordinary confined runtime DB role". V checks only `session_user === roles.runtime` from the owner config.
- If the config names the table owner, V runs with owner privileges: RLS is bypassed on non-FORCE tables, and an owner credential is held outside the 01-permitted executors.
- Unlike S, V never runs the existing `assertRuntimeRole` readiness. Suggestion: run that readiness, or a minimal confinement check, inside V before the proof.

### F10 — P3 — OPTIONAL — Stale documentation

- `docs/RUNBOOK.md:616-617` (RS-A section) still says the runtime gets no privileges on Reval tables, which D5 changed.
- `:639` documents the INACTIVE relaxation (see F2).

### F11 — P3 — OPTIONAL — Evidence logs are gitignored

The `.gitignore` pattern `*.log` excludes `S5ASKREMOTE_REVAL_RSB_RC1_EVIDENCE/{test-pg,drift,pg17,schema,smoke,typecheck}.log`. These logs are referenced by
hash in `…_CHECKS.json` but will not be committed. RS-A has the same pattern. Preserve them explicitly if they are meant to be durable evidence.

## 4. Assessment of the declared deviations D1–D7

- **D1 (FX04 refused).** Correct reading of 03 lines 58-60, correctly implemented and tested; the variant test is clearly labelled as not frozen evidence.
  It still leaves the RS-B exit criterion unmet → B1.
- **D2 (`itemCount=1` for truncated empty snapshots).** Accepted. It is required by `ResourceSnapshot_items_check`
  (`truncated = itemCount > jsonb_array_length(items)`), and the source reader never reads `itemCount`; the reader-visible item count stays 0.
  Record the literal divergence from 03's "itemCount=0" text in the next architecture/plan revision.
- **D3 (INACTIVE like PAUSED).** **Not accepted** → F2.
- **D4 (no-other-backend census as drain substitute; NULL `backend_type` counted).** Accepted only as an interim, fail-closed
  substitute for this offline tool. The NULL handling is correct. However:
  - it causes false refusals (F4) and misses visible bgworkers (F8);
  - it forces S and C to stop for every switch, which conflicts with the architecture's intended run (S paused and drained while phase1 rechecks the binding generation).

  RS-D DRAIN, or a census that admits the registered S's idle connections after a QUIESCENT drain, must replace it before RS-C/RS-D integration.
- **D5 (runtime column SELECT).** Accepted. 01 explicitly permits it, and the columns are exactly the ones V reads. `roles/reval.sql` postconditions
  and `reval-role.ts` readiness both enforce per-column exactness (no table-level SELECT, no write), with the three new negatives
  in `reval-roles.pg.test.ts`. RS-A A4 is superseded explicitly, and the RS-A seal remains historical. Every runtime database must rerun `prisma/roles.sql`, otherwise readiness refuses startup, as designed. Fix the stale RUNBOOK text (F10).
- **D6 (phase1 wiring deferred to RS-C).** Accepted for RS-B, because S stays Ask OFF and `packages/ask/**` is unchanged (statically pinned).
  The 05 "Clock isolation" row is exercised only inside V, where the reference reaches only `read.ts:169` freshness. RS-C must carry the Ask-path
  tests: credential/policy/price expiry, budget day/month, monotonic deadlines, receipt freshness, and real-clock OFF/MOCK/remote regressions with the reference wired.
- **D7 (`docs/AI_CONTEXT_MAP.md` untouched).** Accepted given the execution-RC5 freeze. Routing exists in `packages/reval/AGENTS.md` and the RUNBOOK.
  Add it at the next RC5 integration/reseal.

## 5. Seed mapping (05: "accept exact seed mapping")

I reviewed `packages/reval/seed-mapping.json` (`00276e63…f47a`) together with `seed-plan.ts` (`62efdb4f…be2b`).

- Projected values come only from `originalRow` and the frozen declarations. All literals are schema-valid and the output is deterministic.
- MISSING is an absent SyncState. ERROR is SyncState ERROR with the literal `lastSuccessAt` and no snapshot. OK/STALE is SyncState OK plus a snapshot with the
  literal `asOf`/`lastSuccessAt`/`truncated`.
- Links get `syn-link-NNN` in declared order, so the first CONFIRMED link stays first.
- FX08 sentinel: INFO (rank 0) is below every declared row (rank ≥ 1). Under `severityRank DESC, createdAt DESC, id ASC` it is strictly the 101st row, independent of collation. It is selected by the LIMIT 101 read, so truncation is proven, and it is never a focus or a bank or expectation entry.

**Content accepted for the ten representable fixtures**, subject to F7 (identity completeness) and B1 (FX04).

## 6. Verified as correct (no change required)

- **Switch:**
  - lock order fence → policy → binding FOR UPDATE, then source rows FOR UPDATE in a fixed order;
  - DELETE children→parents and INSERT parents→children;
  - guarded binding UPDATE `generation = expected + 1`;
  - row identity and preserved fingerprint checked inside the transaction;
  - a separate post-check connection;
  - every refusal rolls back. This was tested, including injected failure after INSERT.
  - There is no TRUNCATE, DDL, trigger, RLS or role statement (static test plus my reading), and finance and audit are never touched.
- **Inventory exactness:**
  - FORCE RLS applies only to RemoteAsk* (4), Reval* (2), ActionAuthorityFence, Action* (5) and PowerOffice* (3). The ten source tables and
    Workspace, Client, Actor, ClientMembership, ApiToken, AuditEvent, SecurityAuditEvent and ToolExecution are not FORCE, so the owner sees every row.
  - FORCE tables are read with the registered scope set.
  - The RI RESTRICT check, which bypasses RLS, backs up FK detection.
  - Every FK into the allowlist is RESTRICT or NO ACTION. Each Ask attempt, audit or tool row would not block later switches.
- **pg-tx adapter** is faithful for every column read.ts reads: `timestamp(3)` with OID 1114 is decoded as UTC (the remaining types keep driver decoding), `jsonb` is parsed, `float8` becomes a number, `text[]` an array, and `int4` and `bool` match. No `int8`, `numeric` or `date` column is read.
- **V:**
  - runs a READ ONLY REPEATABLE READ transaction with no bearer;
  - reads registration, binding and actor/membership (ACTIVE, all-of context:read and ask:remote) in the same snapshot;
  - compares independently against `buildSource`, `expectedFactData`, `checkAnswer` and the hand-declared expectations;
  - lets only booleans or a code leave;
  - follows HELLO-first, peer proof, request, then secret read, mirroring E; uses an empty environment and ignored stdio;
  - exits on parent EOF or its deadline, and leaves no backend afterwards.
- **FIXTURE_CHECK:** O→C only; the exact 12-key 03 payload in order; a 1800 ms budget with ordered sub-deadlines; the guard kills and reaps V.
  Measured latency: 214–224 ms on the Docker seam and 195 ms on native.
- **Modified RS-A tests:** the changed expectations are legitimate (FIXTURE_CHECK is no longer fail-closed, and the runtime column allowlist changed).
  HELLO receivers still require their exact kind.
- **Unit suite:** the only failures are exactly the eight RC5 identity failures (`CORPUS_IDENTITY_MISMATCH`: seven `ask-remote-eval-execution-*`
  wrappers plus the RC5 PTY test), the same set as RS-A. `reval-rc5-guard` passes. The one skip is the RC5 historical-view test, which needs an environment variable that was not set.

## 7. Commands run and results

| Command | Result |
|---|---|
| Manifest/package/baseline recomputation (`python3 -I` script; git ls-files) | All match; no out-of-manifest drift |
| `npm test` | 519 tests: 510 pass, 8 fail (the RC5 identity set above), 1 skipped; exit 1 (qualified) |
| `npm run typecheck`, `schema:validate`, `db:check:pg17`, `db:check:drift`, `api:smoke` | all pass |
| Focused Docker PG17: `reval-{fixtures,materialize,maintain-cli,fixture-check}.pg.test.ts` | 15/15 pass; evidence line 10 × `ALL_TRUE`, FX04 `PLAN_INVALID`; real-clock mismatch for 9 fixtures, FX06 equal |
| `ATLAS_REVAL_NATIVE_PG_FIXTURE=… reval-native-rsb.pg.test.ts` | 1/1 pass (production maintain + O→C→V over the unix socket) |
| Full `npm run test:pg` with the native descriptor | **741 tests: 739 pass, 2 fail** (`reval-fixtures` `ANOTHER_WRITER`) → F4; both native tests ran and passed; `dist/` rebuilt byte-identical |
| Full suite on the copy with census diagnostics | 743/743 pass (741 plus 2 probes) |
| 18 parallel `reval-fixtures` runs on the copy (diagnostic) | 2 fail `ANOTHER_WRITER`; captured `autovacuum worker` on the sandbox database |
| Probe P-A / P-B on the copy | ACTIVE policy → `OK FIXTURE_CHECK` all true (F1); ACTIVE→INACTIVE → `install` OK, generation 2 (F2) |
| Mutations M1, M2+M11 on the copy | all survive (F3) |

Leftover check: the native cluster has no databases or roles beyond its admin. The four `atlas_it_*` databases on Docker PG17 predate
this session (2026-10-09/10) and were left untouched. The temporary copy and probe files were removed.

## 8. Residual risks (beyond the findings)

- Pre-existing, from RS-A:
  - `loadedBinding` is UNVERIFIED; image, egress and privacy proofs belong to RS-D.
  - Docker results are regression evidence and native results are test-fixture evidence, never MEASURED.
  - There are physical-binding TOCTOU windows between checks.
  - Password strings stay resident until GC.
  - The table owner remains a trust boundary: direct owner DML outside the tool is detected only by census, inventory, row identity and projection.
- FIXTURE_CHECK depends on target-platform latency. V's module load must finish within about 150 ms of the first snapshot to meet the
  `D−1200` request deadline. Measured locally only.
- `financeUnchanged` covers only the s1→s2 window around V. The switch's own finance/audit fingerprint is not surfaced in any receipt.
  FIXTURE_CHECK also does not re-run the SNAPSHOT pricing or relationship validation, as the report itself acknowledges.
- The FX08 07:20-versus-07:58 freshness limitation is inherent to the frozen corpus. It is reported correctly and must stay disclosed.
- Code-semantics notes, no change required: a runtime-authentication failure in V maps to `OWNER_REQUIRED`, and a V crash or malformed result maps to `FIXTURE_MISMATCH`. Both are closed codes but semantically loose.
  This should be revisited when RS-C defines receipt semantics.
