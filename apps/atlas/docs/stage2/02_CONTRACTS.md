# Stage 2 — data, API and correlation contracts

Normative draft for implementation; no schema has been migrated by this pack.

## 1. Scope and authority

All domain inputs receive authenticated Actor and server-resolved Scope. Connection is issued by
ConnectionsModule; Microsoft tenant GUID comes only from its immutable binding. Tenant is not Atlas clientId.
Ordinary sync/publication/correlation requires `system=microsoft365`, ACTIVE connection and current binding.
The only exception is an issued activation-purpose capability for a bound DISABLED connection: it allows token
acquisition, tenant verification and bounded capability probes, but no evidence publication or ordinary reads.
FIXTURE never acquires a token. The selected M365 connection must be ACTIVE for current correlations.
An old Huntress observation remains readable if its source connection is disabled: preserve historical evidence,
report SOURCE_CONNECTION_DISABLED, and make no claim of current source connectivity. Current canonical link rules still apply.
Add monotonic Connection.lifecycleVersion in a new migration; bind/disable/revoke/activation increments it.
Every existing and new activation path increments this shared field, including Atera/Huntress; their public outputs stay unchanged.
Activation capability pins this version, actor and scope, is short-lived and consumed by conditional activation;
replay or revocation during probe fails. Recheck current authority before I/O and atomic activation.
DB-mode M365 operations reject FIXTURE connections; fixture mode uses synthetic local data and never acquires tokens.

| Operation | Required client permissions |
|---|---|
| Read correlation, directory, sign-ins | `context:read` + `m365:read` |
| Propose/confirm/reject/quarantine M365 mapping | `mapping:review` + `m365:read` |
| Bind/activate connection | `connections:manage` (existing); M365-specific metadata reads also need `m365:read` |
| Disable M365 connection (`m365-disable`) | `connections:manage`; local status/version output only |
| Run M365 sync / requeue / scoped cleanup | `events:ingest` + `connections:manage` |
| Read mapping queue including M365 | `mapping:review` + `m365:read`; otherwise exclude M365 before query/projection |
| m365-probe | `connections:manage`; only count/status/capability output, activation-purpose rules apply |
| m365-status | `connections:manage`; counts and safe codes only |
| m365-directory, correlation CLI | `context:read` + `m365:read`, same domain check as API/tools |

The permission dictionary in membership SQL must gain m365:read in a new migration. No grants to all existing actors.
Generic mapping service, CLI and list paths must enforce this, not only new endpoints. Existing API tokens stay hashed.
RLS continues to confine client scope; service checks enforce the extra permission within that scope.
Unauthorized client → workspace SecurityAuditEvent; authorized client but missing permission → safe audited denial.
No M365 IDs in denial metadata. Callers cannot supply risk, permissions, tenant or token authority.

Implement a scoped service and operator CLI `m365-disable`. Lock Connection first, recheck the actor's current
authority, require system=microsoft365 and status ACTIVE or DISABLED, set DISABLED and increment lifecycleVersion
in the same transaction as allowlisted `connection.disabled` audit. Even an already-DISABLED call increments the
version to invalidate pending activation capabilities. FIXTURE is rejected. Return local connection ID/status/version only.
In this pack, connection "revoke" means this local disable operation, not Microsoft credential revocation or a new status.
All previously issued capabilities and token-cache entries for the old version become unusable, including in other
processes at their required authority recheck; also evict local cache entries. An in-flight request may finish but cannot
publish after disable wins the Connection lock. No upstream write or credential deletion occurs.

## 2. Vendor identity and bounded DTOs

IDs are nonempty strings validated per endpoint (directory/tenant GUIDs; signIn.id opaque ≤256 chars).
Empty optional IDs normalize to null; invalid required IDs invalidate the page. UTC times must parse strictly.
Unknown enum values become UNKNOWN plus a safe reason; raw new enum strings are not copied to audit.

| DTO | Persisted allowlist | Semantics |
|---|---|---|
| M365UserV1 | id, displayName (≤256), userPrincipalName (≤320), userType, accountEnabled | id is directory object ID within tenant; names/UPN are display hints, not identity proof |
| M365DeviceV1 | id, deviceId, displayName (≤256), accountEnabled, operatingSystem (≤128) | id = directory object key; deviceId = device registration alternate key; these are distinct |
| M365SignInV1 | id, createdDateTime, userId?, deviceDetail.deviceId?, appId?, status.errorCode?, isInteractive? | User/device values are evidence references, not verified human ownership; errorCode is status, never severity |

No IP address, geolocation, userDisplayName/UPN from sign-ins, authentication details, CA policies,
risk properties, free-text failureReason, tokens or raw response bodies are persisted.
Graph signIns does not document $select here: receive bounded response, immediately project allowlist and discard the rest.
Directory $select restricts fields in 03_CONNECTOR_SYNC. Missing booleans/status are null, never false/success by default.

ExternalEntity for m365_user/m365_device stores only opaque source ID and non-PII attribute codes;
display names and UPN live only in the dedicated permission-gated directory store. Canonical Person/Device
fields are not auto-overwritten by Graph. Duplicate deviceId across directory rows → AMBIGUOUS, not first-match.

## 3. Planned persistence model

All primary keys and relational references below include workspaceId/clientId. Connection-specific
FKs also include connectionId (including generation/run references); no global-ID-only FK is sufficient.
JSON DTOs are validated before storage; JSON does not substitute for relational scope constraints.

| Table / extension | Identity and invariants |
|---|---|
| M365DirectoryGeneration | scope/connection/resource/generationId; resource is m365_user or m365_device; STAGING/PUBLISHED/FAILED; attemptSeq, claimToken, leaseExpiresAt, startedAt/completedAt, rowCount, safeErrorCode. One published pointer per resource lives in M365ResourceState |
| M365DirectoryObject | scope/connection/resource/generationId/sourceObjectId; bounded DTO and externalEntityId. Typed composite FK to ExternalEntity; uniqueness of sourceObjectId in generation; deviceId indexed for lookup, not assumed unique |
| M365ResourceState | scope/connection/resource; latestStartedSeq, latestRecordedSeq, latestPublishedSeq, activeGenerationId?, lastAttemptAt, lastSuccessAt, status, safeErrorCode. Pointer FK pins resource/connection; null until first successful full read |
| M365SyncRequest | scope/connection/requestId; requestedFrom/To, retrievalFrom/To, configVersion, totalStagedRows, state, createdAt; durable request-wide cap counters (≤25 roots, ≤250,000 rows); no raw payload |
| M365SyncRootJob | scope/connection/requestId/windowId; attemptsUsed, maxAttempts, retryAt, state; unique per request/root. Every retry claims and increments budget atomically before creating a new attempt; manual audited requeue is explicit |
| M365SignInWindow | scope/connection/windowId; unique (scope,connection,rootFrom); rootFrom UTC-hour aligned, rootTo=rootFrom+1h; latestStartedSeq, publishedAttemptId?, lastAttemptStatus/code/time. Published pointer is scoped also by windowId |
| M365WindowAttempt | scope/connection/windowId/attemptId; request/root-job composite FK, monotonic attemptSeq, fixed coveredFrom/coveredTo within root, configVersion, claimToken/lease, state RUNNING/COMPLETE/FAILED/SUPERSEDED; completedAt, publishedAt?, safeErrorCode, counts. COMPLETE is set only in successful publication; published attempt and memberships are immutable; a refresh/retry always creates a new attempt |
| M365WindowLeaf | scope/connection/windowId/attemptId/leafId; parentLeafId? composite self-FK within same attempt, bounds inside parent's bounds, state PENDING/RUNNING/COMPLETE/FAILED/SPLIT; child partition persisted atomically; SPLIT is a container, not published evidence |
| M365SignInEvidence | scope/connection/sourceId/contentHash; generated id; bounded immutable DTO, firstSeenAt/lastSeenAt, expiresAt; contentHash of canonical allowlisted DTO under dtoVersion=m365-signin-v1. Same ID+hash deduplicates; changed content creates another version, never overwrites old evidence |
| M365WindowEvidence | scope/connection/windowId/attemptId/leafId/evidenceId; composite FKs to leaf and evidence; readable only through the root's published attempt; no membership mutation after publication |

Root pointer publication verifies that COMPLETE nonsplit leaves exactly partition the attempt's covered interval,
with no gaps/overlaps and validated final pages. Partial children never publish on their own.
Staging rows are never queried by ordinary read services. Source references userId/deviceId inside evidence
are plain vendor IDs, not internal entity FKs; scoped joins resolve them. Persisted internal references must be composite.
Each published directory object has an ExternalEntity mirror created in the publication transaction, not before it.
Preparation pages can be staged with a nullable mirror; publication creates/fills every mirror then flips the pointer.
No published row may have an absent/incorrectly typed mirror (SQL validation/trigger required).
Mirror registration is an upsert by scope/connection/resource/sourceObjectId, reusing existing ExternalEntity/link IDs;
observedAt advances only on accepted publication. Extend TS ResourceType with m365_* for typed internal links, but
keep the existing ClientContextV1 expectedResources and output schemas unchanged, filtering M365 in old projections.
Enforce immutable sign-in DTO/hash/source identity and published attempt/membership with SQL triggers or equivalent
privilege-safe constraints; mutable lastSeenAt may only increase, expiresAt cannot be extended past occurredAt+retention.
Existing default runtime UPDATE grants must be explicitly restricted or guarded on new tables.
Immutable published rows/memberships permit only the narrowly authorized expired DELETE through the cleanup routine
in §6; this exception never allows changing DTO/hash or adding/removing unexpired published membership.

New migrations create database-local tables, CHECK/unique/FK/RLS, triggers and routine definitions only; they neither
create cluster-wide roles nor reference runtime roles that may not yet exist. Add every new table to PROTECTED_TABLES.
Provision least-privilege roles/grants through extended prisma/roles.sql AFTER migrate deploy, before runtime starts.
Provisioning supports fresh installation and upgrade with existing managed roles: create roles only if absent,
validate their confinement, and reapply grants/revokes without replacing existing login credentials. Test both paths.
Migrations revoke routine EXECUTE from PUBLIC immediately. A cleanup routine initially owned by the migration owner
is not exposed to runtime; roles.sql transfers it to the confined NOLOGIN definer and grants only the cleanup runner.
Extend renderRolesSql and test teardown for unique runtime/definer/runner role names and separate runner credentials;
shadow migrations and PGlite DDL must not create roles or require a pre-existing atlas_app. Runtime checks fail closed
if role grants, routine owner or definer confinement are wrong. Upgrade runtime stays stopped until provisioning passes.
SQL-only constraints must be documented and verified on real PostgreSQL with generated Prisma client; use explicit names
to avoid identifier truncation collisions. Old migrations remain frozen.

Publication and cleanup lock Connection then resource/root state, in a common order. Verify lifecycleVersion,
ACTIVE state, current actor authority and claim/sequence under those locks for publication; revoke uses the same Connection fence.
Cleanup instead checks its maintenance authority and expiry; it remains allowed after disable/revoke.
No stale issued capability can publish after revocation wins the lock. An in-flight network request can complete,
but its result is discarded. SQL constraints/transaction tests enforce pointer and state atomicity.

EntityLink remains the reviewed canonical mapping table, extended with typed M365 pairs. An existing CONFIRMED link
is usable if its object is present in the active published generation and now < completedAt+24h (payload retention).
After 60m, or a newer pending/failed directory attempt, retained membership may still resolve: report the resource as
STALE and include DIRECTORY_STALE in resolution.reasonCodes without changing RESOLVED solely because of freshness.
At now >= completedAt+24h, hide its DTO and make that resolution path UNRESOLVED/DIRECTORY_EXPIRED; no pointer means
MISSING. Absence from an unexpired active generation gives DIRECTORY_OBJECT_NOT_CURRENT, not identity reassignment.
Historical link/audit remains. New mapping confirmations require an active fresh generation (age <60m, no newer
pending/failed attempt), rechecked under transaction; stale retained membership is usable only by existing confirmations.
Reappearance of the same opaque directory object ID may reactivate the still-CONFIRMED mapping after fresh publication;
different ID with the same name does not. REJECTED/QUARANTINED links never reactivate automatically.

## 4. Correlation rules (deterministic, no model)

Implement a focused scoped transaction helper with Prisma isolationLevel=RepeatableRead; set_config is still the first
statement and actor-derived client scope is confined exactly as in withScope. Existing withScope's default isolation
alone is insufficient. Read one consistent snapshot, including published generation pointers,
window evidence, observation, links and connection status. Never perform upstream I/O during correlation read.

1. Resolve `Observation.eventId → RawEvent.connectionId + RawEvent.normalized.externalDevice` through scoped FKs.
   Require source=huntress and validated externalDevice `{resourceType:'agent', externalId}`; use that same Huntress
   connection + resource + externalId to find ExternalEntity and its current CONFIRMED DEVICE link. Missing/invalid
   normalized reference → UNRESOLVED/SOURCE_DEVICE_REFERENCE_MISSING (or INVALID), never fallback to Observation.entityId.
   The stored entityId is historical evidence only; rejection/reconfirmation between ingest and query uses current mapping.
2. Follow CONFIRMED m365_device links for that DEVICE, scoped to the selected M365 connection. More than one current
   external mapping is AMBIGUOUS; do not arbitrarily select or merge.
3. Compare signIn.deviceDetail.deviceId exactly with directory device.deviceId **not directory device.id**.
   Match is `DEVICE_REFERENCE`; it describes what Microsoft reported, not an independent attestation of hardware.
4. Resolve signIn.userId exactly to current directory user.id; a confirmed user link yields a canonical PERSON.
   This establishes `SIGNIN_USER_REFERENCE`, not assignment/ownership of the canonical device.
5. Separately, device.personId may point to an assigned Person. Its confirmed M365 user link permits
   `ASSIGNED_PERSON_ACTIVITY` results in the window even when sign-in device is absent/different.
   Label them as person activity; never call those device matches. If both routes find the same evidence, return one item
   with both relation codes. Several assigned-person mappings → AMBIGUOUS for that path.
6. Unconfirmed mappings appear as unresolved reasons, not resolved IDs. Manual operator review can confirm links;
   no email/UPN/name/hostname/time-only automatic confirmation. Guest user IDs remain local tenant objects.

Each relation includes link IDs/statuses, vendor reference field name, source evidence ID/hash, directory generation IDs
and ruleVersion `m365-correlation-v1`. Names are display values only. No overall probabilistic confidence score.
Correlation never updates observations, creates incidents, lowers urgency or infers compromise/causation.

## 5. Read contracts

New endpoint: `GET /clients/:clientId/observations/:observationId/correlation`.
Required query: connectionId (M365), from, to; optional limit (1–100, default 50) and opaque cursor.
Reject from>=to, duration>24h, end in future, outside retained period, unexpected params and caller-supplied tenant.
Observation belongs to the same scope and source=huntress; otherwise safe not-found/validation response.
Endpoint uses stored data only. It never silently starts a sync or widens the requested interval.

Response `CorrelationContextV1`:

```text
contractVersion: atlas.correlation.v1; mode: fixture | db
workspaceId, clientId, observationId, m365ConnectionId, ruleVersion
source: { eventKey, severity, priority, route }       // unchanged Stage 1 source
window: { fromInclusive, toExclusive }
resources: [{ resourceType, status: OK|STALE|ERROR|MISSING|FIXTURE,
  lastSuccessAt, asOf, safeErrorCode, generationId?, coverage }]
resolution: { device: RESOLVED|UNRESOLVED|AMBIGUOUS,
  person: RESOLVED|UNRESOLVED|AMBIGUOUS, reasonCodes[] }
items: [{ evidenceRef, occurredAt, statusCode?, canonicalPersonId?,
  relationCodes[], proof[], evidenceState: CURRENT|CONFLICTED }]
coverage: { status: COMPLETE|PARTIAL|UNAVAILABLE, traversalComplete: boolean,
  completedWindows: [{ rootWindowId, publishedAttemptId, fromInclusive,
    toExclusive, retrievedAt, freshness: FRESH|STALE }],
  gaps: [{ fromInclusive, toExclusive, reasonCode }],
  sourceScope: GRAPH_V1_USER_SIGNINS, assessedAt,
  freshness: FRESH|STALE|MIXED|UNKNOWN }
total, truncated, nextCursor
```

coverage.status describes traversal coverage only: COMPLETE iff published retained intervals cover the whole query;
PARTIAL iff there is some coverage and at least one uncovered interval; UNAVAILABLE iff no published interval is usable.
traversalComplete is exactly (status===COMPLETE). gaps contains only time not covered by a published retained attempt,
never intervals merely older than freshness. completedWindows contains the selected published portions clipped to
the query and current retention, with their actual retrieval times; no staging data contributes.
freshness is independent: FRESH if all selected portions are fresh; STALE if all are stale; MIXED if both;
UNKNOWN when there are no usable portions. A pending/failed newer refresh makes its retained portion STALE.
A complete historical read can therefore be COMPLETE + traversalComplete=true + gaps=[] + freshness=STALE.
Neither COMPLETE nor FRESH guarantees that every real-world sign-in was reported or that a client is safe.
Directory state is independent: retained active membership can resolve with DIRECTORY_STALE; missing/expired directory
or absent membership makes the relevant resolution path unresolved under §3. Coverage does not disguise either condition.
No coverage → items=null. Complete zero matches → items=[]. PARTIAL returns only available published data and gaps.
Each nonoverlapping UTC root contributes exactly its published attempt clipped to the requested interval.
A failed/in-progress newer refresh makes retained last-good publication STALE without changing its retrieval time.
New successful roots may coexist with stale/missing roots; partial success inside one root adds no new coverage.
Conflicting versions of one sign-in ID are shown with CONFLICTED; neither version is silently preferred for resolution.

Sort evidence by occurredAt DESC, sourceId ASC, contentHash ASC. Cursor binds scope, actor permission evaluation,
observation, connection, window, filters and generation/window snapshot fingerprint. Recheck permissions every page;
if inputs or publication/mapping fingerprint changed, return 409 CORRELATION_CHANGED and restart, not mixed pages.
Cursor also expires at the earliest future freshness/retention transition of selected evidence/generations (already
stale data does not instantly expire a newly issued cursor); always re-evaluate current time eligibility each page.
Fingerprint includes latest-attempt state as well as published pointers/mappings. Time alone must not let a cursor
expose expired data with unchanged pointers. Bound cursor lifetime to at most 15m even when no earlier transition exists.
Cursor integrity is authenticated with a server-side MAC or an opaque server-side record; reject tampering rather than
trust client-supplied fingerprint, expiry or paging position. This does not replace scope and permission rechecks.
MAC keys resolve from an env secret reference shared by API processes, never a per-process random default; missing
configuration fails closed. A server-side cursor alternative must use shared, scoped storage.

Tools (risk=0, sideEffect=NONE; both permissions required):
- `atlas.observation.get_correlation` → CorrelationContextV1.
- `microsoft365.signin.list` → same resource/coverage envelope without a claim of correlation; same interval/limit bounds.

Change internal ToolDefinition from singular permission to `permissions: readonly string[]`, with all-of semantics.
Stage 1 definitions become singleton arrays; both new tools require ['context:read','m365:read'].
decideToolCall checks every permission in the requested client's membership. toolsAvailableTo lists a tool only when
one same client membership contains all permissions (never combine context:read in A with m365:read in B).
Keep PERMISSION_DENIED/tool.denied outcomes. describeTool preserves exact legacy public DTOs for Stage 1 entries
(singular permission); new tools publish `permissions: string[]` and no singular permission field, with the other
existing describeTool metadata fields unchanged. CLI/API call the same domain authorization.
Registry metadata remains authoritative; caller cannot supply or override the permission list.
Inject the same composed registry (existing + M365 tools) into discovery, policy and executeTool; do not leave
executeTool wired to the stage1Tools default while advertising new tools, or bypass policy for M365 execution.

V1 client overview/gateway schemas remain unchanged in output; explicitly exclude m365_* links and resources from
their SQL projections. New tools' outputs stay outside the Decisions/provider input path.

## 6. Privacy, lifetime and audit

Defaults are Atlas design limits, not vendor or legal guarantees: sign-in evidence retained 7 days from occurredAt;
directory DTO only while generation is active plus previous generation ≤24h; abandoned staging ≤24h.
Queries enforce expiry even if cleanup has not run. At active-generation completedAt+24h, hide its identity DTO, mark
the resource MISSING/DIRECTORY_EXPIRED and the affected resolution path UNRESOLVED. Before expiry, STALE retained
membership remains usable as defined in §3. Freshness within those bounds is defined in 03.

Scoped `m365-cleanup` calls an EXECUTE-only maintenance routine after authenticated service checks from §1.
The routine's NOLOGIN definer role is not a table owner, has no BYPASSRLS or role membership that bypasses RLS.
For the mandatory Connection row lock, grant this role SELECT only on Connection.id/workspaceId/clientId/system/status/
lifecycleVersion and UPDATE(id). PostgreSQL requires an UPDATE column grant for SELECT FOR UPDATE; id is protected
by the existing immutable-binding trigger, so its value cannot change. This grant is used only for row locking:
the routine never issues Connection INSERT/UPDATE/DELETE or changes binding/status/version. The runner receives no
direct Connection privileges and cannot SET ROLE to the definer. Connection RLS remains enforced.
Otherwise it has only required SELECT, DELETE on new M365 payload/membership/attempt tables, column-limited UPDATE on current
pointer/status fields and INSERT on AuditEvent. The dedicated cleanup runner has EXECUTE, no direct table DML;
ordinary API/worker roles have neither EXECUTE on this routine nor DELETE. REVOKE routine access from PUBLIC.
Create these roles and apply grants/revokes/ALTER FUNCTION OWNER in prisma/roles.sql, not schema migrations, per §3.
Use fixed search_path, schema-qualified objects and no dynamic SQL. Scope/actor come from verified local transaction
context (exactly one client), not caller-chosen routine arguments; routine accepts only a correlation ID.
RLS applies to the definer role. The service checks actor permissions before establishing this context.

Routine locks Connection then resource/root states in the publication lock order, derives expiry from database time,
deletes expired memberships before unreferenced evidence, and generation children before parents. SQL predicates
enforce expiry even against a direct permitted routine call; no caller-supplied time, ID list or deletion filter.
Fresh/current publication cannot be deleted; an expired current pointer is cleared with MISSING/RETENTION_EXPIRED
state in the same transaction as payload deletion and allowlisted retention.completed audit (counts/local IDs only).
Rollback restores pointer, payload and audit together. Existing Audit/RawEvent/EntityLink rows are never deleted.
Retention timestamps for staged/obsolete generations and attempts are bounded on creation/publication; cleanup
may remove failed/staged attempts older than 24h and published attempts only once their coverage/evidence expires.
Root metadata without personal payload may remain; no stale publication gets a new lastSuccess timestamp from cleanup.
Persist only opaque ExternalEntity/link provenance after payload expiry. No source payload is copied into audit.

Audit events: sync.started/completed/failed, connection.disabled, mapping decisions (existing), correlation.read,
retention.completed. Allowlist only local opaque IDs, counts, rule/config versions, outcomes and safe codes;
no UPN, display name, vendor response, token, continuation URL, source user/device IDs or request query.
Provider, exception, request logger and CLI outputs obey the same redaction boundary. Authorized read result
may contain approved DTO fields; persisted logs/reports may not contain them. E2E evidence files use synthetic data.
