# Copy this into Codex Desktop or Claude Desktop

Implement Vardahei Atlas Stage 1 Foundation using this development pack. Work in the open project folder. First read AGENTS.md, docs/01_STAGE_1_SPEC.md and docs/05_IMPLEMENTATION_PLAN.md. Read detailed documents only when needed by the current task. Do not redesign the entire product or build UI.

If this is an existing Atlas repo, inspect its instructions and implementation, create a branch, and map the pack to existing conventions. Preserve data/features; do not overwrite the repository with a template.

Start with tasks 1.1, 1.2 and 1.3. The first deliverable is a PostgreSQL-backed synthetic Gasta → Kari → GASTA-LT-07 graph with confirmed Atera and Huntress mappings and a scoped getClientContext query/API. The fixture-only CLI/API in this pack is a reference, not completion of that task.

Use Node 24+, PostgreSQL 17, Prisma 6.19.0 and NestJS 11.1.6 as the pinned baseline. Run npm ci, Prisma validation/generation, relevant tests, typecheck, API build and `npm run db:check:pg17` against a real PostgreSQL 17. Apply all three migrations (foundation, v1_1_contracts, v1_1_2_conflict_scope_and_legacy_guard), create the runtime role from prisma/roles.sql and connect the application through it; never as the owner. Test migration/seed/queries against PostgreSQL before claiming the DB-backed checkpoint complete. PGlite tests verify SQL invariants and RLS policies but do not replace Prisma/PostgreSQL integration.

Treat the v1.1 contracts as the baseline (see CHANGELOG.md and AGENTS.md): per-client memberships, ClientContextV1 with explicit resource statuses, resourceType in event identity and links, reasonCodes[] and priority, conflict/retry/dead-letter instead of lost events, allowlisted client audit plus workspace security audit, configured model with MODEL_MISMATCH, applied vs shadow DecisionRuns.

Enforce authenticated actor/workspace/client/connection scope. No write tools. No vendor credentials in DB except secret references, prompts or reports. Atera/Huntress normalizers are synthetic Atlas DTOs; validate vendor contracts before writing live adapters. Do all fixture/mock work that does not need credentials first.

Preserve the Decisions boundary: provider-neutral advisory routing, compact redacted input, source urgency floor, refusal/timeout/invalid-output fallback, shadow mode first. Decisions never grants permissions. Do not introduce expensive Responses/Agents orchestration in Stage 1.

At Checkpoint A after 1.3, write CHECKPOINT_REPORT.md using prompts/CHECKPOINT_REPORT.md. Include changes, actual verification, remaining work and the next task. Continue routine implementation without permission prompts. Stop for review at this concrete checkpoint; do not proceed to live account setup or deployment unless separately instructed.
