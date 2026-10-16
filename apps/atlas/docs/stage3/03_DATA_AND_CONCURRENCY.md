# Stage 3 persistence and concurrency — RC4

Add new migrations + prisma/actions.prisma; preserve every frozen migration and reserved legacy Approval row/model.
S3-A extends ClientMembership_permissions_check by new DROP/ADD CHECK with the existing vocabulary plus all four action
permissions; no existing permission removed or semantics widened.
Legacy Approval never authorizes these actions; existing read Gateway stays write-denying.

## Models and immutable columns

ActionRequest: scoped UUID PK; requester Actor/token ROW ID + immutable nullable requesterTokenExpiresAt (no digest);
scoped Connection FK; idempotency key/user-intent
hash; immutable canonical input/hash/type/policy/port/mode/binding/authorityEpoch; state/timestamps/private ticket ID/safe code.
Unique (workspace,client,requester,idempotencyKey); derived UUID collision never adopts another request.
ActionApproval: scoped request FK; unique request; signer Actor/token ROW ID + immutable nullable approverTokenExpiresAt;
immutable request hash/version/epoch/decision
identity; mutable decision APPROVED|REJECTED|REVOKED|CONSUMED and consumedAt; fixed approvedAt/expiresAt. DB rejects self-approval.
ActionAttempt: scoped request FK; unique request for lifetime; random immutable attempt token/nonce/reservedAt/startDeadlineAt;
state RESERVED|NOT_DISPATCHED|UNKNOWN|CREATED|VERIFIED|MISMATCH; immutable-once private original and verified ticket IDs;
safe codes/timestamps; request private result ID can be set once only by successful verification;
verificationCount 0..3 and monotonic verificationSeq; nullable activeVerificationToken/startedAt/deadlineAt/candidateID;
verification state IDLE|ACTIVE|FAILED|ABANDONED|VERIFIED|MISMATCH. Current claim fields mutable, attempt identity never reset.
ActionVerification: scoped attempt FK; PK ordinal1..3; immutable targetKind ORIGINAL|CANDIDATE, nonce/candidateID/startedAt/
deadlineAt/request hash/create nonce;
state ACTIVE|FAILED|ABANDONED|VERIFIED|MISMATCH and completion time/safe code. Partial UNIQUE scoped attempt WHERE state=ACTIVE
enforces one active row. No reset or replacement of consumed ordinal.
ActionMockTicket: scoped Connection FK/UUID, constant S3_SYNTHETIC, customer key, marked title/body/time. Immutable independent
commit, no deduplication by marker. Not ExternalEntity/RawEvent/ResourceSnapshot; never read by baseline context or live evidence.
ActionAuthorityFence: workspaceId FK/PK and monotonic version. Runtime SELECT ... FOR UPDATE locks the one exact row,
using UPDATE(workspaceId) privilege; never a no-op UPDATE or shared/key-share lock. Cannot change workspaceId/version.
All scoped relations use composite FKs including workspace/client; actor/token identities use workspace-scoped composite FKs.
Referenced token rows cannot be deleted: revoke or replace with a new token row; retain old signed identity. Unreferenced tokens
keep prior lifecycle. Prisma adds required back-relations to existing schema files, no destructive model rewrite.

New tables use ENABLE+FORCE RLS. Runtime policies: workspace/client for client rows, workspace for fence. Runtime has SELECT,
INSERT only where services create rows, column-limited mutable UPDATE, no DELETE/TRUNCATE. Fence runtime has SELECT and only
UPDATE(workspaceId), no INSERT/version UPDATE. Identity/intent/epoch/nonce fields and mock contents immutable via grants/triggers.
Fence BEFORE INSERT requires initial version0; BEFORE UPDATE requires unchanged workspaceId and version=old+1, including
for definer. BEFORE DELETE and statement BEFORE TRUNCATE refuse all roles. Owner DDL bypass is outside supported operation.
Existing baseline FORCE setting is unchanged; owner test fixtures create auth/Connection rows before runtime action services.
Do not assume unscoped non-superuser owner can read/insert new FORCE tables; migration initialization is before FORCE is enabled.

## Original credential validity without a new database surface

Preserve accepted ApiToken grants/RLS and bearer-hash authentication verbatim. No actor/workspace SELECT policy, descriptor
view/function or persisted token digest. Current bearer is hashed only in memory; fenced admission repeats accepted auth,
resolves ACTIVE actor/membership/current token ROW ID and exact nullable expiresAt. All GUCs remain transaction-local.
Request and approval snapshot their actual verified current token ROW ID/expiry immutably at signing, after the fence.

Proof: the original token was usable and belonged to its signer at signing. Every owner auth INSERT/UPDATE/DELETE increments
that same workspace epoch before commit, including revoke/replace/expiry changes and remove+restore. Equal current epoch
therefore proves the original token/actor/membership/binding have not mutated. DB clock < captured expiry (null means no
expiry) handles time-based loss without mutation. Epoch mismatch always invalidates; expiry extension cannot renew old intent.
Original tokens need no row lookup. Existing Actor/membership scoped reads may recheck signers using stored actor identities,
then restore current caller context, but ApiToken remains digest-gated. Fresh executor/current caller is reauthenticated under
that same fence, including clock expiry. Guard equality/expiry must precede any approval/reservation. Idempotent retrieval
never recaptures epoch/token/expiry. Tests must prove this implication, not rely on application SELECT projection.

## Privileged fence surface, initialization and ACL

One trigger-only function public.atlas_action_authority_fence(), SECURITY DEFINER, owned by a NEW dedicated
atlas_action_fence_definer (rendered unique name per disposable DB). NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS,
NOCREATEDB/NOCREATEROLE/NOREPLICATION; no member-of roles; no relation ownership. Existing cleanup definer/grants unchanged.
Only trusted migration owner may have creator membership ADMIN+SET, never INHERIT (same controlled PG16+ exception as cleanup
provisioning). Runtime and all other roles have no membership/SET path to fence definer.
Exact definer grants: schema USAGE; fence SELECT(workspaceId,version), INSERT(workspaceId,version), UPDATE(version); no DELETE,
no other relation/sequence/function privileges. Fence FORCE policies TO that exact role allow these operations USING/WITH CHECK
true; runtime policy remains workspace-scoped. Role has no access to Actor/tokens/membership/client action content.
Function search_path=pg_catalog,pg_temp; ALL relations/functions referenced fully qualified public or pg_catalog. PUBLIC and
runtime EXECUTE revoked; trigger-only return type, no ordinary callable wrapper. Create triggers as trusted migration owner
before transfer/revoke: PostgreSQL checks EXECUTE at trigger creation, not firing, so runtime Connection updates still work.
No dynamic SQL or caller workspace argument.

Migration creates fence and populates existing Workspace IDs before FORCE; assert completeness there before enabling FORCE.
Roles.sql creates/validates definer, sets grants,
installs role-specific fence policies and transfers trigger function owner. Applications and owner auth/Connection mutation
must stay stopped between deploy and completed roles provisioning; startup refuses incomplete surface.
Workspace AFTER INSERT creates exactly one version0 fence from NEW.id in the same transaction, through the definer.
Workspace DELETE is explicitly refused in this slice; no fence-row deletion exists (whole disposable DB teardown unaffected).
Workspace identity moves, and workspace/client/identity moves on auth/Connection rows, are refused. Missing/collision fence
creation -> rollback, not repair by an application. Ordinary runtime cannot initialize missing fences.

BEFORE INSERT/UPDATE/DELETE on Actor/ClientMembership/ApiToken/Connection always takes/increments the SAME fence version,
even no-op or unrelated mutation: derive workspace ONLY from affected NEW/OLD row. UPDATE increments exactly one row;
GET DIAGNOSTICS row_count must equal1, otherwise raise ACTION_FENCE_NOT_READY and roll back the AUTH/BINDING mutation.
Do not use app.workspace_id for privileged trigger scope. Global version never resets; any such mutation invalidates all
unreserved requests in that workspace. S3-A installs the COMPLETE function/role/policies/triggers before fenced requests.

Roles.sql extends its role-name validation/rendering, function ownership and grants for this separate role only. Startup
facts retain every cleanup check, then check fence function exactly once, security-definer/owner/settings/ACL, exact role
attributes/memberships/privileges, exact role policy and runtime column grants, FORCE RLS, enabled four mutation triggers +
Workspace insertion/deletion triggers. Every new action table joins PROTECTED_TABLES with exact SELECT/INSERT and mutable
UPDATE-column allowlists, no owner/bypass/TRUNCATE/DELETE; broad default grants fail startup, like existing M365 checks.
Exact runtime fence ACL is SELECT + UPDATE(workspaceId), no INSERT or version UPDATE:
startup refuses the broad default grants left between deploy and roles.sql. Do not claim runtime checks global row completeness.
Trusted roles provisioning counts Workspace as migration owner, then SET LOCAL ROLE to fence definer to count all fence rows
under its role-specific true policy, restores owner and asserts equal counts (PK + FK make this exact). Controlled creator SET
membership is used only here, no runtime SET path or Workspace grant to definer. Missing backfill fails provisioning.
Every scoped admission locks exactly one matching fence row or returns ACTION_FENCE_NOT_READY; no empty-scope global assertion.
Mutation admission also refuses an invalid privileged
surface. Owner DDL that disables triggers is outside supported operation and is detected by those checks.

## Locking and atomic outcomes

READ COMMITTED: authenticate workspace hint -> SELECT matching fence FOR UPDATE -> recheck current credential/signers/binding/epoch -> request ->
approval -> attempt -> verification ordinal. Do not row-lock Connection/auth rows; plain reads behind fence are sufficient.
Other workflows may hold their row before firing a fence trigger: DB deadlock/serialization abort is ACTION_DB_CONFLICT,
whole pre-dispatch transaction rollback, zero port calls; no automatic retry. Cross-workspace moves are prohibited.
Clock_timestamp is evaluated after locks. No port call inside any transaction.

All post-dispatch fact publications lock request → attempt → verification ordinal, never fence/approval/auth/Connection.
Admission/recovery retain fence → request → approval → attempt → ordinal. A publisher never acquires an earlier lock after a
later one. No port call during either transaction; publications do not mutate approvals.
Request/audit, approval/audit, terminal denial/audit, consume+reservation/audit, each result/audit are atomic. Guard invalidation
is a committed terminal outcome; caller returns failure after commit instead of throwing away the persisted invalidation.
Private continuation handles minted on reservation can record owned create facts after signer revocation; no new invocation
or verification authority. They never leave trusted composition/capability map. New user reads/recovery verify fresh authority.
Existing bind, Stage1 activation, M365 activation, m365-disable and owner seed now depend on healthy fence provisioning.
Upgrade tests cover each accepted path with healthy and missing/invalid fence, including exact safe failure mapping. Emergency
local disable also fails closed if the fence is corrupt; owner must take service offline and use a separately reviewed trusted repair
with monotonic epoch preserved. No bypass/automatic reset or new repair CLI in this slice. Record dependency in RUNBOOK at S3-A.

Test observation: auth/Connection setup through migration owner; action/mock rows observed via confined runtime under explicit
workspace/client scope, counts compared there. Empty-scope runtime sees zero rows; trusted provisioning count checks global
fence completeness using controlled definer SET role only. Nonsuperuser owner is not used to inspect FORCE action tables.
No purge runner is introduced: synthetic RLS-confined content retained; actual retention/erasure is required in future LIVE amendment.
