# Changelog

## Unreleased — Stage 1 implementation (branch `stage1/foundation`)

Checkpoint A (tasks 1.1–1.3) accepted by the independent review (`REVIEW_REPORT.md`, revision 2). Status, verification and open gates of Checkpoint A: `CHECKPOINT_REPORT.md`.

### Fixed — re-review of Checkpoint B (`REVIEW_REPORT.md` revision 2, B3 for first reads)
- Overlapping FIRST syncs of a resource without `SyncState` were not ordered: every such attempt had no number and the first to finish won, so a later-begun success was dropped and a later-begun failure was hidden. Migration `202610072100_stage1_sync_attempt_pending`: `beginAttempt` now numbers every attempt atomically before any vendor I/O (`INSERT … ON CONFLICT DO UPDATE`), creating the state row as `PENDING` (an attempt began, no outcome: no times, no code, recordedSeq 0 — CHECK); outcomes are recorded by update. The context shows `PENDING` as `MISSING` with `SYNC_NOT_COMPLETED`.
- Regression tests on a resource without state: both completion orders of success/success, success/failure and failure/success, identical times (the begin order decides), identity reads, and a skewed clock (a later-begun attempt with an older time records nothing); the five first-read tests fail on the previous code. SQL invariants for PENDING; negative controls for the attempt number, the time guard and the PENDING mapping.

### Fixed — independent review of Checkpoint B (`REVIEW_REPORT.md`, B1–B4)
- B1: a worker whose lease was taken over could still dead-letter or retry the event and erase the new owner's lease (the new owner then found it finished; a CRITICAL event got no observation). Migration `202610072000_stage1_claim_token_sync_order` gives every claim its own `claimToken` (lease = owner, expiry and token, all or none); phase 1, the final commit and RETRY/DEAD_LETTER require the current token under the row lock. A stale worker ends with `CLAIM_LOST` and changes nothing; it notices the takeover before calling the provider.
- B2: `maxAttempts` bounded only reported failures; claims that never reported back were retried forever. The claim now dead-letters due events whose attempts are used up and whose lease expired (`ATTEMPTS_EXHAUSTED`, audit `event.dead_lettered`, no provider call) in the same transaction; the stored phase-1 decision stays and an explicit requeue completes it without a new provider call.
- Found while fixing B2: the claim's `UPDATE … WHERE … IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` could take more than `n` rows under a generic plan of the prepared statement (reproduced with `plan_cache_mode = force_generic_plan`: batch 1 took 2 events). Both claim statements now pick their rows in a `MATERIALIZED` CTE evaluated once; the recovery tests run under forced generic plans.
- B3: an older sync finishing after a newer one overwrote the newer snapshot and its times (an older failure even threw a CHECK violation). `SyncState.attemptSeq`/`recordedSeq` (same migration) order the attempts: an attempt takes its number before reading, and its outcome is recorded only if no attempt that began later has been recorded and its time is not older (`packages/sync/sync-state.ts`). A superseded read reports `superseded: true` and still stores its events. Snapshot resources and identity reads both use it.
- B4: an inconsistent paged read was accepted as complete (Atera: an empty last page with remaining items declared; a repeated incident across Huntress pages). Atera now requires the same totals on every page, no empty page before the declared last one, no repeated ID and exactly `totalItemCount` records; Huntress rejects repeated IDs. Otherwise `UPSTREAM_PAGINATION_INCONSISTENT` (TRANSIENT): the previous snapshot stays STALE and nothing of the read is stored. A consistent empty set is a complete read.
- Regression tests: `tests/pg/worker-recovery.pg.test.ts`, `tests/pg/sync-order.pg.test.ts`, `tests/pg/pagination.pg.test.ts` (the reviewer's orders and their variants), SQL invariants for the token triple and the attempt order; B3 and B4 reproduced on the unfixed code first; negative controls for every guard.

### Added — task 1.6 Persistent sync and events
- Migration `202610071900_stage1_event_inbox`: RawEvent as the durable inbox (`nextAttemptAt`, lease owner/expiry, stored phase-1 `preparedDecision`, failure codes for RETRY/DEAD_LETTER, pending index) and DecisionRun vocabularies (OK/FAILED with codes; fixture/rules/openai); preflight on unknown values.
- `packages/events/inbox.ts`: durable store with eventKey v2 dedup, content conflicts as linked evidence rows (canonical never overwritten, audited once), connection-bound ingestion, operator inbox view and explicit, audited requeue of dead letters.
- `packages/events/worker.ts`: claim with `FOR UPDATE SKIP LOCKED` and leases; phase 1 stores the decision runs NOT applied with the prepared decision; phase 2 applies, creates the observation, audits and completes in one transaction; crash recovery by lease expiry without a second provider call; TRANSIENT → bounded RETRY with backoff → DEAD_LETTER, PERMANENT/unknown → DEAD_LETTER, all audited. A quarantined link of the event's agent is a CONFLICT (AMBIGUOUS_DEVICE_LINK) that keeps CRITICAL urgent.
- Shared `packages/events/identity.ts` and `packages/events/decision.ts` (provider call validation, advisory fallback, deterministic route rules) now drive both the reference pipeline and the worker.
- Huntress snapshot reads also feed the inbox, atomically with the snapshot; a failed read stores nothing; re-reads are duplicates.
- Tests: inbox/lease/vocabulary SQL invariants (PGlite + pg17-check), inbox, worker and routing PostgreSQL tests incl. two workers, restart after phase 1, final-transaction retry, dead letters, a Huntress read failing on page 2 (no event stored), a resource failure confined to that resource (sibling, other connection and connection status unchanged) and end to end; mutation checks run.

### Added — task 1.5 Read adapters
- Migration `202610071800_stage1_resource_snapshots`: `ResourceSnapshot` (last complete read per connection × alert/ticket/incident, at most 100 items with the source total, composite FK to its `SyncState`, RLS) and a `SyncState` vocabulary (OK/ERROR/UNAVAILABLE with codes; success never after the attempt). Decision recorded in docs/02: scoped snapshot persistence.
- Read adapters with runtime DTO validation, tenant-scoped upstream requests, bounded pagination and classified HTTP errors: Huntress (incidents `status=sent`, agents, health; contract verified against the official reference) and Atera (open tickets by `customerId`, agents by customer, health; contract from an OpenAPI export, unverified against an account). Atera alerts are not read (no customer filter) and show `UPSTREAM_TENANT_FILTER_UNAVAILABLE`. `connectors/CONTRACTS.md` records sources, checksums, mappings and the account checklist.
- `packages/sync`: `syncResource` (snapshot replaced with the success in one transaction; failures keep it and never advance `lastSuccessAt`), `syncIdentities` (agents → external entities → matcher candidates), `syncConnection`, `activateConnection` (health check → ACTIVE, audited). `resolveCredential`: only ACTIVE connections (or one being activated) reach a vendor; `EnvSecretResolver` for `env://`.
- `ResourceView` statuses from snapshots and freshness (OK / STALE / ERROR / MISSING), `completeness = COMPLETE` when all resources are OK; compact `SnapshotItem` without contact data.
- Tests: vendor contract and HTTP classification unit tests, freshness unit tests, adapter and sync PostgreSQL tests against a scoped mock vendor (synthetic fixtures in `fixtures/vendor`); mutation checks run.

### Added — task 1.4 Mapping workflow
- Migration `202610071700_stage1_mapping_workflow`: Connection status vocabulary and explicit binding provenance (`boundBy`/`boundAt`, required for ACTIVE; bound tenant and provenance immutable by trigger); `EntityLink` carries `resourceType`/`entityKind` pinned by composite FKs to the typed rows and a compatibility CHECK (agent↔DEVICE, contact↔PERSON); status `QUARANTINED` with reviewer/reason and a scoped pointer to the conflicting link of the same external object; permissions `mapping:review`, `connections:manage`. Preflight stops on unknown connection statuses or incompatible existing links.
- `packages/connections/connections.ts`: `resolveConnection` is the only issuer of (frozen) `ResolvedConnection`s, verified by `assertResolvedConnection`; `bindConnection` records explicit client ↔ customer/organization bindings (DISABLED until activation; a tenant bound elsewhere → `TENANT_ALREADY_BOUND`, audited).
- `packages/graph/mapping.ts`: `registerExternalEntity`, `suggestDeviceCandidate` (exact hostname inside the client; ambiguity creates nothing and is audited), `proposeLink`, `confirmLink` (first confirmation wins; a conflicting one is QUARANTINED, never lost; serialized per external object), `rejectLink` (incl. revocation), `listMappingReview`. Decisions and their client audit rows commit together; vendor IDs never enter the audit.
- Tests: mapping schema invariants (PGlite + `pg17-check`), migration preflight on a populated database, `tests/pg/connections.pg.test.ts`, `tests/pg/mapping.pg.test.ts` (incl. concurrent confirmations on two pools).

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
