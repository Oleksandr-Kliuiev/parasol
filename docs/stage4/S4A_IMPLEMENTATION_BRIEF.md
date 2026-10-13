# S4-A implementation brief

## Authority, owner and stop

Owner request: implement S4-A after dual-approved S4-design-rc2, exact package
`d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`; seal
verification/stage4/S4_DESIGN_APPROVED.json. Native Claude Code claude-opus-5-5/high, normal speed, native Anthropic
subscription only, no API/usage credits/fallback. Codex transfers sole checkout write ownership on launch until you finish.
No other writer/subagent, commits, git resets/branches, PR, account/provider API, persistent/pilot DB, deployment or schedule.
Use disposable PG17 test DBs and generated unique roles only. Stop at S4-A; do not implement dependent B/C services.

Baseline: HEAD916a4d69853ff6da636e8609a2e0bd33aa787f66, branch planning/stage2-m365 plus substantial ACCEPTED dirty work.
Exact before-file hashes: verification/stage4/S4A_BASELINE.json (private copy /tmp/atlas-stage4/s4a-baseline.json).
Hash programmatically, do not print/read the full inventory. Root's setup contains this brief and IN_PROGRESS status.
Preserve every existing file except the explicit integration allowlist below. Never use HEAD diff as the checkpoint delta.
All20 installed migrations+lock,19 earlier normative files,8 Stage4 normative files, historical reviews/seals/ZIPs/fixtures
are immutable. No .env/private-pilot/secret/credential reads or printing. Private wrapper supplies test DB admin silently.

## Minimum reads and write scope

Explicitly read root AGENTS, docs/AI_CONTEXT_MAP and docs/DEVELOPMENT_WORKFLOW relevant delivery sections; safe mode may
skip automatic loading. Read docs/stage4/AGENTS, README,01–03, relevant04 invariants,05–06 and IMPLEMENTATION_HANDOFF.md.
The entire mandatory handoff (all eight reviewer clarifications, concrete choices and acceptance cases) is incorporated
into this brief by reference and MUST govern S4-A; future B/C requirements are preserved for later checkpoints.
Read prisma/AGENTS, tests/pg/AGENTS and packages/actions/AGENTS before touching their areas. Minimum source entry points:
actions/authority.ts; auth/{prisma-auth,authority,token}; graph/{runtime-role,fence-role,scope-context,scoped-db};
connections/connections; audit/sanitize; core/contracts; prisma/{schema,actions}.prisma and roles.sql;
tests/support/{pg-harness,roles-sql,migrations,pglite}; scripts/{pg17-check,schema-drift-check}. Query old migrations narrowly.

Allowed NEW files: cohesive packages/poweroffice modules/AGENTS, prisma/poweroffice.prisma and additive migrations,
focused tests/poweroffice-*.test.ts, tests/pg/poweroffice-*.pg.test.ts, small tests/support/poweroffice-* modules;
packages/auth/transaction-token.ts; optional focused graph role/routine modules to avoid oversized mixed-concern files.
Allowed existing integration: packages/actions/authority.ts (verbatim shared token extraction ONLY), packages/auth/* if
strictly required for that extraction, packages/graph runtime/readiness scope, packages/connections/connections.ts,
packages/audit/sanitize.ts, packages/core/contracts.ts only for additive permission/error vocabulary, Prisma model relation
fields, prisma/roles.sql; tests/support role/render/PG harness/PGlite/sql-invariant support, scripts PG17/drift check role
provisioning, existing role/schema/connection/action regression tests when necessary to reflect additive new schema/roles.
No loosening/removal of accepted assertions. Old upgrade fixture bytes remain fixed; adapt renderer compat deliberately.
Routing-only updates allowed in root/context-map, prisma/AGENTS, tests/pg/AGENTS, packages/actions/AGENTS if accurate.
No package versions/lockfile changes, generic context/AI/Gateway expansion or apps/API/ops/connector/source workflow yet.
Do not modify approved briefs/norms/status/reviews/evidence or declare acceptance; root integrates those after ownership returns.
If another source path is genuinely necessary, explain the dependency and pause that edit for root scope decision.

## Deliverable and critical invariants

1. Strict Atlas normalized page/header/invoice and aggregate DTOs, detached immutable validated values, fixed error codes;
   BigInt exact minor units, six currencies sorted/unique, positive invoice/credit magnitudes kept separate, Gregorian dates,
   IANA Europe/Oslo claim-fixed business date, all count/byte/page/money bounds and known-empty vs null. No real vendor DTO.
2. Verbatim shared currentToken + setLocal extraction, preserving exact ApiToken query/policy/grants/digest clearing and
   all Stage3 auth/expiry/fence/replay/conflict/denial semantics. No actor/token enumeration, credential DTO or definer helper.
   Add private bearer-based PowerOffice transaction authority foundation and one-membership all-of permissions, workspace
   denial auditing and fixed conflicts needed to verify A4; no public reads/sync/cleanup or source entry point. Final DB-clock
   token checks after all locks; proper scope before data. New permissions never assigned automatically.
3. Three scoped FORCE-RLS Prisma/SQL tables with approved complete later-checkpoint columns: State, Attempt, Snapshot;
   compound scope/version/asOf FKs; strict NULL truth, immutable identities and history, one ACTIVE, allocatedSnapshotId,
   bidirectional ACTIVE/pointer discoverability, sequence/latest/lastCompleted coherence, exact60/80s deadlines and24h expiry.
   SQL validates the SAME aggregate shape/order/bounds as TS via invoker trigger, no publicly callable validator.
   DEFERRABLE INITIALLY DEFERRED constraint triggers enforce commit invariants. Purged pointer null preserves lastSuccessAt;
   nonnull pointer implies lastSuccessAt equals its publishedAt. Direct owner/runtime SQL cannot forge protected history.
   DELETE guards enforce expiry/reference/terminal/30day rules under every deleting role. State itself is not deleted.
4. Runtime least privileges: SELECT three, INSERT three, only State operational and Attempt terminal UPDATE columns;
   no Snapshot UPDATE/DELETE/TRUNCATE, ownership/BYPASSRLS/ApiToken change. Exact startup/tamper checks. Two separate
   PowerOffice maintenance roles, exact owner table/locking grants, runner confinement, restrictive three-ID owner RLS
   intersected with usual scope policy, existing fence exactlyTWO policies unchanged and shared invoker list unchanged.
   Each new routine revokes PUBLIC EXECUTE in its migration BEFORE role provisioning; post-migration fence readiness passes.
5. SQL-side bounded cleanup routine belongs to the schema/role foundation in S4-A so its EXECUTE/grant/confinement
   contract is real and testable (A3). Implement approved validated GUC/argument scope and binding checks, fence/State
   protocol, ACTIVE BUSY, expired snapshots then unreferenced old attempts, combined1000rows/indexed bounded candidates,
   no clock/SQL/path/data arguments, atomic safe audit/pointer/delete and morePending. Test direct confined runner calls in
   explicit disposable fixture transactions. The user-facing fresh maintain admission, runner DB pairing, original whole
   transaction10s deadline/1s lock timeout wrapper and CLI remain S4-C; no claim those are implemented at this checkpoint.
   SQL routine uses fixed qualified relations/search_path and fixed safe errors, no auth/member/credential access.
6. Exact approved lock matrix: runtime fence SHARE for eventual reads / UPDATE for writes; Connection plain scoped SELECT,
   State SHARE/UPDATE per operation, runtime Attempt UPDATE lock, snapshots plain protected reads; cleanup no Attempt/
   Snapshot explicit row locks, DELETE's implicit locks after fence/State. No Connection locking UPDATE grant added.
   FK key-share locks may still conflict with owner auth/Connection mutation; fixed conflict and zero partial effects;
   no automatic admission retry. No I/O under locks or new actual fence UPDATE. Future publication max3 same-fact known
   rollback retries only; no implementation of publication/source/recovery workflows here.
7. Generic Stage1 resolveConnection/resolveCredential refuses PowerOffice before invoking any secret resolver. Bindable
   system allowlist unchanged; no vendor credentials, seed/onboard/bind/activate command. Synthetic FIXTURE seeding is
   private trusted test support only. PowerOffice not accessible through generic context/Decision/AI/Gateway.
8. Add exact audit keys additively, with a local PowerOffice metadata factory enforcing six-key domain allowlist and no
   counts/amounts/source IDs/dates/raw details. Operational sequence only; JSON outcome distinct from security outcome.
   Do not widen existing audit flows or copy financial objects into generic AtlasError.details/logs.

## Acceptance and evidence

Meaningful A1–A4 + R1/R2 tests: TS/SQL adversarial invalid shapes/types/Unicode/dates/scale/money/max sums, detach-mutation,
empty/total/order/kind/currency; owner/runtime scoped FKs, nullable tuples, identities/state transitions, orphan ACTIVE and
wrong owned snapshot COMMIT failures; partial publication/audit rollback; pointer cleared after expiry retaining success.
Blank/foreign workspace/client AND same-client foreign-connection definer RLS; policies restrictive flags; forbidden
writes/column grants/routine calls; every explicit lock under real confined grants; non-superuser migration-owner path.
Post-migration pre-provisioning fence readiness/no PUBLIC routines, role provisioning repeat, malicious grant/policy/ACL
readiness tamper. Permission CHECK vocabulary survives upgrade without auto membership assignment. Disposable accepted
20migration populated DB → new migrations/roles with accepted data/fences/grants preserved. Actual PostgreSQL for locks,
constraints/RLS; no fake throw-only substitute. Existing tests should still pass, including Stage3 last-lock expiry.

Run focused checks during work. At final checkpoint source run ONCE /tmp/atlas-stage4/s4a-tools/checks.sh rc1
(npm test, schema:validate, db:generate, typecheck, api:build, api:smoke, test:pg, db:check:pg17, db:check:drift,
git diff --check, untracked whitespace). Fix then rerun affected failures and final suite only if actual source changes
justify it; preserve failed logs. PG commands use /tmp/atlas-stage3/claude-tools/pgenv.sh, NEVER cat/echo its contents,
credentials/env/URLs or use against persistent DB. Keep tests split by behaviour, focused support, source/test files near500
lines, hard700. Do not write code-mirroring tests or broaden scope to future B/C acceptance.

Report final changed paths, implemented invariants, exact checks with passed/failed counts/log dirs, residual/deferred scope
and any meaningful environment/contract diagnosis. Root captures hashes/package and submits actual source/evidence to fresh
explicit Astra/xhigh; your report is not acceptance. After two ineffective repairs diagnose/escalate; no blind retries.
Stop after S4-A evidence, preserve dirty baseline and keep the same session for related review fixes.
