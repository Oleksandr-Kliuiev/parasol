# S2-C implementation brief RC3

Date: 2026-10-08. Scope: tasks 2.7–2.10, checkpoint S2-C. Implementation-detail review under the unchanged Stage 2 RC5 contracts.
This document is frozen before independent reviews. It contains no reviewer verdict. RC3 freezes selection/vocabulary/read envelopes and subprocess mock mechanics as well as target binding, assignment fingerprint, operation states and CLI recovery contracts.

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

Every ordinary stored-data DB read uses Prisma RepeatableRead with parameterized SET LOCAL scope as its first statement, exactly one
actor-derived client, then current ACTIVE actor/membership all-of permission check inside that same snapshot.
Do not rely on the authentication-time Actor alone. Correlation/directory/sign-in require context:read + m365:read;
status requires connections:manage and returns only counts/statuses/capability/safe codes.
Correlation/directory/sign-in reads require the selected M365 connection ACTIVE, bound, same scope, microsoft365,
and not DB_FIXTURE in DB operation. Status may read bound ACTIVE or DISABLED connections, with no identity DTOs.
Stored-data reads perform no credential resolution, token request or upstream I/O; operator probe/activation is separate. Disabled historical Huntress evidence may
be read with SOURCE_CONNECTION_DISABLED. Ordinary M365 reads fail after disable/revoke; cleanup remains permitted.
Use the existing workspace SecurityAuditEvent denial convention with empty or expressly allowlisted metadata;
use an all-of AccessPolicy helper or shared domain guard that records exactly one workspace denial;
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
Item selection is EXACTLY the union of two routes over unexpired selected published evidence within [from,to):
(a) deviceId equals the one current directory device.deviceId, only when device path RESOLVED;
(b) userId equals the one current directory user.sourceObjectId confirmed for Device.personId, only when assigned-person
path RESOLVED. SIGNIN_USER_REFERENCE and canonicalPersonId annotate selected rows; they NEVER add a third selection route.
Global resolution.device describes route(a); resolution.person describes assigned-person route(b). The canonical Huntress
DEVICE may enable route(b) even when route(a)'s M365 device mapping is absent; missing/invalid source DEVICE prevents both.
With coverage present but neither selection path RESOLVED, items=[], total0 (coverage still truthfully COMPLETE/PARTIAL).
A PERSON-linked unrelated user's activity is never selected merely because it has a confirmed link.
Deduplicate evidence ID/hash across memberships; merge relation codes/proofs when the same evidence matches both routes.
For a selected item, another unexpired version of the same selected connection/sourceId marks it CONFLICTED only if
that version has membership in a previously PUBLISHED attempt (publishedAt non-null, state COMPLETE or SUPERSEDED).
Staged-only or superseded-before-publication versions cannot create visible conflicts. Return selected published items
only; historical versions affect their conflict flag, not item count/total and not current coverage. No separate historical
items/proof enrichment in this slice: if introduced later it must preserve its own original retrieval time, never borrow
selected attempt freshness. Multiple selected versions are each CONFLICTED, neither silently preferred.
Do not use a conflicted sign-in as uncontested canonical-person attribution; preserve both immutable provenance chains.
Rejected/quarantined/unconfirmed links never resolve. Existing confirmed membership may resolve at 61m with
DIRECTORY_STALE; at the generation row expiresAt (bounded by completedAt+24h) it is hidden/UNRESOLVED/DIRECTORY_EXPIRED. New confirmations still require freshness.
Proof includes relation, vendor FIELD NAME, source evidence ID/hash, link IDs/statuses, generation IDs, rule version.
Keep source eventKey/severity/priority/route and observation/triage unchanged. No all-clear, confidence or causation claim.

Explicitly authorize ONLY this additive CorrelationReasonCode extension in contracts.ts, retaining all existing six codes,
CorrelationContextV1 fields/version and legacy ClientContextV1 unchanged. Use fixed vocabulary, sorted/deduplicated;
no raw vendor/actor values. Freeze codes and conditions:

| New code | Condition |
|---|---|
| SOURCE_DEVICE_MAPPING_MISSING | Valid source agent reference has no current confirmed Huntress DEVICE link, including absent mirror/candidate/rejected/quarantined. |
| SOURCE_DEVICE_MAPPING_AMBIGUOUS | More than one eligible current source DEVICE mapping; fail closed. |
| M365_DEVICE_MAPPING_MISSING | Resolved source DEVICE has no selected-connection confirmed M365 device link. |
| M365_DEVICE_MAPPING_AMBIGUOUS | More than one selected-connection confirmed device mapping. |
| DIRECTORY_MISSING | Needed directory resource has no usable active generation/pointer; DIRECTORY_EXPIRED remains distinct. |
| M365_DEVICE_REFERENCE_MISSING | Eligible mapped directory device has null deviceId. |
| M365_DEVICE_REFERENCE_AMBIGUOUS | That deviceId occurs on multiple current directory devices; never choose one. |
| ASSIGNED_PERSON_MISSING | Resolved source DEVICE exists with personId=null; do not assert absence if source DEVICE is unresolved. |
| ASSIGNED_PERSON_MAPPING_MISSING | Assigned person exists without a confirmed selected-connection M365 user mapping. |
| ASSIGNED_PERSON_MAPPING_AMBIGUOUS | Multiple confirmed selected-connection M365 user mappings for assigned person. |

Existing SOURCE_DEVICE_REFERENCE_MISSING/INVALID, SOURCE_CONNECTION_DISABLED and DIRECTORY_STALE/EXPIRED/
OBJECT_NOT_CURRENT keep their exact meaning. Missing annotation-only sign-in-user references/links suppress
SIGNIN_USER_REFERENCE/canonicalPersonId; global assigned-person resolution remains independent. CONFLICTED rows suppress
canonicalPersonId and uncontested SIGNIN_USER_REFERENCE attribution, retain selected reported relation/proof with explicit
CONFLICTED flag; no canonical identity is chosen from contradictory evidence. Report the exact additive code delta.
Clarify the existing items type comment: null iff UNAVAILABLE; [] is zero matching available evidence and is not an all-clear
claim for unresolved/PARTIAL data. Only COMPLETE establishes complete traversal, still without a safety verdict.

## Coverage, projection and pagination

Only each root's currently published immutable attempt contributes, clipped to query and current retention.
Coverage union produces COMPLETE/PARTIAL/UNAVAILABLE and exact uncovered intervals independently of freshness.
traversalComplete is exactly COMPLETE. A full historical traversal older than 15m remains COMPLETE with STALE.
A newer pending/failed refresh marks its retained portion STALE without replacing its original retrieval time.
No coverage => items=null; COMPLETE with zero matches => []; PARTIAL includes available items and real gaps.
Read from/to accept strict UTC instants with 0..7 fractional digits. Derive a single fixed-width key
`YYYY-MM-DDTHH:mm:ss.fffffffZ` by padding the preserved validated DTO fractional text with zeros to seven digits.
Use this SAME key for exact half-open filtering, matching/count, occurredAt order and cursor position. SQL ORDER BY and
keyset predicates use the equivalent expression over allowlisted DTO.createdDateTime, never TIMESTAMP(3) alone;
a coarse indexed occurredAt prefilter must widen to include all candidate milliseconds before the exact predicate.
Convert millisecond directory/root/attempt/retention bounds to the same fixed-width representation when clipping.
Output approved canonical DTO time unchanged; do not lexically compare variable-width fractions or truncate input.
Tests include two instants within one millisecond with differing sourceId order, exact from/to cuts through that millisecond,
complete total vs pages, both 1-digit and 7-digit canonical fractions. Sync creation remains S2-B millisecond Date bounds;
reject sub-ms sync-create arguments explicitly, never silently truncate them.
Filter evidence expiry before matching/counting; include retained conflicting versions relevant to selected published data
without inventing a new retrieval time for older membership; historical conflict-only membership never adds coverage. Do not narrow still-retained coverage already guaranteed by S2-B.
Sort occurredAt DESC, sourceId ASC, contentHash ASC; total is the matching deduplicated snapshot count, pages are keyset.
Explicit DTO projections only; authorized directory reads may return approved directory DTOs, sign-in list only approved
sign-in DTOs plus the resource/coverage envelope; correlation returns its narrower contract. No free-text/vendor extras.

Cursor is versioned base64url claims + HMAC-SHA256, timing-safe verification and strict bounded decoding.
Resolve shared configured key from `ATLAS_CORRELATION_CURSOR_SECRET_REF=env://NAME`; minimum32 UTF-8 bytes, no random
per-process default. Cursor configuration is validated at entry to each M365 paged-read service BEFORE any data query,
including untruncated first pages; missing/invalid configuration fails closed with a fixed safe code. Ordinary Stage1
startup/read surfaces remain usable without this config. Fixture synthetic reads take explicit injected test configuration.
No secrets/identity DTOs in claims. Compact signed claims `{v,b,f,p,e}`: version, SHA-256 binding digest, snapshot
fingerprint, last selected local evidence ID (ASCII <=128 chars; directory uses analogous local source position digest),
expiry epoch milliseconds. b hashes canonical actor/workspace/client + all-of permission evaluation + operation + observation
when present + connection + interval + limit/filters. p resolves the last tuple INSIDE the reloaded eligible snapshot;
then keyset compares full fixed-width time/sourceId/contentHash. It is not a client-authorized row lookup outside scope.
Raw long vendor source IDs or all binding inputs are not encoded. One shared maximum512 ASCII characters includes MAC;
issuance guarantees that bound. Directory position may use a SHA-256 digest of its sorted source-object key, fixed64 chars,
looked up only inside the current generation. A MAC-valid position absent from the reloaded eligible snapshot returns
CORRELATION_CURSOR_EXPIRED; no unscoped lookup or fallback. Fingerprints include current links/source mapping, directory pointers/
relevant membership, connection lifecycle, published pointers AND latest attempt states/sequences; also resolved DEVICE
id and current Device.personId including null; historical published conflict contributors, including outside the query
interval, contribute to fingerprint and earliest future expiry. Include relevant historical Huntress connection state. Reassignment/removal invalidates pages with otherwise unchanged links.
Claimed position/binding/fingerprint/expiry is trusted only after MAC verification. Every page reloads current authority/
snapshot and validates claims; input/fingerprint mismatch => 409 CORRELATION_CHANGED. Tampered/malformed input =>
CORRELATION_CURSOR_INVALID validation; time expiry => CORRELATION_CURSOR_EXPIRED conflict; do not log cursor values.
Lifetime <=15m, bounded by earliest FUTURE relevant directory/sign-in freshness/retention transition and selected evidence
expiry and input eligibility transition from+7days. Already stale data may issue a useful cursor. Reevaluate clock each page even with unchanged pointers.
Apply the SAME max512 to HTTP query, new-tool regex and explicit CLI cursor exception; preserve Stage1 cursor policies.
Test longest supported local IDs + cursor + all other parameters below existing2048-char tools-parameter body cap,
and exercise identical maximal input through API/tools/CLI. Never relax the Stage1 body cap to compensate for bloated claims.

## API, tools, fixtures and operator surfaces

Endpoint exactly GET /clients/:clientId/observations/:observationId/correlation, required connectionId/from/to,
optional limit=1..100 (default50), cursor. Reject unknown/repeated/non-scalar query keys, tenant overrides, from>=to,
duration>24h, future end or ANY from earlier than current database time minus7days; reject, do not silently clip that input. Same validation service for tools/CLI.
Observation must be Huntress and within scope; safe not-found/validation only. No implicit sync/widening.
New tools: atlas.observation.get_correlation and microsoft365.signin.list, risk0/NONE, both read permissions.
Parameters exactly connectionId/from/to, optional limit/cursor; correlation additionally requires observationId.
Client/workspace/actor authority never comes from parameters (gateway request clientId is resolved by existing scope policy).
Freeze sign-in list response: contractVersion='atlas.m365-signins.v1', mode, workspaceId,clientId,m365ConnectionId,
window, resources, coverage (same correlation resource/coverage contracts), items=null iff UNAVAILABLE otherwise
[{evidenceRef,occurredAt,dto:M365SignInV1,evidenceState}], total,truncated,nextCursor. Select ALL eligible published
sign-ins in interval, not correlation routes; no canonicalPersonId/relation/proof or claim of correlation.
Freeze directory-list response: contractVersion='atlas.m365-directory.v1', mode,workspaceId,clientId,m365ConnectionId,
resourceType=m365_user|m365_device, resource:CorrelationResource, items=null iff no usable active unexpired generation,
otherwise approved M365UserV1[] or M365DeviceV1[], total,truncated,nextCursor. STALE retained generations remain usable;
empty usable generation => [], missing/expired => null with truthful resource code. Order sourceObjectId ASC using
consistent deterministic SQL C collation. Shared bounded generation-bound MAC cursor semantics apply.
New resource responses use normative OK/STALE/ERROR/MISSING/FIXTURE statuses; upstream sign-in capability UNAVAILABLE
maps to MISSING + M365_SIGNINS_NOT_AVAILABLE (coverage UNAVAILABLE), never to fabricated complete-empty data.
Inject ONE composed registry into discovery, toolsAvailableTo, decideToolCall and executeTool for DB and fixture API.
Preserve exact Stage1 public tool descriptions and ClientContextV1/gateway outputs; new descriptions expose permissions[].
Tool ledger STARTED/SUCCEEDED/FAILED and audit remain persisted through existing gateway, including service refusals. A current-authority refusal after STARTED may finish the existing execution
with FAILED and allowlisted tool.failed in the client ledger/audit, alongside exactly one workspace denial; that bookkeeping
is not client-data access or a new correlation.read success audit. No raw parameters/results are persisted.
M365 outputs never enter Decisions/provider input. Fixture mode uses explicit synthetic readers or honest UNAVAILABLE
envelopes; it must not invent complete empty data. Fixture discovery is filtered by toolsAvailableTo on the SAME
registry. Preserve demo actor permissions; do not grant m365:read just to advertise tools. Test injected synthetic actors
with both/single/split-client permissions as the real fixture counterpart. Extend reader interfaces without breaking
legacy service consumers.

Freeze the following CLI command contract. Every command below requires --client; reject any undeclared flag, duplicate,
non-scalar, malformed ID or incompatible mode before service/I/O. Existing bind/mapping/disable contracts remain.

| Command | Required flags besides client | Optional flags / mutually exclusive mode | Behavior |
|---|---|---|---|
| m365-probe | connection | none | Issue/run accepted DISABLED activation capability, validate/discard bounded probes, activate; ACTIVE returns CONNECTION_ALREADY_ACTIVE without I/O. Activation failure stays DISABLED and reports safe code. |
| m365-sync users/devices | connection, resource=users or devices | none; reject from/to/request | One accepted directory-sync attempt; persisted retry/claim/budget admission unchanged. |
| m365-sync signins create | connection, resource=signins, from, to | none; request forbidden | Create one request then one bounded run pass; return requestId/root outcomes/counters/retryAt, never sleep/retry internally. |
| m365-sync signins resume | connection, resource=signins, request | none; from/to forbidden | Run existing request, preserve interval/config/counters/root retryAt and five-attempt chain; no new request. |
| m365-requeue | connection, request, window | none | Reset only selected FAILED root through existing audited service; no Graph I/O; use separate resume invocation. |
| m365-directory-reset | connection, resource=users or devices | none | Existing audited directory retry reset only; no I/O; future retryAt/live claim refused; follow with separate m365-sync. |
| m365-status | connection | request | Bound ACTIVE/DISABLED local metadata; optional existing scoped request narrows root job status. No DTO/secret/vendor IDs; derive outcomes from current root jobs, not immutable request.state OPEN. |
| m365-directory | connection, resource=users or devices | limit=1..100 default50, cursor | Approved current unexpired directory DTOs, generation-bound authenticated paging and both read permissions. |
| correlation | connection, observation, from, to | limit=1..100 default50, cursor | Shared CorrelationContextV1 query. |
| m365-cleanup | none | none; no connection/time/deletion filter | One scoped maintenance pass using separate same-target EXECUTE-only runner. |

Sync/requeue/reset require events:ingest + connections:manage; probe/status require connections:manage.
Directory/correlation require context:read + m365:read. Probe invokes existing S2-B issue/run capability services;
this explicitly operator-authorized activation is the sole DISABLED exception, and keeps one-use/version/expiry/revoke
checks and degraded sign-in403 behavior. ACTIVE probe refusal is intentional; use local status or explicit disable then
probe for reactivation. Status performs no activation or sync. No added probe authority purpose or generic bypass.
Sync and requeue reuse S2-B services; never duplicate transport/auth workflows or start a fresh request to evade retryAt.
Read DTOs go only to authorized stdout. Cursor flags have an explicit <=512-ASCII-character exception to legacy 256-byte flag
values; preserve unrelated flag limits. Directory paging uses shared MAC configuration and clock rules, binds scope/actor/
connection/resource/limit/current generation+attempt state and exact position, and denies after generation/authority changes.
Actual subprocess recovery tests cover create, later-process resume, NOT_DUE/no I/O, FAILED root requeue then resume,
directory reset eligibility/Retry-After, DISABLED activation, ACTIVE refusal and revoke during probe. Request ID and
charged counters persist across processes; an explicit reset is visible and audited, never an implicit budget reset.

## Maintenance service and bounded execution

Authenticate operator against ordinary runtime DB and recheck events:ingest + connections:manage before establishing
one-client transaction context on a separate configured cleanup-runner connection. Runner is EXECUTE-only;
no direct table reads/DML, no SET ROLE to definer, no public routine execute. Verify confinement/owner/grants before use.
Resolve runner URL lazily through `ATLAS_M365_CLEANUP_RUNNER_SECRET_REF=env://NAME`, never required by ordinary API.
The runtime target is trusted composition from the SAME URL used to construct the authenticated runtime Prisma client,
not a caller/flag. Before runner I/O, parse configured runner URL and require its complete target (protocol, normalized
host (lowercase TEXT, no DNS resolution), effective default-port substitution, database pathname and routing/SSL query options) identical to runtime URL, excluding only username/
password. Reject missing target, unexpected URL components and mismatch with a fixed safe configuration error. Construct
actual runner URL by cloning runtime URL and substituting only the validated separate runner credentials. Never pass
through a second target. The service factory owns the runtime URL+Prisma pairing; callers cannot supply an unrelated db.
Require distinct confined runtime/runner/definer/owner roles, and do not expose credential URLs in reports/logs. Test two
correctly provisioned databases with matching scope IDs: a runner URL for DB B with authenticated runtime DB A must fail
BEFORE context/cleanup/audit or mutation in B. Also test same-target credential substitution and confinement failure.
Open runner with a PrismaClient, using existing pinned production dependency; no new pg runtime dependency.
A runner-perspective startup check verifies current role has EXECUTE only, no table/column privileges or privileged role
membership, plus exact confined definer owner/grants and routine ACL. Reuse narrowly extracted definer/ACL facts from
runtime-role.ts; do NOT call runtime-only assertRuntimeRole on runner or weaken runtime checks.
Runtime current-authority check executes immediately BEFORE runner transaction, after URL/config/confinement work.
This admits cleanup at that check's snapshot: a concurrent later actor/membership revoke may commit before the separate
runner transaction completes. No distributed atomic revocation fence is claimed; document this residual gap. Direct routine
still confines scope/expired deletion, and M365 disable never revokes maintenance eligibility. A failed current-authority
check gets workspace denial and no routine call. Do not grant runner/definer access to actor/membership tables to bridge it.
Service calls existing atlas_m365_cleanup(correlationId) under verified SET LOCAL workspace/client/actor. No caller time,
ID list, connection filter or deletion predicate. Bound execution by trusted operator config `ATLAS_M365_CLEANUP_TIMEOUT_MS`, integer30000..600000,
default300000 (5min), plus fixed lock timeout5000ms. It is env composition only, not caller deletion/CLI filter.
Runner transaction timeout exceeds statement timeout by a small fixed guard; whole pass rolls back on timeout.
This is a configurable time bound, not a claim of row-batched cleanup. RUNBOOK gives increasing timeout within this
sanctioned range and reducing refresh load as recourse; if backlog still cannot clear at600000ms, report failure requiring
a reviewed batching amendment rather than claim physical retention completion. Read expiry continues regardless.
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
cursor tampering/input/publication/mapping/attempt change, Device.personId reassignment/removal, actor revoke, freshness/expiry between pages;
both/single/split-client permissions across HTTP/CLI/tools/fixture, same composed registry and persisted ledger outcomes;
privacy canaries absent from DB projections/audit/errors/logs/provider; cleanup rollback, connection lock contention,
fresh publication race, disabled scope, role prohibitions and no Stage1 changes; actual CLI/API/tools synthetic Gasta journey.
Actual subprocess mock mechanism is explicitly authorized: `node --import tests/support/m365-fetch-preload.ts
--experimental-strip-types scripts/ops.ts ...` (put strip-types before import if required by runtime). The TEST-ONLY
preload replaces global fetch for EXACT existing token authority POST and Graph v1.0 GET routes with captured mock
responses; any unrecognized origin/method/path throws before network. No production endpoint/transport/env bypass.
Use a small loopback test coordinator or file barrier scoped to a temp directory for response control/call receipts:
for revoke-during-probe hold one mock response, commit real m365-disable in parent runtime/second child, then release.
This control is confined to tests/support, not imported or selected by production application code. No real credentials.
Preload and subprocess capture permit proving resumed NOT_DUE makes zero upstream calls and counters stay durable.
C5a connection-contention tests release the held lock within fixed5s timeout and separately verify timeout rollback.
Read SQL should guard malformed noncanonical timestamp JSON with a strict safe predicate; do not expose raw DTO errors.
No expression-index migration is assumed; measure bounded synthetic count behavior and report performance limits honestly.

Required final commands: npm test; npm run schema:validate; npm run db:generate; npm run typecheck;
npm run api:build; npm run api:smoke; npm run test:pg; npm run db:check:pg17; npm run db:check:drift; git diff --check.
Record exact commands/exits/counts (zero skip for required behavior), synthetic dated receipts and payload/log hashes.
Do not repeatedly rerun unchanged passing full suites. Keep independent review evidence and provider metadata separate.
Stop implementation at reviewable S2-C candidate. Fresh Astra gpt-6-astra/xhigh must accept actual frozen code/evidence;
implementer report is not acceptance. Codex verifies exact accepted hashes before marking completion. LIVE remains pending.
