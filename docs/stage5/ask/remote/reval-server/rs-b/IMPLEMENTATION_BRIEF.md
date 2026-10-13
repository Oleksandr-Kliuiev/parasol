# RS-B implementation brief — rc1, amended for rc2 repairs (S5ASKREMOTE-REVAL-SERVER-RSB)

Status: implementation brief written by the implementer (native `claude-opus-5-5`, Claude Code session) on 2026-10-11 at
the owner's direct request ("приступай к RS-B → RS-C → RS-D"). Not an approval. Gate set by the owner for this work,
superseding the role table for RS-B only: ONE independent acceptance reviewer, native Claude Opus 5.5 at effort `max`, in
a NEW CLEAN session after implementation (no implementer history, no other verdict). No Sol/Astra/Fable gate is claimed.
No paid calls, provider/account access, activation, customer data or deployment.

## 0. Identity and dependencies

- Architecture: SERVER-DESIGN-rc4, package `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163` (normative
  `03_FIXTURES_AND_CLOCK.md`, plus 01/05/06 rows that name FIXTURE_CHECK). Its files stay byte-unchanged.
- Parent code: RS-A rc3 ACCEPTED, package `ae4fb782f4c4ab47fa172ba75f984b5165d54427dbee6e93bd822db37c926216`
  (seal `verification/stage5/S5ASKREMOTE_REVAL_RSA_APPROVED.json`). RS-B changes some RS-A files (§7); the RS-A seal stays
  historical and the RS-B manifest lists the baseline → new hashes.
- Baseline: the working tree at 2026-10-11 20:40 CEST, HEAD `916a4d6`, branch `codex/reval-server-contracts-20261011`,
  1852 files; `verification/stage5/S5ASKREMOTE_REVAL_RSB_BASELINE.sha256` (sha256 per path, dirty work included).
- Frozen dataset: offline RC3 `docs/stage5/ask/remote/eval/data/DATASET_MANIFEST.json`
  (`224b1b8dedc775565f0eb1b5c5527096db29d2fc558854c58045d3879f12989a`), its `fixtures.json`
  (`40f1744ae90b60e171b7897fce08bbe609ef5be6c908992586b470e08dcfaa8d`). `datasetManifestSha256` everywhere in RS-B is the
  sha256 of the manifest BYTES; the fixture file is accepted only when its sha256 equals the manifest's entry.
- Execution RC5 files (`scripts/ask-remote-eval*/**`, `packages/ask/**`) are imported read-only, never edited.

## 1. Scope

IN (03 "Materialization contract", "Transaction and switch procedure", "Explicit source-only freshness exception",
"DB equals fixture proof"; 05 RS-B row):
1. Reviewed seed mapping `packages/reval/seed-mapping.json` (closed JSON; its sha256 pinned in code and reported).
2. Pure deterministic seed plan: frozen manifest + fixtureId → exact rows of the ten allowlisted source tables.
3. Owner maintenance tool (offline, NOT the 06 IPC): `probe`, `register`, `install <FXnn> <expectedGeneration>`.
4. Source-only clock boundary: the pinned reference `2026-10-10T07:30:00.000Z`, released only through a matching
   registration/binding/manifest, used ONLY for resource freshness.
5. FIXTURE_CHECK: O→C only; C composes two reader snapshots around a short-lived verifier process V that runs the
   accepted `readDbSource` under the confined runtime role in a READ ONLY REPEATABLE READ transaction, no bearer.
6. Runtime gains the column SELECTs on the two Reval tables that 01 allows (needed by V now, phase1 in RS-C).

OUT: RS-C (browser pane, PAIR/arm/handoff, ingress gate, phase1 use of the reference/generation — S keeps Ask OFF in bridge
mode), RS-D (DRAIN, process/egress/privacy proof, loaded-image immutability), provisioning of Workspace/Client/Actor/
membership/token/policy (existing owner mechanisms; RS-B only requires and checks them), any change to packages/ask.

## 2. Decisions

- B1 Seed mapping pins every unprojected schema-required literal and deterministic ID template (Connection tenant/secretRef/
  status FIXTURE, RawEvent id/payloadHash/received/next-attempt times/status PROCESSED, Observation promptVersion/
  ackBy/resolvedBy, ExternalEntity id/attributes/observedAt, EntityLink id/method/confirmedBy/confirmedAt/createdAt,
  SyncState error code/sync times, ResourceSnapshot contractVersion/items `[]`, FX08 overflow sentinel). Projected fields
  come only from `originalRow` and the fixture declaration. The plan refuses an unrepresentable fixture (throws).
- B2 FX08 sentinel: one INFO atera observation `syn-obs-t101-overflow`, createdAt `2026-10-10T06:00:00.000Z`, on
  `syn-atera-1`; it sorts after every declared row (rank 0 < LOW), is never a focus and never enters an expectation.
- B3 MISSING = no SyncState row (no invented empty read). OK/STALE = SyncState `OK` + snapshot with literal asOf/
  lastSuccessAt/truncated; ERROR = SyncState `ERROR` with literal lastSuccessAt and no snapshot.
- B4 Links: declared `links` then `readerExcludedLinks`, IDs `syn-link-NNN` in that order (first CONFIRMED stays first).
- B5 Inventory is exact because the ten source tables, Workspace, Client, Actor and ClientMembership have RLS without FORCE
  (the table owner sees every row). Refusals (fixed codes): unregistered/foreign DB (physical tuple or registration row
  mismatch on TWO independent owner connections), extra workspace/client/actor, any source row outside the registered
  scope or not in the current plan, a Connection that is not `FIXTURE` atera/huntress without binding provenance
  (`LIVE_EGRESS`), an FK from a non-allowlisted table referencing a scoped source row or any non-RESTRICT FK into the
  allowlist (`FK_DEPENDENCY`), policy not PAUSED, an `EGRESS_COMMITTED` attempt of the project (`DRAIN_INCOMPLETE`),
  another client backend on the database (`ANOTHER_WRITER`; RS-B's drain substitute: the API server must be stopped),
  generation mismatch. RS-D's DRAIN composition stays pending.
- B6 Switch transaction (READ COMMITTED, one owner connection): fence FOR UPDATE → policy FOR UPDATE → binding FOR UPDATE;
  checks; source rows FOR UPDATE in fixed table/key order; DELETE children → parents; INSERT parents → children; binding
  INSERT (generation 1) or UPDATE generation+1 with the pinned reference and dataset; COMMIT. Connection fence triggers keep
  their increments. No TRUNCATE/DDL/trigger/RLS/role change; finance, audit and history rows are never touched. After
  COMMIT a separate read-only owner pass re-checks rows = plan.
- B7 `register` inserts ONLY `RevalSandboxRegistration` (no binding) from a complete RevalOwnerConfigV1 after the same
  physical/inventory checks; the reader role OID comes from `roles.reader`; `buildManifestSha256` is computed exactly as C
  computes it; `datasetManifestSha256` is the pinned constant. `probe` prints only the observed physical tuple JSON.
- B8 Verifier V (`scripts/reval-server/fixture-verifier.ts`): spawned by C exactly like E (env empty, fd 3, HELLO first,
  peer proof, then a closed request frame with paths/expectations, never a credential). V reads the runtime secret file,
  verifies the physical endpoint as the runtime role (application `atlas-reval-v-verifier`), then in one transaction:
  registration + binding equality (fixture, generation, dataset, reference), actor ACTIVE + one membership of the client
  with context:read AND ask:remote, row identity (PK sets of the ten tables = plan), `readDbSource` through the accepted
  `phaseSql` with the reference as `now`, `project`, then for each of the five intents `remoteAnswer` judged by the
  independent offline `checkAnswer` against the frozen expectation and `expectedFactData`. Only booleans/a fixed code leave V.
- B9 C composes FIXTURE_CHECK in its 1800 ms budget: snapshot #1 → V → snapshot #2. Generation/fixture must be equal in
  #1, V and #2 (else `FIXTURE_MISMATCH`); `financeUnchanged` = #1 and #2 equal in policy/fence/periods/attempts/counts.
  Payload exactly per 03 with `sourceMode:'db'`, `realTimeFreshnessClaim:false`. A V failure is a FAILURE response
  (`REGISTRATION_MISMATCH`, `FIXTURE_MISMATCH`, `OWNER_REQUIRED` for runtime auth, `IDENTITY_UNVERIFIED`, `DEADLINE`).
- B10 Runtime column SELECT (roles/reval.sql + readiness): registration (registrationId, databaseInstanceId, workspaceId,
  clientId, actorId, admissionId, datasetManifestSha256, syntheticOnly); binding (registrationId, workspaceId, clientId,
  fixtureId, generation, syntheticFreshnessAt, datasetManifestSha256). Nothing else (no table-level, write, other column,
  snapshot/guard EXECUTE); evidence-reader/definer rules unchanged.

## 3. Clock isolation

The reference enters only `readDbSource(..., now)` inside V. Credential/actor validity, policy/price/admission expiry,
finance day/month, reserve/settle times, audit/publication time, deadlines, latency, owner evidence freshness and
`installedAt` keep real clocks; RS-B adds no other use. Tests show: the same DB rows verified with the reference pass on
every fixture, and the ordinary real-clock read of the same rows differs for fixtures with OK snapshots (negative probe,
not concealed); ordinary Ask paths are byte-unchanged (no packages/ask edit). FX08 limitation (07:20 alert vs 07:58
snapshots) is reported, not repaired.

## 4. Allowed paths (final, as implemented)

New: `packages/reval/{dataset,seed-plan,inventory,materialize,register,maintain-cli,maintain-deps,source-clock,pg-tx,fixture-verify,
verifier-exec,fixture-check}.ts`, `packages/reval/seed-mapping.json`; `scripts/reval-server/{maintain,fixture-verifier}.ts`;
tests `tests/reval-seed.test.ts`, `tests/pg/reval-{fixtures,materialize,maintain-cli,fixture-check,native-rsb}.pg.test.ts`,
support `tests/support/reval-fixture-pg.ts`, `tests/support/reval-test-verifier-entry.ts`; this directory; verification receipts.
Bounded modifications: `packages/reval/{codes,private-frames,payloads,controller,deps,launch,owner-cli}.ts`, `packages/reval/AGENTS.md`,
`prisma/roles/reval.sql`, `packages/graph/reval-role.ts`, `scripts/reval-server/AGENTS.md`, `docs/RUNBOOK.md` (RS-B section);
RS-A tests whose expectation legitimately changes (`tests/reval-protocol.test.ts` FIXTURE_CHECK no longer fail-closed,
`tests/pg/reval-launch.pg.test.ts` FIXTURE_CHECK answer, `tests/pg/reval-roles.pg.test.ts` runtime column allowlist) and the
test seams `tests/support/reval-test-{deps,controller-entry}.ts` (optional pg type parsers, verifier spawn, sleep hook).
NOT modified: `docs/AI_CONTEXT_MAP.md` is one of the 120 execution-RC5 files (RS-A kept it unchanged); its RS-B routing row is
left to the owner/orchestrator together with the pending RC5 integration. Forbidden: accepted migrations, financial routines,
`packages/ask/**`, `apps/operator/**`, connectors, offline/execution packages, architecture docs, historical verification,
new dependencies (a static test pins `packages/ask/**`, `scripts/ask-remote-eval*/**`, frozen data and 01–06 to the baseline).

## 5. Required checks

`npm test`, `npm run typecheck`, `npm run schema:validate`, `npm run api:build`, `npm run api:smoke`,
`ATLAS_PG_ADMIN_URL=… npm run test:pg` (full), `db:check:pg17`, `db:check:drift`, `git diff --check` on touched files,
context budget (≤700 lines/file). Focused PG17: all 11 fixtures installed by the real switch path and proven ×5 intents;
atomic switch rollback; every §B5 refusal; finance/audit/history unchanged across switches; fence increments only through
the existing triggers; FIXTURE_CHECK end to end through C with the test TCP DI (regression evidence, never MEASURED); with a
disposable native unix-socket PG17 descriptor (`ATLAS_REVAL_NATIVE_PG_FIXTURE`) the unmodified production `maintain.ts` and
O → C → V chain (test-fixture evidence, never MEASURED).

## 6. rc2 repair amendment (after `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSB_RC1.md`, CHANGES_REQUIRED)

Same implementer session; bounded repairs only, no new scope:
- F1: FIXTURE_CHECK refuses `POLICY_CHANGED` unless BOTH bracketing snapshots show the policy PAUSED (03 "permits only the
  registered PAUSED synthetic binding").
- F2: D3 withdrawn. register/install require exactly PAUSED (INACTIVE refused: ACTIVE→INACTIVE is a legal owner revision).
- F3: negative controls for every FIXTURE_CHECK boolean and for a generation change after V (tests listed in the report).
- F4/F8: the other-writer census counts every backend of the sandbox database of any type except autovacuum (visible type,
  or NULL type with NULL user as seen without pg_read_all_stats); a predicate test covers the classification.
- F6: a source-read deadline/connection failure is a fixed refusal (`DEADLINE`/`INTERNAL_FAILURE`), never all-false booleans.
- F9: V runs the accepted runtime confinement check (`RUNTIME_ROLE_CHECK_SQL`) before its transaction (`UNAUTHORIZED` otherwise).
- F10/F11: RUNBOOK corrected; rc2 evidence logs use `.txt` (the repo ignores `*.log`).
- B1 (owner decision 2026-10-11; the reviewer listed this option as the least invasive and left the decision to the owner): `seed-mapping.json` gains `schemaExceptions` with ONE exact
  entry — FX04 `readerExcludedLinks[0]` (CANDIDATE PERSON↔huntress agent `syn-h-agent-0009`) is STORED as `contact`↔PERSON.
  It applies only to an exact match of the whole declared link, only to non-CONFIRMED excluded links (which the accepted
  reader never selects), only into the one compatible type, with an `OWNER_APPROVED_*` marker; an unused exception refuses.
  Frozen dataset bytes and every expectation are unchanged; the mapping digest changes (`SEED_MAPPING_SHA256`).

