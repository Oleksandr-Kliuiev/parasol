# Stage 4 data isolation and concurrency

## Scoped tables

Add prisma/poweroffice.prisma and additive migrations only. Every row has workspaceId,clientId,connectionId and scoped
Connection FK; every cross-row reference includes that scope. FORCE RLS and transaction-local app scope apply to all
new tables. Runtime cannot own tables or have BYPASSRLS. All identity fields are immutable; SQL CHECKs explicitly reject
NULL for mandatory fields, not SQL UNKNOWN. Every new routine revokes PUBLIC EXECUTE in its own migration, before role
provisioning or readiness. Invoker triggers use fixed search_path and schema-qualified relations. Aggregate SQL validation
uses an invoker trigger function, not a CHECK helper requiring runtime EXECUTE. No new shared invoker-list entry or
Stage3 fence-definer callable routine/relation privilege. Immediate post-migration fence routine readiness must pass.

| Table | Identity and state |
|---|---|
| PowerOfficeState | PK(scope,connection); nextSequence>=1; nullable activeAttemptId; nullable snapshotId+snapshotVersion; lastAttemptId/state/code; lastCompletedAttemptId/state/code; lastSuccessAt; updatedAt |
| PowerOfficeAttempt | PK(scope,connection,id UUID); unique(scope,connection,sequence); immutable claimToken UUID, allocatedSnapshotId UUID, lifecycleVersion, actorId, correlationId, startedAt, readDeadlineAt, deadlineAt; state ACTIVE|SUCCEEDED|FAILED|ABANDONED; completedAt/code nullable until terminal |
| PowerOfficeSnapshot | PK(scope,connection,id UUID); scoped attempt FK; lifecycleVersion; asOf, businessDate, publishedAt, expiresAt; strict bounded aggregate JSON; synthetic marker |

Attempt.actorId has a workspace-scoped Actor FK with RESTRICT; retained attempt metadata can prevent Actor deletion.
State active/lastAttempt/lastCompleted pointers have scoped attempt FKs; snapshotId+snapshotVersion references a scoped
snapshot including lifecycleVersion. Partial-null pairs/tuples are invalid. No claim: lastAttempt tuple null; no completed
claim: lastCompleted tuple null. Completed outcome/ID/code persist during ACTIVE; only a terminal commit replaces them.
Snapshot has unique(scope,connection,id,lifecycleVersion) and one snapshot per attempt. allocatedSnapshotId is an allocated
UUID, not a FK to a nonexistent row. Snapshots are immutable. A partial unique index permits one ACTIVE per connection.
ACTIVE means completedAt/code null; terminal means completedAt non-null. FAILED/ABANDONED require fixed codes; SUCCEEDED
has no error. Exact startedAt+60s readDeadlineAt and startedAt+80s deadlineAt are constrained. Snapshot asOf=attempt.startedAt,
publishedAt>=asOf and<attempt.deadlineAt, expiresAt=publishedAt+24h; synthetic marker fixed. Scoped Snapshot→Attempt FK
includes lifecycleVersion and asOf→startedAt, backed by matching attempt UNIQUE. SQL and TS enforce02's exact aggregate
object, sorted unique currencies, total/group counts, canonical amounts and no extras.

Lifecycle guards prohibit terminal revival, sequence rewind, claim replacement and identity/history mutation. Deferrable
COMMIT constraints check BOTH directions: every ACTIVE attempt is the State.activeAttemptId and vice versa; snapshot
pointer names its owned SUCCEEDED attempt and allocatedSnapshotId. State lastAttempt tuple matches latest allocated
sequence; lastCompleted tuple matches latest terminal attempt; lastSuccessAt/published pointer cannot diverge. All
publication/terminal/pointer changes commit with client audit. No pointer to an uncommitted or another attempt's snapshot.

## Protected reads and lock order

Use READ COMMITTED. Exact lock/read protocol (no earlier lock acquired from a later position):

| Operation/role | Workspace fence | Connection | State | Attempt | Snapshot |
|---|---|---|---|---|---|
| Runtime status/summary | FOR SHARE | plain scoped SELECT | FOR SHARE if present | plain SELECT | plain SELECT |
| Runtime sync/page/publication/failure/recovery | FOR UPDATE | plain scoped SELECT | FOR UPDATE | FOR UPDATE if present | plain SELECT / INSERT at publication |
| Cleanup definer | FOR UPDATE | plain scoped SELECT | FOR UPDATE if present | plain SELECT, DELETE only when eligible | plain SELECT, DELETE only when eligible |

Fence is always first. The installed Connection BEFORE ROW mutation trigger takes the physical Connection tuple before
fence; therefore new code MUST NOT take a Connection row-lock SELECT after fence (would invert that order). A scoped
MVCC binding read after fence is stable: no binding/auth mutation can commit while this fence is held. Snapshot reads
are protected by fence/State and immutability; no Snapshot UPDATE locking privilege is needed. Cleanup DELETE takes its
implicit row locks after earlier locks; it never uses Attempt/Snapshot FOR UPDATE. Read-only fence SHARE permits concurrent
reads but excludes auth mutations and all new PowerOffice mutations. New write paths acquire the fence before State/Attempt
writes; guards never introduce a late fence acquisition. Never hold a transaction or any lock over port I/O.

Only sync admission initializes State using ON CONFLICT DO NOTHING under the fence, then locks it. Reads/recover/cleanup
never initialize missing State or change business rows merely to read; successful reads insert only their atomic audit.
First authenticate for a workspace hint; then lock its exact fence. Re-authenticate and check binding/client permissions
AFTER ALL locks with current DB clock, including token expiry after State/Attempt waits. No earlier Actor/clock is authority.
Fence completeness/readiness is mandatory; corrupt/incomplete fence refuses, with offline repair only. New code never
updates Connection status/lifecycle. Existing ACTIVE returns BUSY even expired. Fresh authorized recovery at DB
clock_timestamp()>=deadlineAt marks ABANDONED and clears pointer, never publishes pages. Earlier: RECOVERY_NOT_DUE.
With no ACTIVE attempt, recover returns POWEROFFICE_NO_ACTIVE_ATTEMPT, zero business/audit effects and no port call.

Publication requires exact private attempt token/ID/sequence/version, ACTIVE, DB clock<deadlineAt, unchanged FIXTURE
binding and fresh current sync authority; snapshot+pointer+SUCCEEDED+lastCompleted+lastSuccessAt+audit commit together.
Only a full identical completed fact and identity is an idempotent no-op with no duplicate audit; changed fact with reused
identity is PUBLICATION_CONFLICT. A receipt/replay still requires fresh caller/binding checks and cannot return expired
financial payload. Stable sequence/allocatedSnapshotId/audit ID survive a lost acknowledgement; unknown commit never
starts a new export. Only known rollback40P01/40001 permits max3 total transaction attempts on the SAME detached fact and
identities, fresh authority/binding/deadline each time, zero port calls. Other operations never automatically retry.
Exhaustion returns PUBLICATION_CONFLICT leaving a recoverable claim; no generic unknown-commit fallback.

A private failure continuation can close only its owned still-ACTIVE claim as FAILED after caller revocation/binding loss,
with fixed code/audit and lastCompleted update, preserving snapshot/lastSuccessAt. No read/source/publication authority.
It uses the write lock order, exact ownership and original deadline; terminal replay is no-op. At/after deadline it cannot
mutate: explicit recover handles it. Audit rollback leaves ACTIVE; same bounded known-rollback policy may record failure
without minting a new authority/time window. Recovered ABANDONED similarly updates lastCompleted; a later ACTIVE does not
clear failure state. State.lastCompletedAttemptId is retained until a later terminal outcome replaces it.

## Exact roles and scope

Runtime: SELECT all new tables; INSERT State/Attempt/Snapshot; UPDATE only State operational pointers/sequence/outcomes
and Attempt state/completedAt/safeErrorCode. No immutable-column UPDATE, Snapshot UPDATE, DELETE/TRUNCATE, ownership,
BYPASSRLS, broad definer EXECUTE or ApiToken visibility. Existing runtime fence UPDATE(workspaceId) suffices for either
fence lock mode; no actual fence UPDATE. State UPDATE grants support its lock modes; Attempt terminal UPDATE supports its
runtime lock. Extend exact startup allowlists without relaxing Stage3 fence checks or earlier role constraints.

New cleanup runner is EXECUTE-only on one new routine; separate NOLOGIN SECURITY DEFINER owner, no runtime/Stage3/M365
owner membership. Definer has Connection/fence SELECT; fence UPDATE(workspaceId) solely to lock, never actual UPDATE;
State SELECT + snapshotId/snapshotVersion/updatedAt UPDATE; Attempt SELECT/DELETE; Snapshot SELECT/DELETE; audit INSERT.
No Connection/Attempt/Snapshot UPDATE grants or auth/member/credential access. No table ownership/BYPASSRLS. Extend role
renderers and exact distinct-role count for the two roles. Verify runner confinement, owner policies/grants, forbidden writes
and every explicit row lock on real PG17, including a non-superuser migration owner. Stage1 resolveConnection/resolveCredential
refuse PowerOffice before any secret resolver; generic bindable-system allowlist and ApiToken policies/grants stay unchanged.

Reuse the existing PUBLIC scoped fence policy unchanged: exactly its existing TWO policies, no third maintenance policy.
The trusted runner transaction sets app.workspace_id, app.client_ids (singleton), app.actor_id from admitted private context,
and app.poweroffice_connection_id to the one admitted connection using transaction-local set_config, BEFORE the function.
Function parameters are validated workspace/client/connection plus generated local correlation ID, never clock/SQL/path/data.
The function validates exact equality to those settings (client list must be the exact singleton) before locks; mismatch
returns fixed failure with zero effects. New-table dedicated definer FORCE policies reference these GUCs, not invisible
function parameters, and scope all three IDs. Direct owner reads with empty/foreign settings see no cross-scope rows;
foreign fence rows stay invisible. Runner holds no auth-table access and cannot select data. Function rechecks system and
immutable synthetic binding; foreign client or non-PowerOffice connection refuses. Qualified object names, fixed
search_path=pg_catalog,public, explicit REVOKE PUBLIC in migration; only runner EXECUTE is granted by provisioning.

## Explicit bounded maintenance

CLI first performs fresh maintain admission under runtime fence; only its private validated scope reaches the paired
runner. As accepted Stage2, an admitted cleanup may finish after later caller revocation; no new read/source authority.
No membership/auth/secret lookup in definer. Counts/outcome return only to trusted CLI, never audit/financial data.
Recover/cleanup allow DISABLED or advanced lifecycle in the same immutable synthetic binding; no reactivation or source.
If any ACTIVE exists, cleanup returns BUSY even expired; recover first. Missing State is a no-op, never initialized.

Runner sets statement_timeout=10000ms and lock_timeout=1000ms transaction-locally before any lock/function call. Enforce
an original 10s whole-transaction deadline including pool/lock waits with remaining SQL timeout and pre-COMMIT check;
no timeout reset or work after cancellation. Timeout returns POWEROFFICE_CLEANUP_TIMEOUT and rolls back everything;
other fixed failures return POWEROFFICE_CLEANUP_FAILED. No automatic loop/retry. Delete expired snapshots first, clearing
current snapshot pointer atomically with safe audit, then old unreferenced terminal attempts. Combined max1000 deleted
rows/call; bounded indexed candidate selection before materialization, recompute scoped morePending on eligible rows.

BEFORE DELETE guards apply to every deleting role including definer: Snapshot expiresAt<=DB clock AND no State pointer;
Attempt terminal AND completedAt<DB clock-30days AND unreferenced by any Snapshot or State active/lastAttempt/lastCompleted
pointer. ACTIVE/unexpired/referenced deletes refuse. State itself is never deleted, nextSequence never reset. Last-attempt
and last-completed metadata may retain at most two terminal rows beyond30days. Audit failure/timeouts roll pointer/deletes
back. Runtime has no DELETE, definer has no identity/history UPDATE. Expiry is enforced at read time even if cleanup fails.

A connection with1000 retained attempts refuses new sync with SYNC_LIMIT until eligible rows are removed; lifetime growth
is bounded operationally by explicit cleanup. Runner and runtime must target the same DB verified without logging URLs;
runner capability is limited to trusted CLI, never arbitrary app process. Provision only in disposable tests until separate
pilot admission. Old upgrades/reports/fixtures,20 installed migrations+lock,19 earlier normative files stay byte-exact.
