# Stage 2 — implementation plan

Implementation starts after S2-ARCH acceptance of the current manifest by both reviewers.
This document specifies future work; none of its tasks is completed by writing this pack.

| Task | Result / smallest entry points | Verification | Depends on |
|---|---|---|---|
| 2.1 Baseline and focused contracts | Read AI_CONTEXT_MAP; record code/review baseline; add packages/correlation/contracts.ts and M365 DTO schemas without changing V1 output | Strict DTO/unknown/null/size tests; Stage 1 output regression | S2-ARCH |
| 2.2 Persistence and grants | New database-local migrations for M365 tables, m365:read, typed links and routines; extend PROTECTED_TABLES; provision runtime/definer/runner through roles.sql and update unique-role test rendering/teardown; preserve old migrations | Prisma validate/generate, real PostgreSQL migrate/runtime queries, RLS/FK/role tests, repeated disposable databases, zero drift, PGlite | 2.1 |
| 2.3 Permission and compatibility boundary | Filter old context/mapping paths; extend mapping services; migrate internal ToolDefinition/policy to all-of with legacy projection; implement scoped m365-disable service/CLI with lifecycle fence and explicit audit keys | Single permission/split-client denial; both on same client allowed; fixture + DB; CLI bypass probes; disable increments version and audits atomically, including already-DISABLED | 2.2 |
| **S2-A** | Contracts/schema/auth accepted | Evidence A1–A4, R1/R2 below | 2.3 |
| 2.4 Token and Graph adapters | connectors/microsoft365/auth.ts, http.ts, contract.ts, connector.ts; add microsoft365 to BINDABLE_SYSTEMS and composition; versioned one-use activation, disable cache invalidation, fixed authorities, per-token tenant check | Mock token/Graph requests; disable during probe, stale cache/version, wrong tenant, malicious nextLink/redirect, expiry, scopes, 403/429 | S2-A |
| 2.5 Directory generations | packages/m365/directory.ts; durable staging, atomic publication, active external mappings | Full/empty/malformed/partial/oversized reads, first-read race, disappearing object, revoke during I/O | 2.4 |
| 2.6 Sign-in windows | packages/m365/windows.ts + ingest.ts; durable claims, versions, bounded splitting, gaps/retry | Two workers, crash every boundary, same timestamp, duplicate/conflicting ID, cap, 429 delay, restart | 2.4 |
| **S2-B** | Mock/recorded connectors and recovery accepted | Evidence B1–B6 | 2.5, 2.6 |
| 2.7 Deterministic correlation | packages/correlation/resolve.ts + query.ts; separate device/person relations, snapshot-bound paging | Exact-ID positives; negative matching, stale/rejected links, guest, missing device, changed mapping/cursor | S2-B |
| 2.8 Read API/tools/CLI | Separate correlation endpoint; two read tools; inject same composed registry into discovery/policy/executeTool; focused operator module, strict schemas | HTTP/CLI authorization, response redaction, read-only policy, ledger success/failure | 2.7 |
| 2.9 Retention and operational instructions | Expiry in queries; confined routine and bounded cleanup; explicit audit allowlist; document migrate-then-role provisioning, operator-only refresh and directory limits in RUNBOOK | Cleanup crash/retry/FK/role tests; no audit deletion; expired identity invisible, stale retained identity explicitly labelled | 2.8 |
| 2.10 Acceptance and handoff | Full synthetic journey, dated evidence and clear live status; maintain context map | Full local required suite + acceptance matrix; independent S2-C review | 2.9 |
| **S2-C** | Engineering implementation accepted | Evidence C1–C6 + regressions; no obligatory findings | 2.10 |
| **S2-LIVE** | Tenant-bound real reads and one verified correlation | Account authorization, permissions, license/capability, existing Stage 1 live evidence, L1–L4 | S2-C + account prerequisites |

## Checkpoint report

For each gate record exact commit, dirty files if any, schema delta, commands/results, new tests,
findings with severity and reproduction, supported environments, remaining live gates and next task.
New report: `docs/stage2/IMPLEMENTATION_STATUS.md` (created during implementation), with evidence files routed
under `verification/stage2/`. Do not overwrite Stage 1 independent review or reuse its test counts as new results.
Do not commit credentials, live UPNs, tokens, tenant IDs or response bodies into reports.

## Required checks once implementation changes code/schema

Use existing package scripts and throwaway PostgreSQL harness; no persistent tenant database for tests.

```text
npm run schema:validate
npm run db:generate
npm run typecheck
npm test
npm run api:build
npm run api:smoke
npm run test:pg
npm run db:check:pg17
npm run db:check:drift
git diff --check
```

PostgreSQL scripts need ATLAS_PG_ADMIN_URL; provide through the established local test setup, not a committed secret.
Run test:pg twice on the same cluster at S2-A to verify role isolation/teardown; db:check:drift shadow migrations
and npm test PGlite migrations must work without pre-created runtime roles. Role provisioning is a separate post-migrate step.
Align pg17-check.ts and PGlite grant setup with production confinement; do not grant wider test-only privileges.
Verify fresh-role provisioning and upgrade with existing roles; render each role name uniquely without prefix collisions.
Add new tests to existing npm test/test:pg globs. Update explicit SQL constraint/role checks to include new tables.
Tests are split by behavior (auth, generations, windows, recovery, correlation, retention), shared synthetic fixtures
in small support modules. No active file exceeds 700 lines. Run focused tests during changes and full required gates
at checkpoint; repeat only when changes/failures justify it.

## Known Stage 1 limitations to carry forward

Live Atera/Huntress/Decisions not run; scheduler/long-lived worker, lease renewal, vault/provisioning,
retention of old RawEvent, production auth and dependency findings remain tracked in CHECKPOINT_REPORT.
Stage 2's bounded M365 jobs/maintenance role do not silently claim to fix those older limitations.
An independent review of this plan is not an approval of frozen code, dependencies or deployment.
