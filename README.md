# Vardahei Atlas — Stage 1 v1.1.3

Start with [START_HERE_RU.md](START_HERE_RU.md). Branch `stage1/foundation` implements tasks 1.1–1.10 on top of the pack (Checkpoint C awaits review); status, verification and open gates: [CHECKPOINT_REPORT.md](CHECKPOINT_REPORT.md); setup, operation and the live-read gate: [docs/RUNBOOK.md](docs/RUNBOOK.md); verified results by environment: [verification/RESULTS.md](verification/RESULTS.md).

The branch adds to the pack: a DB-backed API through a confined runtime role (RLS), per-client memberships with token authentication, a mapping workflow, read-only Atera/Huntress adapters with snapshot sync, a durable event inbox and worker, a decision layer (rules baseline, shadow/advisory OpenAI Decisions with guard and telemetry), observation lifecycle and pages, a ledgered read-tool gateway, and an operator CLI. Everything is tested against PGlite and a real PostgreSQL 17 server with mock vendors and a scripted Decisions endpoint. **No live vendor or Decisions call has been made** (no credentials), and it is not a production-ready system.

Baseline: Node.js 24+, PostgreSQL 17, Prisma 6.19.0, NestJS 11.1.6, TypeScript 5.9.3. Versions are explicitly pinned in the lockfile; they are not advertised as the latest releases.

## Directory map

```text
apps/api/             NestJS API: fixture mode (synthetic reference) and db mode (src/db: PostgreSQL via the runtime role, token auth)
apps/worker/          worker process boundary (Stage 1 runs passes with `npm run ops -- worker-once`)
apps/web/             reserved for later UI slice
packages/core/        normalized contracts: Actor with memberships, AtlasError, ClientContextV1, priority/domain
packages/graph/       typed-link resolver, scoped-db (RLS context + runtime-role check), context mapper, Prisma context query
packages/decisions/   providers, versioned DecisionConfig, OpenAI adapter with model allowlist (mock-tested), guard, telemetry
packages/events/      durable inbox, two-phase worker, shadow jobs; the in-memory reference pipeline (pipeline.ts)
packages/sync/        snapshot sync, activation, attempt order; packages/connections/: bindings and ResolvedConnection
packages/observations/ lifecycle (triage, revisions) and observation pages
packages/tools/       read-only registry with parameter schemas, gateway and ToolExecution ledger; packages/policy/: tool policy
packages/ops/         operator commands (scripts/ops.ts): bind, live-read, mapping review, inbox/requeue, triage, telemetry, baseline and shadow passes
packages/audit/       allowlisted client audit and workspace security audit (in-memory reference + PostgreSQL)
packages/auth/        bearer tokens (digest only) and database authentication to Actor with per-client memberships
connectors/           read-only Atera/Huntress adapters (GET-only transport, DTO validation), contracts in connectors/CONTRACTS.md
fixtures/             synthetic Gasta graph and shared demo composition
prisma/               schema, migrations (three frozen pack migrations + Stage 1 migrations), roles.sql (runtime role), upgrades/, synthetic seed
scripts/              demo CLI, API smoke, pg17-check (real PostgreSQL 17 SQL checks), schema-drift-check, ops (operator CLI)
docs/                 normative specification, implementation plan, acceptance matrix (06), RUNBOOK
prompts/              implementation/review tasks and checkpoint template
tests/                unit, fixture and PGlite tests, shared SQL invariants; tests/pg: PostgreSQL 17 integration, DB-mode API, E2E, ops CLI
verification/         dated results (fixture/unit, PGlite, PostgreSQL 17, live — separately) and evidence; verification/e2e: the E2E run
```

`npm run demo` needs no installed dependencies. The full test suite and API need `npm ci`. `npm run db:check:pg17`, `npm run test:pg` and `npm run db:check:drift` need a real PostgreSQL 17 admin connection (`ATLAS_PG_ADMIN_URL`; `docker compose up -d` locally). The Atera contract must be confirmed against the account before a live read (checklist in `connectors/CONTRACTS.md`).
