# AI context map

Load the smallest set of files a task needs. Rules: `AGENTS.md`. Scope and plan: `docs/01_STAGE_1_SPEC.md`, `docs/05_IMPLEMENTATION_PLAN.md`. Every active file stays under 700 lines (`tests/context-budget.test.ts`).

## Task → entry files

| Task | Start with | Then, only if needed |
|---|---|---|
| Contract change (Actor, ClientContextV1, errors, priority) | `packages/core/contracts.ts` | `packages/graph/context-mapper.ts`, `fixtures/run-demo.ts` |
| Schema / new migration | `prisma/schema.prisma`, newest `prisma/migrations/*/migration.sql` | `docs/02_DATA_AND_MODULES.md` (tables), `tests/sql-invariants.ts` |
| RLS, runtime role, scoped access (`withScope`, `withWorkspaceScope`, `assertRuntimeRole`) | `packages/graph/scope-context.ts`, `packages/graph/scoped-db.ts`, `prisma/roles.sql` | migration `202610071200_v1_1_contracts` section 5 |
| DB-backed client context | `packages/graph/prisma-context.ts`, `packages/graph/context-mapper.ts` | `tests/context-mapper.test.ts` |
| Observation lifecycle, revisions, pages (status/severity filters, keyset cursor) | `packages/observations/lifecycle.ts`, `packages/observations/query.ts`, migration `202610072300_stage1_observation_lifecycle` | `tests/pg/observation-lifecycle.pg.test.ts`, `tests/pg/api.pg.test.ts` (HTTP page), docs/02 (Жизненный цикл) |
| Event pipeline, in-memory reference (dedup, conflict, retry, dead-letter) | `packages/events/pipeline.ts` | `tests/pipeline.test.ts`, `docs/03_CONNECTORS_AND_SYNC.md` |
| Durable inbox and worker (store, claim/lease/token, two phases, retry/dead-letter, requeue) | `packages/events/inbox.ts`, `packages/events/worker.ts`, `packages/events/decision.ts`, `packages/events/identity.ts` | `tests/pg/inbox.pg.test.ts`, `tests/pg/worker.pg.test.ts`, `tests/pg/worker-routing.pg.test.ts`, `tests/pg/worker-recovery.pg.test.ts` (stale claims, crash bound), `tests/support/events-fixtures.ts` |
| Decisions provider / shadow / advisory, config, circuit-breaker, telemetry | `packages/decisions/provider.ts`, `packages/decisions/openai.ts`, `packages/decisions/config.ts` + `config/decisions.json`, `packages/decisions/guard.ts`, `packages/decisions/runtime.ts`, `packages/decisions/telemetry.ts`, `packages/events/shadow.ts` (shadow jobs) | `docs/04_DECISION_LAYER.md`, `tests/decision-config.test.ts`, `tests/decision-guard.test.ts`, `tests/pg/shadow-jobs.pg.test.ts`, `tests/pg/decision-advisory.pg.test.ts`, `tests/support/decision-fixtures.ts` |
| Connectors / normalizers | `connectors/contracts.ts`, `connectors/<system>/normalizer.ts` | `docs/03_CONNECTORS_AND_SYNC.md` |
| Connection binding, `ResolvedConnection` issuance | `packages/connections/connections.ts` | `tests/pg/connections.pg.test.ts`, docs/03 (Mapping) |
| Read adapters (vendor contracts, HTTP, DTO validation) | `connectors/CONTRACTS.md`, `connectors/<system>/contract.ts`, `connectors/<system>/connector.ts` | `connectors/http.ts`, `connectors/dto.ts`, `tests/vendor-contracts.test.ts`, `tests/pg/adapters.pg.test.ts` |
| Snapshot sync, activation, freshness → ResourceView | `packages/sync/snapshots.ts`, `packages/sync/activation.ts`, `packages/sync/sync-state.ts` (attempt order), `packages/graph/context-mapper.ts` (`mapResources`) | `tests/pg/sync.pg.test.ts`, `tests/pg/sync-order.pg.test.ts`, `tests/pg/pagination.pg.test.ts`, `tests/resource-freshness.test.ts`, `tests/support/vendor-routes.ts` |
| Mapping workflow (external entities, candidates, confirm/quarantine/reject, review queue) | `packages/graph/mapping.ts`, migration `202610071700_stage1_mapping_workflow` | `tests/pg/mapping.pg.test.ts`, `tests/support/graph-fixtures.ts`, docs/02 (Entity matching) |
| Read tools / gateway / tool policy (registry, parameter schemas, `connectionId` selection, ToolExecution ledger) | `packages/tools/gateway.ts`, `packages/tools/registry.ts`, `packages/policy/tool-policy.ts` | `packages/tools/parameters.ts`, `packages/tools/ledger.ts`, `packages/tools/prisma-ledger.ts`, `tests/tool-gateway.test.ts`, `tests/pg/tool-gateway.pg.test.ts`, `tests/pg/api-input.pg.test.ts` (DTO) |
| Operator CLI (bind, live-read, mapping review, inbox/requeue, triage, telemetry, worker pass, Decisions smoke) | `packages/ops/commands.ts`, `scripts/ops.ts` | `packages/ops/live-read.ts`, `packages/ops/worker-pass.ts`, `tests/ops-commands.test.ts`, `tests/pg/ops-cli.pg.test.ts` (process, exit codes), `docs/RUNBOOK.md` |
| End-to-end scenario (Checkpoint C: full context, shadow runs, read tools with audit) | `tests/pg/e2e.pg.test.ts` | `verification/e2e/*.json` (evidence of one run), `prisma/seed.ts` + `fixtures/gasta.ts` (technician and operator) |
| Operation, live-read gate, rollback | `docs/RUNBOOK.md` | `docs/06_ACCEPTANCE.md` (gates, acceptance matrix), `connectors/CONTRACTS.md` (Atera account checklist) |
| Audit (client allowlist, workspace security audit) | `packages/audit/sanitize.ts` (allowlist, escaped audit text), `packages/audit/memory.ts` (reference), `packages/audit/prisma.ts` (PostgreSQL sinks + scoped reads) | `docs/02_DATA_AND_MODULES.md` (Audit), `tests/audit-sanitize.test.ts` |
| Authentication, actors, memberships | `packages/auth/prisma-auth.ts`, `packages/auth/token.ts`, migration `202610071600_stage1_actor_membership` | `apps/api/src/db/auth.ts` (guard, AccessPolicy) |
| DB-backed API (`ATLAS_MODE=db`) | `apps/api/src/db/app.module.ts`, the controller of the route (`clients.ts`, `audit.ts`, `tools.ts`) | `apps/api/src/http-boundary.ts`, `tests/pg/api.pg.test.ts`, `tests/pg/api-input.pg.test.ts` (malformed input) |
| Fixture API | `apps/api/src/atlas.module.ts`, `apps/api/src/main.ts` | `scripts/api-smoke.ts` |
| PostgreSQL integration tests (Prisma, real server) | `tests/support/pg-harness.ts`, `tests/pg/*.pg.test.ts` | `tests/support/migrations.ts`, `tests/support/api-process.ts` |
| Checkpoint status / open gates | `CHECKPOINT_REPORT.md` | `prompts/CHECKPOINT_REPORT.md` (template) |
| Acceptance scenarios / gates (gate → test matrix) | `docs/06_ACCEPTANCE.md` | `verification/RESULTS.md` |

## Do not load in full

- `package-lock.json`, `node_modules/`, `dist/`: generated.
- `prisma/upgrades/*`, `CHANGELOG.md`, `verification/*` (incl. `verification/e2e/*.json`): history and evidence; search them with `rg` when a task needs a specific fact.
- Frozen migrations (`202610070001_foundation`, `202610071200_v1_1_contracts`, `202610071500_v1_1_2_…`): read the section you need; never edit them.
- `MANIFEST.json`: file hashes of the imported 1.1.3 pack, not of the current branch.
- `fixtures/vendor/*.json`: synthetic vendor responses; open one only when a test about that endpoint fails.

## Commands

| Purpose | Command |
|---|---|
| Unit + PGlite tests (no server) | `npm test` |
| Types / API build | `npm run typecheck`, `npm run api:build` |
| Fixture API smoke | `npm run api:build && npm run api:smoke` |
| Real PostgreSQL 17 SQL check | `ATLAS_PG_ADMIN_URL=… npm run db:check:pg17` |
| Prisma/PostgreSQL integration + DB-mode API (throwaway DB: deploy, roles.sql, seed, runtime role) | `ATLAS_PG_ADMIN_URL=… npm run test:pg` |
| Migrations ↔ `schema.prisma` drift (must be empty) | `ATLAS_PG_ADMIN_URL=… npm run db:check:drift` |
| Dev DB (owner, then runtime role) | `npm run db:deploy` → `prisma/roles.sql` via psql → `ATLAS_DEMO_TOKEN=… ATLAS_OPERATOR_TOKEN=… npm run db:seed` |
| DB-mode API | `npm run api:build && ATLAS_MODE=db ATLAS_RUNTIME_DATABASE_URL=… npm run api:start` |
| Operator CLI (runtime role + operator token; `decisions-smoke` needs only `OPENAI_API_KEY`) | `npm run ops -- <command> [--flag value]…` (list: header of `scripts/ops.ts`) |
| E2E with evidence files | `ATLAS_E2E_EVIDENCE_DIR=verification/e2e ATLAS_PG_ADMIN_URL=… node --experimental-strip-types --test tests/pg/e2e.pg.test.ts` (after `npm run api:build`) |
