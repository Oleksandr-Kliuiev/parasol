# AI context map

Load the smallest set of files a task needs. Rules: `AGENTS.md`. Scope and plan: `docs/01_STAGE_1_SPEC.md`, `docs/05_IMPLEMENTATION_PLAN.md`. Every active file stays under 700 lines (`tests/context-budget.test.ts`).

## Task → entry files

| Task | Start with | Then, only if needed |
|---|---|---|
| Contract change (Actor, ClientContextV1, errors, priority) | `packages/core/contracts.ts` | `packages/graph/context-mapper.ts`, `fixtures/run-demo.ts` |
| Schema / new migration | `prisma/schema.prisma`, newest `prisma/migrations/*/migration.sql` | `docs/02_DATA_AND_MODULES.md` (tables), `tests/sql-invariants.ts` |
| RLS, runtime role, scoped access (`withScope`, `withWorkspaceScope`, `assertRuntimeRole`) | `packages/graph/scope-context.ts`, `packages/graph/scoped-db.ts`, `prisma/roles.sql` | migration `202610071200_v1_1_contracts` section 5 |
| DB-backed client context | `packages/graph/prisma-context.ts`, `packages/graph/context-mapper.ts` | `tests/context-mapper.test.ts` |
| Event pipeline (dedup, conflict, retry, dead-letter) | `packages/events/pipeline.ts` | `tests/pipeline.test.ts`, `docs/03_CONNECTORS_AND_SYNC.md` |
| Decisions provider / shadow / advisory | `packages/decisions/provider.ts`, `packages/decisions/openai.ts` | `docs/04_DECISION_LAYER.md` |
| Connectors / normalizers | `connectors/contracts.ts`, `connectors/<system>/normalizer.ts` | `docs/03_CONNECTORS_AND_SYNC.md` |
| Read tools / gateway | `packages/tools/gateway.ts` | `packages/audit/memory.ts` |
| Audit (client allowlist, workspace security audit) | `packages/audit/memory.ts` (reference), `packages/audit/prisma.ts` (PostgreSQL sinks + scoped reads) | `docs/02_DATA_AND_MODULES.md` (Audit) |
| Fixture API | `apps/api/src/atlas.module.ts`, `apps/api/src/main.ts` | `scripts/api-smoke.ts` |
| PostgreSQL integration tests (Prisma, real server) | `tests/support/pg-harness.ts`, `tests/pg/*.pg.test.ts` | `tests/support/migrations.ts` |
| Acceptance scenarios / gates | `docs/06_ACCEPTANCE.md` | `verification/RESULTS.md` |

## Do not load in full

- `package-lock.json`, `node_modules/`, `dist/`: generated.
- `prisma/upgrades/*`, `CHANGELOG.md`, `verification/*`: history and evidence; search them with `rg` when a task needs a specific fact.
- Frozen migrations (`202610070001_foundation`, `202610071200_v1_1_contracts`, `202610071500_v1_1_2_…`): read the section you need; never edit them.
- `MANIFEST.json`: file hashes of the imported 1.1.3 pack, not of the current branch.

## Commands

| Purpose | Command |
|---|---|
| Unit + PGlite tests (no server) | `npm test` |
| Types / API build | `npm run typecheck`, `npm run api:build` |
| Fixture API smoke | `npm run api:build && npm run api:smoke` |
| Real PostgreSQL 17 SQL check | `ATLAS_PG_ADMIN_URL=… npm run db:check:pg17` |
| Prisma/PostgreSQL integration (throwaway DB: deploy, roles.sql, seed, runtime role) | `ATLAS_PG_ADMIN_URL=… npm run test:pg` |
| Migrations ↔ `schema.prisma` drift (must be empty) | `ATLAS_PG_ADMIN_URL=… npm run db:check:drift` |
| Dev DB (owner, then runtime role) | `npm run db:deploy` → `prisma/roles.sql` via psql → `npm run db:seed` |
