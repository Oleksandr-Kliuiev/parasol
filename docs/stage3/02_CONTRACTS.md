# Stage 3 contracts — RC4

## Authority and command exposure

New same-client permissions: actions:read, actions:request, actions:approve, actions:execute. Every command additionally
requires context:read. Memberships never merge. No workspace/admin permission implies these rights.
- action-preview --input: request+read; non-persisting admission preview of a new intent.
- action-request --input --hash: request+read; store or retrieve idempotently.
- action-get/action-list: read; safe summaries only. action-get --request --preview-file additionally exports stored exact content.
- action-approve --request --hash --preview-file and action-reject: approve+read; requester cannot approve self.
- action-revoke: approve+read, original approval signer only. action-cancel: request+read, original requester only.
- action-execute/action-verify/action-recover: execute+read. No HTTP action endpoint or executable read-Gateway tool is added.

Trusted CLI authenticates the bearer; it passes an opaque private action credential, never an input Actor. Current credential,
ACTIVE Actor and membership are re-read inside each fenced admission transaction. Signers store verified token ROW IDs and
immutable nullable expiry snapshots, no token digests. Original token usability follows from unchanged epoch + DB-clock expiry
(03 explains the proof); no signer-token SELECT policy or descriptor lookup is added. Fresh current bearer uses existing auth.
Unknown token -> ACTION_AUTHENTICATION_FAILED; do not invent an actor for an audit. Unauthorized client/missing grant ->
exactly one workspace SecurityAuditEvent, SCOPE_DENIED/PERMISSION_DENIED, no client audit or dispatch. Authorized policy
refusal -> safe client audit. Audit failure rolls back effects. No raw exception text in either case.

## Deterministic preview, intent and request ordering

Input contains only connectionId, title, description, idempotencyKey (UUID). Client is trusted command scope. Validate Unicode
and normalize NFC/trim BEFORE hashing; reject lone surrogates before encoding. Server derives request UUID from first 16 bytes
of SHA256(canonicalJson({dto:"action-id/1",workspaceId,clientId,requesterActorId,idempotencyKey})), then sets RFC variant and
UUIDv8 bits (122 hash bits remain). Marker: [Atlas:<derived UUID>]. Collision with a different request is refused, never adopted.
Canonical fields: DTO version, request/scope, type/version, requester Actor/token ROW ID/expiry snapshot, scoped Connection/system/customer key,
lifecycleVersion, secretRef digest, authorityEpoch, policy/port versions, MOCK, complete normalized marked title and description.
Canonical hash uses existing canonicalJson + SHA256. No token digest/secret is stored in canonical input or action rows.

New intent preview takes the authority fence and evaluates current binding/authority/policy; its private file shows exact body,
marker and hash. It grants no authority. action-request re-evaluates the same snapshot and requires matching --hash.
Changed preview -> ACTION_PREVIEW_STALE. Token rotation changes the new canonical snapshot; it never silently rebinds an old request.

Ordering for action-request and input preview: syntax validation -> fresh current request/read/context authority -> same-requester
idempotency lookup -> compare normalized USER intent. Existing key + different intent -> IDEMPOTENCY_CONFLICT.
Existing key + same intent returns the original immutable request/hash/state, even after token rotation, binding/epoch changes,
stale but syntactically valid --hash, or terminal state. Return idempotent:true and current validity hint; do not change state,
renew expiry, replace binding/credential, create approval or authorize execution. This is retrieval, not fresh admission.
Only a missing key executes the new binding/epoch/preview-hash admission. A new key and new approval are needed after invalidation.
An existing intent's input preview exports the stored body/hash, not a newly derived snapshot. Stored export needs only read/context.

## Exact protected preview and approval

Stored preview is rendered from immutable ActionRequest, not caller content or a requester-supplied file. Exact whitelist:
kind STORED_ACTION_PREVIEW, DTO version, request ID, workspace/client/Connection local IDs, action/policy/port versions, MOCK,
title, description, marker, inputHash. Exclude customer key, secretRef, token IDs/digests and raw DTOs. No mutable status fields.
An approver with approve/read/context and no request permission can export this file through action-get --preview-file.
At approve, trusted code reads the bounded preview JSON and compares EVERY exported field with the projection of the loaded
stored request, plus expected --hash. Tampered, stale/different-client or substituted material -> APPROVAL_PREVIEW_MISMATCH;
wrong hash -> APPROVAL_HASH_MISMATCH. Current authority and hash must still pass. This validates exact content; it cannot prove
human attention and does not treat the file as a grant. Repeated approval by the same signer returns its existing decision only
when request and decision are still APPROVED, exact stored content/hash and current authority match. This APPROVED replay
is the sole non-pending exception: no new decision, audit effect or expiry renewal. Other signer/decision and CONSUMED, REVOKED,
REJECTED, CANCELLED, EXPIRED or INVALIDATED refuse; a fresh approval is allowed only on AWAITING_APPROVAL.

For export, --preview-file must be an absolute NEW path. Canonicalize its existing parent via realpath; refuse current checkout/descendants
or any ancestor with a .git marker (including worktrees). Open canonical-parent/basename with O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW,
0600; refuse existing files/symlinks. fchmod0600 on the opened descriptor to override restrictive umask; require effective-uid
ownership and link count1 via fstat. Write fully, fsync, close; failure reports a fixed output code. Trusted local filesystem is
required (hostile concurrent directory renames are outside this slice). Do not print the path or content. Approval input is a
file opened O_RDONLY|O_NOFOLLOW, then fstat for regular type, exact0600, effective-uid owner, link count1 and size≤16KiB
on that descriptor before bounded
read+strict JSON validation. Never lstat-then-reopen. Same protected reader applies to --reconciliation-file: whitelist kind
ACTION_RECONCILIATION_CANDIDATE, dto action-candidate/1, requestId and one candidateTicketId. Candidate ID never appears in
argv, stdout or audit; action-verify takes this optional file, not a raw ID flag. Neither file supplies authority. No automatic
preview export through stdout/get/list.

## Authority epochs, approval and reservation

Request stores current workspace authorityEpoch, which is included in its immutable hash. Approval stores that SAME epoch;
approval/reservation require current fence version equal to it. Any protected owner mutation permanently invalidates every
unreserved intent/approval in that workspace, including remove-then-restore or disable-then-enable and token rotation.
This conservative workspace-wide invalidation is intentional; unrelated authority mutations may require fresh requests.
No later restoration can revive the old epoch. Read/retrieval can display stale intent without renewing it.

Approval binds exact request/hash/type/policy/port/mode/binding/epoch, signer Actor/token ROW ID, decision time and expiry.
TTL is 15 minutes from DB clock, capped by both immutable signer token-expiry snapshots. Reservation checks current requester
request/read/context, approver approve/read/context, executor execute/read/context, ACTIVE actors, original/current tokens,
expiry, epoch and exact binding. Deployed policy/port versions must exactly equal stored versions at approve/reserve and
every new verification admission. Drift refuses with ACTION_CONTRACT_VERSION_CHANGED; before reservation commit INVALIDATED,
after reservation preserve established outcome/latch. Owned continuation still records original facts. Use clock_timestamp AFTER locks. No row-lock on Connection; plain read behind fence suffices.
Consume approval + insert unique attempt + request state + client audit in ONE transaction before port access.
Commit is the authorization linearization point: revoke/cancel/authority/binding changes winning the fence first prevent it;
later changes cannot retroactively cancel that already authorized bounded attempt. Permit expires before actual invocation.

Explicit revoke: original signer, fresh approve/read/context, exact request/hash; APPROVED -> REVOKED request and approval +
audit atomically. Repeated own revoke returns stored revoked result, no mutation. Another signer refuses even with approve grant.
Requester cancel before reservation -> CANCELLED; an approved decision becomes REVOKED atomically. Reject pending request ->
REJECTED. Guard detecting epoch/token/actor/membership/binding loss -> terminal INVALIDATED and unconsumed approval REVOKED
with safe code/audit. Expiry -> EXPIRED (unconsumed approval REVOKED). Invalidation is committed as a decided outcome, not then
rolled back by throwing inside the transaction. AWAITING_APPROVAL may also invalidate. These terminal requests cannot re-approve.
Any cancel/revoke/reject after reservation returns ACTION_ALREADY_RESERVED; it never claims an effect was prevented.

## Public output and fixed errors

Output: local request/approval/attempt IDs, statuses, times, hashes/versions/counts, validity hints, synthetic:true. Private result
Ticket ID stays in protected continuation/reconciliation material, never audit/stdout. No bodies, customer/token IDs, refs or digests.
AUTH codes above retain baseline workspace denial semantics. Action codes include ACTION_MODE_DISABLED/REFUSED,
ACTION_CONNECTION_REFUSED, ACTION_INPUT_INVALID, ACTION_PREVIEW_STALE, ACTION_OUTPUT_INVALID/FAILED, IDEMPOTENCY_CONFLICT,
APPROVAL_SELF_REFUSED, APPROVAL_HASH_MISMATCH, APPROVAL_PREVIEW_MISMATCH, APPROVAL_NOT_VALID, ACTION_AUTHORITY_CHANGED,
ACTION_FENCE_NOT_READY, ACTION_CONTRACT_VERSION_CHANGED, ACTION_PUBLICATION_CONFLICT, ACTION_STATE_CONFLICT, ACTION_ALREADY_RESERVED, ACTION_RECOVERY_NOT_DUE, ACTION_DB_CONFLICT,
ACTION_NOT_DISPATCHED, ACTION_OUTCOME_UNKNOWN, ACTION_VERIFICATION_BUSY/FAILED/BUDGET, ACTION_AUDIT_FAILED.
ACTION_AUTHENTICATION_FAILED and UNEXPECTED_ERROR are also fixed codes. ACTION_RECOVERY_NOT_DUE means grace has not elapsed. SQLSTATE 40P01/40001 (including Prisma P2034) -> ACTION_DB_CONFLICT,
zero pre-dispatch effects; no automatic pre-dispatch retry. Post-dispatch fact publication alone may re-attempt its transaction
up to3 times on known rollback 40P01/40001, same captured facts/token, zero port calls and no lease/deadline extension (04).
After budget returns ACTION_PUBLICATION_CONFLICT and leaves stored outcome for recovery. Unknown exceptions -> fixed
UNEXPECTED_ERROR, no values/stack/body. Map the exact known fence-trigger failure to ACTION_FENCE_NOT_READY also at accepted
bind/Stage1 activation/M365 activation/m365-disable and owner-seed boundaries; never pass arbitrary SQL diagnostics.
