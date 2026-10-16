# S3-A implementation handoff

Architecture: S3-design-rc4, exact eight-file package e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c.
Dual independent architecture approvals and hashes: verification/stage3/S3_DESIGN_APPROVED.json. No code acceptance implied.
This brief applies the approved scope and Fable implementation precisions; eight normative snapshot files remain frozen.

## Writer and stopping checkpoint

Native Claude Opus5.5 (claude-opus-5-5), high, native Anthropic subscription only. One writer owns checkout from explicit
Codex handoff until session finishes; no parallel writers, commits, branch changes, PR, deployment or account work.
Codex supplies an exact private baseline manifest, preserves dirty Stage2 work and reviews actual integration after handoff.
Stop at S3-A after required evidence. No S3-B approval/reservation services or S3-C create/verify/operator execution yet.
Do not implement vendor adapters, call business providers or migrate/provision current or pilot DB. Test disposable DBs only.

## Scope and entry files

Read docs/stage3/AGENTS, 01–03, 05–06 and relevant 02/04 invariants; minimal docs/AI_CONTEXT_MAP and workflow routing.
Entry source: prisma/AGENTS, schema.prisma auth/Connection models, roles.sql; graph/{runtime-role,scope-context,scoped-db};
auth/{prisma-auth,authority}; core/contracts; tests/sql-invariants identity section; tests/support/{roles-sql,pg-harness,pglite};
tests/pg/AGENTS. Hash large baseline lists programmatically; do not load history/logs/vendor datasets wholesale.

Implement cohesive packages/actions contracts/canonical/private-file/policy/authority/request modules, actions.prisma and
new additive migrations. New action models include approved later-stage columns/constraints, immutability/scoped FKs/FORCE
RLS and exact runtime grants; future behavior stays inaccessible. COMPLETE workspace fence role/function/initialization/
auth+Connection triggers/provisioning/readiness, signing token ROW ID+expiry snapshot and epoch proof ship before requests.
Preserve accepted ApiToken policies/grants: no signer token enumeration/view/function/hash storage. Extend permissions CHECK
with all four actions grants. Implement protected preview/request/idempotency and safe summaries, no public bodies/refs/IDs.
Context map + focused area AGENTS + workflow routing updated at this first code checkpoint, with explicit integration delta.

## Implementation precisions

- Pending request has no additional TTL: with a non-expiring original token and unchanged authority epoch it may remain
  approvable indefinitely. Authority/binding/version loss invalidates; natural token expiry expires; approved TTL stays15min
  capped by both immutable signer expiry snapshots. Idempotent retrieval never renews any signing evidence.
- BEFORE TRUNCATE statement refusal on Actor/ClientMembership/ApiToken/Connection, plus the approved fence guards. No
  owner mutation can bypass epoch through bulk erasure. Startup checks all enabled mutation/statement/self-guard and Workspace
  identity-move/insert/delete triggers. Normal owner seed is the supported owner DML, tested under healthy fencing.
- Runtime fence RLS supports SELECT and UPDATE USING/WITH CHECK exact workspace (or equivalent FOR ALL); FOR UPDATE returns
  exactly1 row. Runtime grants UPDATE(workspaceId) only, and self-guard rejects actual no-op UPDATE/version changes.
- Transaction-scoped action authentication preserves the accepted bearer-hash protocol and GUC cleanup, repeating auth after
  fence lock. Clear token hash before ordinary/signer reads; current Actor comes from verified bearer, never caller input.
- Validate raw Unicode scalars/forbidden categories, NFC/trim, then cheap revalidation and final stored scalar limits.
- Grow roles-sql test renderer to exactly4 distinct validated role names and existing exact password placeholder counts;
  update helper callers deliberately, do not loosen its shape guard. Referenced tokens revoke/replace, retained rows cannot delete.
- S3-A adjacent integration includes exact safe fence-error mapping and healthy/incomplete-fence regression cases for bind,
  Stage1 activation, M365 activation, m365-disable and owner seed; RUNBOOK states emergency-disable fence-health dependency
  and separately reviewed offline repair only. Preserve all original authorization and read/Gateway contracts.
- FORCE action-row observation uses confined scoped runtime; blank runtime sees zero. Global completeness uses trusted
  provisioning owner/definer count only. No unscoped nonsuperuser owner reads of action content.

## Evidence and delivery

Focused meaningful A1–A6 tests plus appropriate authority/compatibility checks, including non-superuser roles, missing fence,
wrong/blank GUC/temp shadow, invalid/default grants, owner mutation/remove-restore/natural expiry after locks, TRUNCATE refusals,
immutable direct-SQL fields, collisions and concurrent idempotent requests, private files/Unicode/canaries and audit rollback.
Do not write tests mirroring implementation. Keep active files around500, hard700; extract cohesive boundaries first.
Then run npm test, schema:validate, db:generate, typecheck, api:build, api:smoke, test:pg, db:check:pg17, db:check:drift and
 git diff --check. PG checks use own throwaway DBs, no current DB deploy/seed. Do not print .env, credentials, DB URLs or private
pilot configuration. Do not update any frozen migration, Stage1 accepted report, Stage2 normative11 or frozen Stage3 docs8.

Deliver concise changed paths/behavior, exact baseline+current hashes, commands/exit codes/test counts, safe evidence, risks,
model/effort/session and writer handoff. Any required architecture/public-contract/invariant change is a stopping issue,
not an implicit amendment. Actual independent Astra/xhigh checkpoint acceptance is required before dependent S3-B work.
