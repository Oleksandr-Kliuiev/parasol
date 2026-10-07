# Vardahei Atlas — Stage 1 v1.1.3

Start with [START_HERE_RU.md](START_HERE_RU.md). Branch `stage1/foundation` implements tasks 1.1–1.3 on top of the pack; status, verification and open gates: [CHECKPOINT_REPORT.md](CHECKPOINT_REPORT.md).

This development pack contains a Stage 1 specification, a Prisma 6.19 schema with two PostgreSQL migrations (foundation + v1.1 contracts with row-level security), typed contracts, an executable synthetic pipeline, a fixture-only NestJS API, implementation prompts, and verification evidence. v1.1 fixes the contract defects found by two independent reviews of v1.0 (see CHANGELOG.md). It does not claim that the production Atlas backend, live connectors, or live Decisions calls are implemented and verified.

Baseline: Node.js 24+, PostgreSQL 17, Prisma 6.19.0, NestJS 11.1.6, TypeScript 5.9.3. Versions are explicitly pinned in the lockfile; they are not advertised as the latest releases.

## Directory map

```text
apps/api/             NestJS API: fixture mode (synthetic reference) and db mode (src/db: PostgreSQL via the runtime role, token auth)
apps/worker/          target persistent worker boundary
apps/web/             reserved for later UI slice
packages/core/        normalized contracts: Actor with memberships, AtlasError, ClientContextV1, priority/domain
packages/graph/       typed-link resolver, scoped-db (RLS context + runtime-role check), context mapper, Prisma context query
packages/decisions/   fixture + rules providers, DecisionConfig, OpenAI adapter with model allowlist (mock-tested)
packages/events/      in-memory reference pipeline: inbox statuses, conflict/retry/dead-letter, applied vs shadow runs
packages/tools/       read-only registry and gateway returning ResourceView
packages/audit/       allowlisted client audit and workspace security audit (in-memory reference + PostgreSQL)
packages/auth/        bearer tokens (digest only) and database authentication to Actor with per-client memberships
connectors/           connector interface with ResolvedConnection and synthetic Atera/Huntress normalizers
fixtures/             synthetic Gasta graph and shared demo composition
prisma/               schema, migrations (three frozen + actor/membership), hardening, roles.sql (runtime role), upgrades/, synthetic seed
scripts/              demo CLI, API smoke, pg17-check (real PostgreSQL 17 SQL checks), schema-drift-check
docs/                 normative specification and implementation plan
prompts/              implementation/review tasks and checkpoint template
tests/                pipeline, context mapper, PGlite migration + RLS tests, shared SQL invariants; tests/pg: Prisma/PostgreSQL integration
verification/         dated test evidence (PGlite / PostgreSQL 17 / live, separately) and sample context
```

`npm run demo` needs no installed dependencies. The full test suite and API need `npm ci`. `npm run db:check:pg17` needs a real PostgreSQL 17 admin connection (`ATLAS_PG_ADMIN_URL`). Real vendor DTOs, webhook contracts and permissions must be validated against account-specific documentation before live adapter work.
