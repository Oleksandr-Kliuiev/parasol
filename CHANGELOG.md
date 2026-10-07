# Changelog

## Unreleased — Stage 1 implementation, Checkpoint A (branch `stage1/foundation`)

Tasks 1.1–1.3 on top of the 1.1.3 pack. Status, verification and open gates: `CHECKPOINT_REPORT.md`.

### Added
- Migration `202610071600_stage1_actor_membership`: `Actor`, `ClientMembership`, `ApiToken` (SHA-256 digest only) with CHECK vocabularies, workspace-carrying composite FKs and lookup-only RLS policies (`app.token_hash`, `app.actor_id`); no runtime write path. `prisma/roles.sql` revokes identity writes from the runtime role.
- DB-backed API (`ATLAS_MODE=db`, `apps/api/src/db/`): bearer token → `Actor` from the database; `GET /clients`, `/clients/:id/overview|observations|audit`, `GET /audit/security`, `GET /tools`, `POST /tools/execute` over PostgreSQL through the runtime role; every denial is written to `SecurityAuditEvent` before the 403.
- PostgreSQL audit sinks and bounded scoped reads (`packages/audit/prisma.ts`); `withWorkspaceScope`; synthetic seed adds the demo actor, its membership and the digest of `ATLAS_DEMO_TOKEN`.
- `npm run test:pg` (throwaway databases through `prisma migrate deploy` + `prisma/roles.sql`), `npm run db:check:drift`, context-budget test, `docs/AI_CONTEXT_MAP.md`.

### Fixed — independent review of Checkpoint A (`REVIEW_REPORT.md`, R1)
- A NUL byte or a lone UTF-16 surrogate in a requested client ID (URL or body) or a tool name made PostgreSQL reject the audit row: HTTP 500 and no record of the denial. Audit strings are now stored as escaped bounded text (`packages/audit/sanitize.ts: auditText`, both sinks); a malformed client ID is denied at the HTTP boundary with the same 403 and `INVALID_SCOPE_ID` in the security audit; a malformed tool name is a recorded `tool.denied` (`INVALID_TOOL_NAME`) after the scope check. Regression tests at unit, repository and HTTP level (`tests/audit-sanitize.test.ts`, `tests/pg/api-input.pg.test.ts`).

### Changed
- `schema.prisma` pins the two FK names and the `reasonCodes` default that the frozen migrations create (empty drift); migrations unchanged.
- The gateway awaits its sinks (synchronous memory or asynchronous PostgreSQL); `assertRuntimeRole` also covers the identity tables; PGlite tests and `pg17-check` apply every migration in order; `npm run typecheck` covers `apps/`.

## 1.1.3 — 2026-10-07

Acceptance release. The independent review of 1.1.2 confirmed S1–S3 closed and accepted the pack as the development baseline after one line in `schema.prisma`: Prisma's auto-generated names for the two `RawEvent` `@@unique` blocks collided (P1012), so the FK-target unique now carries `map: "RawEvent_identity_eventKey_key"` — the name the SQL migration already uses. The seven-field self relation is kept; Prisma 6.19 supports it. The reviewer's chain `schema:validate` → `db:generate` → `typecheck` → `api:build` → `api:smoke` passes with this fix. No code or SQL changed. Documentation now says three migrations everywhere, names the archive folder correctly, and `verification/RESULTS.md` records the reviewer's Prisma results instead of the stale "unverified" line.

## 1.1.2 — 2026-10-07

Corrective release after the independent review of 1.1.1 (`REVIEW_REPORT_v1.1.1.md`, findings S1–S3; R1–R7 confirmed closed, Prisma `schema:validate`/`db:generate`/full `typecheck` passed on the 1.1.1 schema in the reviewer's environment). Schema changes arrive as a **new** migration `202610071500_v1_1_2_conflict_scope_and_legacy_guard`; `202610071200_v1_1_contracts` stays frozen as `AGENTS.md` requires.

| # | Finding (reviewer's severity) | 1.1.2 change | Regression |
|---|---|---|---|
| S1 (P1) | `conflictOfEventKey` was a self FK on the global `eventKey` alone; a c1 row could link to c2's canonical event although RLS hid it | FK is now `(workspaceId, clientId, connectionId, resourceType, externalEventId, revision, conflictOfEventKey)` → the same seven columns of the parent (new full unique index as target), `ON UPDATE RESTRICT`; trigger `RawEvent_canonical_conflict_parent` requires the parent to be canonical; preflight stops if existing rows violate it. Prisma relation updated to the seven fields | SQL: cross-client, cross-identity, cross-resource-type and conflict→conflict links rejected; valid same-scope link accepted; the cross-client case also under the confined role inside `checkRlsInvariants` |
| S2 (P2) | `applied = true` was set after the commit hook but before `audit.append`; a failing audit left an applied run without an observation | Final phase publishes nothing until both the durable write and the audit append succeed; the applied flag is the last step; retry reuses the stored decision | `a failing audit append publishes nothing…` (RETRY with applied 0 / observation 0, then PROCESSED with applied 1, provider called once); reproduced on 1.1.1 before the change (applied 1, observation 0) |
| S3 (P2) | `legacyClosure` could be set by the runtime role to close an observation without author/time | Trigger `Observation_protect_legacy_closure` rejects INSERTs with the flag and false → true UPDATEs for every role; clearing on reopen allowed; the v1.1 backfill ran before the trigger existed | SQL: UPDATE with/without `RESOLVED`, INSERT with the flag — all rejected; legacy row reopened and cannot be re-flagged; normal closure passes |

Also: `schemaShape` in the upgrade-path test now includes triggers; `scripts/pg17-check.ts` applies all three migrations; docs/02, 03, 06 and AGENTS.md updated. (The 1.1.2 Prisma schema failed `validate` on an index-name collision; fixed in 1.1.3.)

## 1.1.1 — 2026-10-07

Corrective release after the independent review of 1.1.0 (GPT-6 Astra, `REVIEW_REPORT_v1.1.md`). All seven findings were reproduced before the change and are covered by regression tests. Migration `202610071200_v1_1_contracts` is revised in place: it had not been deployed to any persisted database (the reviewer ran it only in throwaway PGlite instances); databases that applied the 1.1.0 text use `prisma/upgrades/v1_1_0_to_v1_1_1.sql`, and a test proves both paths produce an identical schema shape.

| # | Finding (reviewer's severity) | 1.1.1 change | Regression |
|---|---|---|---|
| R1 (P1) | A RETRY of the final commit called the provider again and left two `applied` DecisionRuns for one event; the DB FK accepted a reference to an `applied = false` run | Two phases: resolve + decide once, runs persisted as `applied = false`; the applied flag, observation, audit and inbox completion change together in the final commit; retry reuses the stored decision. DB: `Observation.decisionApplied` (constant true) joins the FK → `DecisionRun(…, eventId, applied)` with `ON UPDATE RESTRICT`, so only the applied run of the same event can be referenced and cannot be un-applied | `retry of the final commit reuses the stored decision…`; SQL: `o-shadow-ref` rejected, `UPDATE … applied=false` on a referenced run rejected |
| R2 (P1) | Redelivery with the same ID/revision but different content (e.g. CRITICAL after MEDIUM) returned the old MEDIUM observation; under concurrency even the conflict audit was lost | Content is compared before joining the in-flight canonical event; the variant is stored as its own evidence (`conflictEventKey`, `conflictOfEventKey`), routed to `HUMAN_REVIEW` with its own `priority`, canonical evidence untouched, exactly one conflict audit. DB: `RawEvent.conflictOfEventKey` (self FK), one canonical row per identity (partial unique), identical content deduplicated (unique incl. `payloadHash`) | `same ID and revision with different content…`, `concurrent delivery of conflicting content…`; SQL conflict rows |
| R3 (P2) | Runtime-role guard checked ownership of `Observation` only; a role owning `RawEvent` passed and read all clients | `RUNTIME_ROLE_CHECK_SQL` checks ownership (incl. via `pg_has_role … MEMBER`) of every table in `PROTECTED_TABLES` and reports protected tables with RLS disabled (`RLS_NOT_ENABLED`) | `runtime-role guard rejects ownership of any protected table…` (PGlite) and the same check in `scripts/pg17-check.ts` |
| R4 (P2) | Advisory refusal/failure routed on the rules baseline (MONITOR for MEDIUM) while docs/04 required HUMAN_REVIEW; the test asserted the wrong behaviour | Advisory/fixture provider failure → `HUMAN_REVIEW` with `PROVIDER_UNAVAILABLE_OR_INVALID` + code; `rules` mode is the explicit way to route without a provider; shadow unaffected. docs/03–04/06 aligned | `advisory provider refusal or failure becomes visible human review…`, `explicit rules mode…` |
| R5 (P2) | `MODEL_MISMATCH` lost `requestedModel`/`responseModel` | `AtlasError.details` (safe, bounded); the provider attaches the requested model to every failure and the returned model to `MODEL_MISMATCH`; FAILED DecisionRuns carry both | `model mismatch is a distinct FAILED DecisionRun code…` asserts both fields and the timeout case |
| R6 (P2, upgrade blocker) | A populated v1.0 database with `RESOLVED` observations failed the new resolution CHECK | `legacyClosure` column set only by the migration for pre-existing closures (author/time not invented); relaxed CHECK; preflight `DO` blocks stop the migration on unknown `Observation.status`/`RawEvent.status` with an explicit message | `upgrade of a populated v1.0 database…` (success path and preflight stop) |
| R7 (architecture, 1.7) | Shadow awaited the AI call before creating the rules observation; urgent baseline depended on the experiment | Shadow commits the rules baseline immediately; the AI call runs as a tracked background task (`drainShadow()`), its result is a non-applied run and never changes the observation | `shadow mode commits the rules baseline without waiting…`, `shadow provider failure is recorded…` |

Also: `tests/sql-invariants.ts` gained the upgrade and guard checks; `tests/database.test.ts` compares the schema shape (columns, constraints, indexes, policies) of the upgrade path against a fresh install; `docs/06` has an "Upgrade from a populated v1.0 database" section; `AGENTS.md` records the two-phase rule and the migration freeze.

Not changed: the reviewer's positive Prisma results (`schema:validate`, `db:generate`, full `typecheck` on Node 24) were obtained in their environment; this build environment still cannot download Prisma engines, so the Prisma Client path remains unverified by the author (see verification/RESULTS.md).

## 1.1.0 — 2026-10-07

Coordinated correction of the v1.0 development pack after two independent architecture reviews (Claude Fable 5.1 and GPT-6 Astra) converged on the same defects. Code, schema, migrations, tests and task texts changed together so the next implementing agent does not inherit reference code that contradicts the review.

### Fixed — reproducible defects in v1.0

| # | Defect | v1.1 change | Regression test |
|---|---|---|---|
| 1 | Client audit record spread the whole event (`summary`, `facts`, external IDs) into the log | `MemoryAudit` builds records from an explicit field list; metadata filtered by `auditMetadataAllowlist` | `client audit records are built from an allowlist…`; API smoke asserts no payload fields |
| 2 | Ambiguous confirmed device links threw `AMBIGUOUS_DEVICE_LINK` and the event (even CRITICAL) left no observation and no audit; the old test enshrined this | `AtlasError{code, kind}`; CONFLICT → observation `HUMAN_REVIEW`, `entityId = null`, source severity and `priority` retained, audit written. TRANSIENT → `RETRY` with attempts; PERMANENT/unknown → `DEAD_LETTER` with audit | `ambiguous confirmed links are quarantined…`, `transient failure…`, `permanent failure…` |
| 3 | Event identity (`eventKey`, `RawEvent` unique) ignored the resource type; alert `123` and ticket `123` collided. Resolver returned a PERSON as a device | `eventKey` v2 and the unique index include `resourceType`; `ExternalLink` carries `resourceType` + `entityKind`; resolver requires `agent` + `DEVICE` | `event identity includes the resource type…`, `resolver requires matching resource type…`, SQL invariants |
| 4 | `prisma-context.ts` returned a different shape than the gateway consumed (`tickets` undefined, `event.source` crash) | `ClientContextV1` shared by fixtures, DB mapper and tools; tools return `ResourceView` with explicit status | `resource tools return an explicit resource view…`, `tool gateway works unchanged on a DB-mapped context` |
| 5 | Context took the 100 newest OPEN observations; old CRITICAL could be pushed out by new MEDIUM | `severityRank` column under a CHECK; order `(severityRank DESC, createdAt DESC, id)`; counts over the whole set; `truncated` flag | `DB rows map to ClientContextV1…`, SQL ordering invariant |
| 6 | Scope denials were not audited anywhere (gateway threw before audit; API 403 before gateway) | Workspace-level `SecurityAuditEvent` / `MemorySecurityAudit` with `requestedClientId` as text; gateway and API record before denying; `GET /audit/security` | `scope denial is recorded in the workspace security audit…`; API smoke |
| 7 | `parseRouteResponse` hard-coded `gpt-6-luna`; any other returned identifier became a generic invalid response | `DecisionConfig` (model + `allowedResponseModels` from env, no suffix matching); `MODEL_MISMATCH` as its own code, persisted in `DecisionRun` with requested/returned model | `…rejects … unexpected models`, `model mismatch is a distinct FAILED DecisionRun code…` |
| 8 | Atera normalizer invented `sourceSeverity` from a disk threshold | Fixture DTO carries the source's severity; thresholds belong to configuration | `…source severity is taken from the source, not from a threshold` |

### Added — schema and isolation

- Migration `202610071200_v1_1_contracts` (the foundation migration is untouched): `RawEvent.resourceType/eventKeyVersion/attempts/lastErrorCode`; `DecisionRun.mode/applied/requestedModel/responseModel` with one applied run per event; `Observation.entityId/decisionRunId` (composite FK includes `eventId`), `severityRank`, `priority`, `provider`, `promptVersion`, `reasonCodes[]`, lifecycle `status/updatedAt/resolvedAt/resolvedBy`; `SecurityAuditEvent` (append-only); CHECK constraints for every enumerated column.
- Row-level security on every table, keyed by `app.workspace_id` **and** `app.client_ids` (all clients share one workspace). Missing context denies. Not FORCEd: owner runs migrations/seed; the application uses the confined role from `prisma/roles.sql`.
- `packages/graph/scoped-db.ts`: `withScope()` sets context with `set_config(…, true)` inside the transaction; `assertRuntimeRole()` refuses owner/superuser/BYPASSRLS roles; identifier policy for scope IDs.
- `scripts/pg17-check.ts` (`npm run db:check:pg17`): real PostgreSQL 17 integration — both migrations, invariants, RLS through a confined LOGIN role, pool connection reuse, and a negative control showing that a session-level setting would leak.
- `tests/sql-invariants.ts` shared by the PGlite test and the PostgreSQL 17 check.

### Changed — contracts

- `Actor { memberships: [{ clientId, permissions[] }], workspacePermissions[] }` replaces flat `clientIds`/`permissions` (implementation of auth remains task 1.3).
- `Observation` flattened: `route/confidence/provider/promptVersion/reasonCodes/priority/domain/entityId/decisionRunId`; `ObservationSummary` for context and tools.
- `domain` semantics fixed for Stage 1: `DISK_CAPACITY → OPERATIONS`, `SECURITY_INCIDENT → SECURITY`; the event type stays in `kind`.
- `DecisionProvider` exposes `provider` and `mode`; `RulesDecisionProvider`/`rulesBaseline()` added; shadow mode applies the baseline and stores the AI result with `applied = false`.
- Connector contract passes `ResolvedConnection` (with verified `externalTenantId`) to adapters and the secret resolver.
- `runDemo()` moved to `fixtures/run-demo.ts`; `scripts/demo.ts` is a CLI wrapper; the API no longer imports from `scripts/`.
- NestJS: `AtlasError.kind` → HTTP (403 / 400 / 502 / 500) instead of 403 for everything; `GET /audit/security`.
- Dev dependency `pg@8.23.1` (+ types) for the PostgreSQL 17 check.

### Documentation

docs/01–07, AGENTS.md, START_HERE_RU.md, README.md, prompts/IMPLEMENT_STAGE_1.md, .env.example updated to the v1.1 contracts; ADR-008…012 added; acceptance table extended with the RLS, conflict, identity, ordering and audit scenarios; verification/RESULTS.md reports PGlite, PostgreSQL 17 and live separately.

### Not changed / still pending

No production worker, adapters, auth, snapshot repository, provider telemetry or live calls. Prisma Client integration (generate/seed/`prisma-context` against PostgreSQL) was not executable in the build environment of this release and is reported as such in verification/RESULTS.md.

## 1.0.0 — 2026-10-07

Initial development pack: specification, Prisma 6.19 schema and foundation migration, reference pipeline, fixture NestJS API, prompts and verification evidence.
