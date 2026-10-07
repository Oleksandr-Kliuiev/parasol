# Verified results — Stage 1 (tasks 1.1–1.10), 7 October 2026

Branch `stage1/foundation`. The verified state is the commit that adds this file (task 1.10); `CHECKPOINT_REPORT.md` names the hash. The results of the imported pack v1.1.3 remain in git: `git show 4d6f897:verification/RESULTS.md`.

Environment:
- macOS 26.6.2 (arm64), Node.js v25.8.1, npm 11.11.0.
- Prisma 6.19.0 (CLI and client), TypeScript 5.9.3, NestJS 11.1.6.
- PGlite 0.3.14 (embedded PostgreSQL 17 core, in process).
- PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2), the `postgres:17` image from `compose.yaml`, over TCP.

Every chain started from `rm -rf node_modules dist && npm ci`.

The environments are reported separately and are not interchangeable:
- **Fixture/unit** — Node only. Synthetic contexts, in-memory sinks, mock vendors and a scripted Decisions endpoint.
- **PGlite** — the SQL of all migrations, invariants and RLS in process.
- **PostgreSQL 17** — a real server:
  - migrations through `prisma migrate deploy` and `prisma/roles.sql`;
  - the application through the confined runtime role;
  - the compiled API in `ATLAS_MODE=db`;
  - the ops CLI as a process.

  Vendors are still the mock transport and Decisions a scripted endpoint.
- **Live** — real Atera, Huntress and OpenAI Decisions. **Not executed.**

Mock transport and scripted responses are synthetic, shaped after the documented contracts. They are not live API verification.

## Fixture / unit — Node, no database

| Check | Command | Actual result |
|---|---|---|
| Install, client, schema | `npm ci`, `npm run db:generate`, `npm run schema:validate` | exit 0; schema valid |
| Unit and fixture tests | `npm test` (all files except `tests/database.test.ts`) | 67 passed, 0 failed (`tests.txt`). Files: pipeline reference, context mapper, resource freshness, vendor contracts and normalizers, audit sanitizer, token format, decision config and guard, tool gateway (incl. `connectionId` selection and `AMBIGUOUS_CONNECTION`), ops CLI arguments / live-read verdict / Decisions smoke over a scripted endpoint, context budget (no active file over 700 lines) |
| Types | `npm run typecheck` | 0 errors |
| API build and fixture smoke | `npm run api:build && npm run api:smoke` | PASS (`api-smoke.txt`) |
| Synthetic demo | `npm run demo` | `ClientContextV1` in fixture mode, CRITICAL first, three FIXTURE resources (`demo-context.json`) |

## PGlite

| Check | Command | Actual result |
|---|---|---|
| All 12 migrations, SQL invariants of every Stage 1 table, RLS acceptance, runtime-role guard, upgrade of a populated v1.0 database, path 1.1.0 → 1.1.2 | `npm test` (`tests/database.test.ts`) | 13 passed, 0 failed (`tests.txt`; the `npm test` total is 80/80) |

## PostgreSQL 17 (real server)

| Check | Command | Actual result |
|---|---|---|
| SQL invariants and RLS on the server | `npm run db:check:pg17` | PASS (`pg17-check.txt`). 12 migrations in order; invariants of mapping, snapshots, inbox, decision layer, lifecycle and tool ledger; RLS through a confined login role and a pool of one connection; runtime-role guard; pool reuse |
| Prisma/PostgreSQL integration, DB-mode API, E2E, ops CLI | `npm run test:pg` | 108 passed, 0 failed in 20 files (`test-pg.txt`). Each file uses a throwaway DB on the documented path: owner — `migrate deploy`, `roles.sql`, seed; then the runtime role |
| End to end (task 1.10, Checkpoint C) | `tests/pg/e2e.pg.test.ts` (in `test:pg`; `ATLAS_E2E_EVIDENCE_DIR=verification/e2e` writes the evidence) | 9 passed. Evidence of the run in `e2e/` — see the list after this table |
| Ops CLI as a process | `tests/pg/ops-cli.pg.test.ts` (in `test:pg`) | 4 passed. See the list after this table |
| Migrations ↔ `schema.prisma` | `npm run db:check:drift` | PASS: empty diff |
| Dev database (owner, then runtime role) | `npm run db:deploy` (no pending), `db:seed` with both tokens; `npm run ops -- mapping / inbox / telemetry`, `worker-once` (rules); API `ATLAS_MODE=db` | See the list after this table |
| Leftovers | `pg_database` / `pg_roles` after all runs | No throwaway database or role left; no API or CLI process left |

E2E evidence in `e2e/`:
- `1-live-read.json` — live-read summaries and the vendor requests: GET only, tenant filters;
- `2-mapping-queue.json`;
- `3-worker-pass.json` — applied rules runs and non-applied model runs with models, tokens and `configVersion`;
- `4-context.json` — the full `ClientContextV1`;
- `5-read-tools.json` — ToolExecution rows, client audit, security audit;
- `6-telemetry.json`.

Ops CLI process test:
- the owner URL is refused: exit 2 `RUNTIME_ROLE_BYPASSES_RLS`;
- a wrong token: exit 2 `OPERATOR_TOKEN_INVALID`;
- bad arguments: exit 2;
- `decisions-smoke` without a key: exit 2 `OPENAI_KEY_REQUIRED`, nothing sent;
- bind: exit 0;
- live-read without the credential variable: exit 1, `SECRET_NOT_FOUND`, nothing sent;
- `worker-once` with `ATLAS_DECISIONS_MODE=rules`: version `-env`, no shadow;
- a dead letter: visible in `inbox`, then `requeue` and a processed pass;
- mapping review; another client: exit 2 `SCOPE_DENIED`, recorded in the security audit.

Dev database:
- all CLI commands exit 0 through the runtime role and the operator token;
- `worker-once` in shadow mode without a key: exit 2 `OPENAI_KEY_REQUIRED`;
- the owner URL: exit 2 `RUNTIME_ROLE_BYPASSES_RLS`;
- the technician's token: `PERMISSION_DENIED`; another client: `SCOPE_DENIED`;
- API: overview 200, PARTIAL with three MISSING fixture resources; the operator gets 403 on `/audit/security`; the API refuses to start through the owner (`RUNTIME_ROLE_BYPASSES_RLS`).

Mutation checks of the task 1.10 code — each mutation applied alone, then the relevant test run. 16 of 16 were caught:
1. Ambiguity not refused.
2. `connectionId` ignored.
3. No security audit on a CLI refusal.
4. CLI permissions not checked.
5. Duplicate flags accepted.
6. Inherited command names accepted.
7. Live-read verdict ignores resources.
8. Smoke always OK.
9. Inherited triage action names.
10. No runtime-role check in the CLI.
11. A failed check exits 0.
12. The shadow pass uses the pass start time.
13. No health gate in live-read.
14. No activation gate in live-read.
15. Context connections in physical order.
16. Operator token ignored by the seed.

Mutation 15 is caught through the physical order of the rows in this run; PostgreSQL does not guarantee that order, so this catch is not deterministic.

## Live — not executed

| Check | Status | What it needs / what is ready |
|---|---|---|
| Atera read (customer, agents, open tickets) | **Blocked: no credentials** | A read-only API key and the customer ID. Before the first read: the account checklist in `connectors/CONTRACTS.md` (the contract is from the public OpenAPI export, not confirmed against an account). Procedure: `docs/RUNBOOK.md` §5 (`npm run ops -- bind`, `live-read`) |
| Atera alerts | Not read, by the owner's decision (2026-10-07) | No customer filter upstream; `UNAVAILABLE` / `UPSTREAM_TENANT_FILTER_UNAVAILABLE` |
| Huntress read (organization, agents, incident reports) | **Blocked: no credentials** | The API key:secret pair and the organization ID; same procedure |
| OpenAI Decisions smoke test | **Blocked: no API key** | `npm run ops -- decisions-smoke` (compact synthetic input). Without a key: exit 2 `OPENAI_KEY_REQUIRED`, verified. The response `model` for `gpt-6-luna` and `usage.input_tokens` are unverified against the live service |
| Deployment, vault backend (`vault://`), scheduler, actor provisioning | Not in Stage 1 | `docs/RUNBOOK.md` §7 |

## Not covered

- Other platforms: Node 24, Linux and Windows were not run in this build; CI is absent.
- Classifier accuracy, threshold calibration, latency and price of the live provider: not measured (telemetry exists, no live data).
- `npm audit`: 10 advisories (2 moderate, 8 high) in pinned dependencies:
  - runtime: `@nestjs/core`, `@nestjs/platform-express` (via `multer`, `path-to-regexp`), `@nestjs/common` (via `file-type`);
  - tooling: `prisma` (via `@prisma/config`: `effect`, `deepmerge-ts`).

  Versions stay pinned per `AGENTS.md`. An upgrade is a separate decision that a production deployment needs first.
