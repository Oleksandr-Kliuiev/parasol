# S2-C implementation brief RC1

Date: 2026-10-08. Scope: tasks 2.7–2.10, checkpoint S2-C. Implementation-detail review under the unchanged Stage 2 RC5 contracts.
This document is frozen before independent initial reviews. It contains no reviewer verdict.

## Identity and authority

- Accepted baseline: S2-B-rc4, package SHA-256 `d122f0ea4031ce3421c114c286d409b974d83449d8db6f3930b53884486eb841`, 269 files.
- Baseline manifest: `verification/stage2/S2B_RC4_MANIFEST.json`; all entries verified before preparation.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`; preserve all dirty work.
- Normative RC5 package: `docs/stage2/REVIEW_MANIFEST.json`, SHA-256 `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`.
- Read `docs/AI_CONTEXT_MAP.md`, root AGENTS.md, `docs/DEVELOPMENT_WORKFLOW.md`, and relevant nested AGENTS.md.
- Contracts: `02_CONTRACTS.md` §§1,3–6; sync/status/operations: `03_CONNECTOR_SYNC.md` §§3,6–7;
  tasks: `04_IMPLEMENTATION_PLAN.md` 2.7–2.10; acceptance: `05_ACCEPTANCE.md` C1–C6 including lettered cases.
- All existing migrations and `REVIEW_REPORT.md` are frozen. Any necessary SQL change must be additive in a new migration.
- No live tenant access, deployment, account changes, vendor writes, provider input expansion, UI or new automation.

## Module boundaries and ownership

Codex owns preparation, integration and evidence. One native Claude Code implementation session owns checkout writes
after BOTH reviewers approve the same current brief hash. Opus 5.5/high is assigned to this cohesive concern because
identity resolution, authorization, repeatable snapshots, cursor integrity and maintenance authority are interdependent.
No parallel writers. Codex regains write ownership only after the CLI process ends. Reviewers are read-only.

Keep source/tests near 500 lines and below 700. Thin controllers/commands call shared domain services.
Suggested cohesive modules (adjust names without changing boundaries):

- `packages/correlation/{resolve,query,snapshot,coverage,cursor,parameters}.ts`: pure resolution, snapshot read,
  interval coverage, authenticated keyset pagination and strict input parsing; existing contracts.ts remains public authority.
- `packages/m365/{reads,retention,maintenance-role}.ts`: gated directory/sign-in/status projections and confined cleanup.
- `packages/tools/{m365,composed-registry}.ts`: two definitions and one immutable composed registry;
  focused DB/fixture readers supply services without coupling Decisions to M365 data.
- `apps/api/src/db/correlations.ts`: separate read controller/module; existing tools controller gets the same composed registry.
- `packages/ops/m365.ts` may split into read/sync/maintenance command modules; scripts/ops.ts stays composition only.
- Focused tests by resolution, negatives, provenance, paging, read surfaces, retention and the synthetic journey;
  small synthetic shared fixtures under tests/support. Update context map/routing and RUNBOOK.

## Read transaction and current authority

Every DB read uses Prisma RepeatableRead with parameterized SET LOCAL scope as its first statement, exactly one
actor-derived client, then current ACTIVE actor/membership all-of permission check inside that same snapshot.
Do not rely on the authentication-time Actor alone. Correlation/directory/sign-in require context:read + m365:read;
status/probe require connections:manage and return only counts/statuses/capability/safe codes.
Selected M365 connection must be ACTIVE, bound, same scope, microsoft365, and not DB_FIXTURE in DB operation.
Reads perform no credential resolution, token request or upstream I/O. Disabled historical Huntress evidence may
be read with SOURCE_CONNECTION_DISABLED. Ordinary M365 reads fail after disable/revoke; cleanup remains permitted.
Use the existing workspace SecurityAuditEvent denial convention with empty or expressly allowlisted metadata;
do not create a client audit for inaccessible scope. Client correlation.read contains only local IDs/counts/codes/version.

Read observation, scoped RawEvent, connection states, current links, active unexpired directory membership,
published window attempts and memberships in one consistent snapshot. Never query staging as readable data.
Query-time expiry is authoritative even when cleanup has never run. Read database clock for eligibility.
Recheck current authority on every page before exposing data. A request that starts after a committed revoke must fail.

## Deterministic resolution and proof

Resolve observation through scoped event FK and validated Huntress normalized.externalDevice agent reference.
Missing/invalid reference is UNRESOLVED with the corresponding code; historical Observation.entityId is never a fallback.
Use current confirmed Huntress mapping to DEVICE, then current confirmed selected-connection m365_device mapping.
Only active retained generation members qualify. Multiple current mappings or duplicate directory deviceId are AMBIGUOUS.
Compare sign-in deviceDetail.deviceId to directory device.deviceId, never directory device.id or names.
Resolve sign-in userId exactly to directory user.id and its current confirmed PERSON link. Guest IDs are tenant-local.
Independently resolve DEVICE.personId's confirmed selected-connection M365 user mapping for ASSIGNED_PERSON_ACTIVITY;
missing/different device reference remains person activity. Multiple mappings make that path ambiguous.
Deduplicate evidence ID/hash across memberships; merge relation codes/proofs when the same evidence matches both routes.
Retained conflicting content hashes for one sourceId are returned as CONFLICTED without silently preferring a version.
Do not use a conflicted sign-in as uncontested canonical-person attribution; preserve both immutable provenance chains.
Rejected/quarantined/unconfirmed links never resolve. Existing confirmed membership may resolve at 61m with
DIRECTORY_STALE; at completedAt+24h it is hidden/UNRESOLVED/DIRECTORY_EXPIRED. New confirmations still require freshness.
Proof includes relation, vendor FIELD NAME, source evidence ID/hash, link IDs/statuses, generation IDs, rule version.
Keep source eventKey/severity/priority/route and observation/triage unchanged. No all-clear, confidence or causation claim.

## Coverage, projection and pagination

Only each root's currently published immutable attempt contributes, clipped to query and current retention.
Coverage union produces COMPLETE/PARTIAL/UNAVAILABLE and exact uncovered intervals independently of freshness.
traversalComplete is exactly COMPLETE. A full historical traversal older than 15m remains COMPLETE with STALE.
A newer pending/failed refresh marks its retained portion STALE without replacing its original retrieval time.
No coverage => items=null; COMPLETE with zero matches => []; PARTIAL includes available items and real gaps.
Use full seven-digit UTC precision for half-open bounds and ordering; do not silently truncate boundaries to JS milliseconds.
Filter evidence expiry before matching/counting; include retained conflicting versions relevant to selected published data
without inventing a new retrieval time for older membership. Do not narrow still-retained coverage already guaranteed by S2-B.
Sort occurredAt DESC, sourceId ASC, contentHash ASC; total is the matching deduplicated snapshot count, pages are keyset.
Explicit DTO projections only; authorized directory reads may return approved directory DTOs, sign-in list only approved
sign-in DTOs plus the resource/coverage envelope; correlation returns its narrower contract. No free-text/vendor extras.

Cursor is versioned base64url claims + HMAC-SHA256, timing-safe verification and strict bounded decoding.
Resolve a shared configured key from `ATLAS_CORRELATION_CURSOR_SECRET_REF=env://NAME`; fail closed when absent/invalid,
never random per-process default. Do not include secrets/identity DTOs in claims. Bind actor/workspace/client, permission
evaluation, observation when present, connection, interval, limit/filters, last key and snapshot fingerprint.
Fingerprint includes current links (including source mapping), relevant directory pointers/membership, connection lifecycle,
published pointers AND latest attempt states/sequences. Claimed fingerprint/expiry is trusted only after MAC verification.
Every page reloads current snapshot/authority and validates claims; input/fingerprint mismatch => 409 CORRELATION_CHANGED.
Lifetime <=15m, bounded also by earliest FUTURE directory/sign-in freshness or retention transition and relevant evidence
expiry. Already stale data may issue a useful cursor. Reevaluate clock each page even with unchanged pointers.
Expired/tampered/malformed cursor fails safely, never logs contents; canonical errors documented consistently across surfaces.

## API, tools, fixtures and operator surfaces

Endpoint exactly GET /clients/:clientId/observations/:observationId/correlation, required connectionId/from/to,
optional limit=1..100 (default50), cursor. Reject unknown/repeated/non-scalar query keys, tenant overrides, from>=to,
duration>24h, future end or interval outside seven-day retention. Same validation service for tools/CLI.
Observation must be Huntress and within scope; safe not-found/validation only. No implicit sync/widening.
New tools: atlas.observation.get_correlation and microsoft365.signin.list, risk0/NONE, both read permissions.
Inject ONE composed registry into discovery, toolsAvailableTo, decideToolCall and executeTool for DB and fixture API.
Preserve exact Stage1 public tool descriptions and ClientContextV1/gateway outputs; new descriptions expose permissions[].
Tool ledger STARTED/SUCCEEDED/FAILED and audit remain persisted through existing gateway, including service refusals.
M365 outputs never enter Decisions/provider input. Fixture mode uses explicit synthetic readers or honest UNAVAILABLE
envelopes; it must not invent complete empty data. Extend reader interfaces without breaking legacy service consumers.

CLI planned commands: m365-probe, m365-sync (users|devices|signins), m365-status, m365-requeue,
m365-directory, correlation, m365-cleanup; retain m365-disable. Expose existing directory retry reset explicitly if needed.
Probe/activation/sync/requeue call S2-B services and their current authority checks; no duplicate transport/auth workflows.
Sync/requeue require events:ingest + connections:manage; probe/status require connections:manage.
Directory/correlation require both read permissions; exact declared flags and safe validation. Sync status output contains
counts/local IDs/codes only; read DTOs go to authorized stdout, never persisted logs. Cursor flag may need its own bounded
size policy above the legacy 256-byte flag limit; do not relax unrelated flags. Derived m365-status request outcomes come
from root jobs; immutable M365SyncRequest.state OPEN alone must not imply pending/completed work.
Directory reads must be bounded/paged and hide expired DTOs; bind page identity to current generation and authority.

## Maintenance service and bounded execution

Authenticate operator against ordinary runtime DB and recheck events:ingest + connections:manage before establishing
one-client transaction context on a separate configured cleanup-runner connection. Runner is EXECUTE-only;
no direct table reads/DML, no SET ROLE to definer, no public routine execute. Verify confinement/owner/grants before use.
Resolve runner URL lazily from an operator env reference, never required by ordinary read API, never reuse owner credentials.
Service calls existing atlas_m365_cleanup(correlationId) under verified SET LOCAL workspace/client/actor. No caller time,
ID list, connection filter or deletion predicate. Restrict bounded execution using transaction/statement timeout (30s)
and lock timeout (5s); whole pass rolls back on timeout. This is a time bound, not a claim of row-batched cleanup.
Retain existing atomic pointer withdrawal + expired payload deletion + allowlisted audit and common Connection-first
lock order. Scope RLS and DB expiry remain enforced for direct EXECUTE. Disabled connections are eligible for cleanup.
No Stage1/audit/mapping deletion, no Connection binding/status/version mutation, no timestamp freshness laundering.
RUNBOOK documents migrate FIRST, role provisioning SECOND, confinement checks BEFORE runtime; separate runner secret
configuration, timeout/retry behavior, read expiry even on cleanup failure, retained stale states, and operator-only refresh.
If implementation exposes a necessary invariant change, stop and request a reviewed amendment rather than bypassing gates.

## Checks and stopping checkpoint

Focused PostgreSQL tests use confined runtime and real separate EXECUTE-only runner, unique roles and synthetic tenants.
Cover C1,C2,C2a,C2b,C3,C4,C4a,C4b,C5,C5a,C5b,C6 and Stage1/S2-A/S2-B regressions, including:
ID-vs-deviceId, duplicate IDs, guests, absent/invalid source, reconfirm/reject/reappearance, stale/expired membership,
separate person route, conflicting versions, exact sub-ms bounds, gap vs stale, zero vs missing capability;
cursor tampering/input/publication/mapping/attempt change, actor revoke, freshness/expiry between pages;
both/single/split-client permissions across HTTP/CLI/tools/fixture, same composed registry and persisted ledger outcomes;
privacy canaries absent from DB projections/audit/errors/logs/provider; cleanup rollback, connection lock contention,
fresh publication race, disabled scope, role prohibitions and no Stage1 changes; actual CLI/API/tools synthetic Gasta journey.
Use local mock Graph token POST and fixed allowed Graph GET endpoints; capture no vendor writes and no real credentials.

Required final commands: npm test; npm run schema:validate; npm run db:generate; npm run typecheck;
npm run api:build; npm run api:smoke; npm run test:pg; npm run db:check:pg17; npm run db:check:drift; git diff --check.
Record exact commands/exits/counts (zero skip for required behavior), synthetic dated receipts and payload/log hashes.
Do not repeatedly rerun unchanged passing full suites. Keep independent review evidence and provider metadata separate.
Stop implementation at reviewable S2-C candidate. Fresh Astra gpt-6-astra/xhigh must accept actual frozen code/evidence;
implementer report is not acceptance. Codex verifies exact accepted hashes before marking completion. LIVE remains pending.
