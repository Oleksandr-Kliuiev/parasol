# Stage 3 execution, verification and port — RC4

## State machine and create ownership

AWAITING_APPROVAL → APPROVED|REJECTED|CANCELLED. Before reservation, an original signer can explicitly revoke to REVOKED;
a guarded loss of authority/epoch/binding commits INVALIDATED; elapsed authority commits EXPIRED. Each revokes any unconsumed
approval. These outcomes are permanent; restoring rights or repeating an idempotency key cannot renew them.
APPROVED → DISPATCH_RESERVED atomically consumes approval and inserts its unique create attempt.
Post-reservation outcomes: NOT_DISPATCHED, OUTCOME_UNKNOWN, CREATED_UNVERIFIED, VERIFICATION_MISMATCH, VERIFIED.
No outcome returns to approval or permits a second create. Cancel/revoke/reject after reservation returns ACTION_ALREADY_RESERVED.

Reservation yields a private mode/binding/hash/create-nonce-bound capability in the trusted dispatcher map. Consume it once
before calling create, within 5 seconds and before approval expiry. A positively known local pre-call refusal publishes
NOT_DISPATCHED with zero calls; its unique attempt remains consumed. Restart cannot prove whether a reserved call occurred:
action-recover only from RESERVED at/after reservedAt+35 seconds marks UNKNOWN without dispatch; before then returns
ACTION_RECOVERY_NOT_DUE. Published CREATED_UNVERIFIED/MISMATCH/VERIFIED or NOT_DISPATCHED cannot be downgraded by create recovery.
Authorization linearizes at reservation commit; later revocation cannot retrospectively prevent that bounded approved create.
An owned private continuation can persist already-observed create facts after revocation, but grants no new create/read.

Create has a 15-second AbortSignal deadline. Port must honor it; fenced late results remain possible. Every exception,
malformed response, ambiguous failure or persistence loss after possible invocation yields OUTCOME_UNKNOWN. No automatic
retry on timeout, 429, 5xx or crash; status classes do not prove non-creation. Valid ticket ID yields CREATED_UNVERIFIED.
The initial distinct read is a separate freshly authorized verification reservation and consumes ordinal1 of the budget3;
if current caller authority/binding fails after create, retain the observed create outcome and do not invoke a read.

## Internal port, not vendor wire schema

TicketPort.createOne takes immutable normalized customer key, marked title, description and invocation nonce; returns only
bounded ticket ID. TicketPort.readOne takes that exact connection and bounded ticket ID; returns ID/customer key/marked
complete title/description and synthetic:true. No method, URL, arbitrary header or raw vendor object is accepted.
Built-in ActionMockTicket storage uses independent scoped commits, trusted MOCK composition and FIXTURE binding only.
No credentials, native fetch/HTTP libraries or user-configured callbacks. Tests inject bounded faults at the private port.

## Durable verification claims

New reads/recovery require fresh caller context:read + actions:execute in the same client. Recheck the exact stored FIXTURE
binding/lifecycle under the authority fence. After reservation, original signer revocation/epoch drift alone does not block
freshly authorized read-only investigation; it never restores create authority. Binding drift refuses new reads.
Exact ID/customer/marker/normalized complete title/body must match stored immutable intent; mutable remote status is irrelevant.
No listing/search/name matching, caller assertion or inferred ID establishes success. For UNKNOWN, one supplied candidate ID
per verification ordinal (from the protected reconciliation file) is untrusted and immutable with targetKind=CANDIDATE on
that row. Known original IDs use targetKind=ORIGINAL. A match proves this ticket matches the request, not that
no other tickets exist. Without matching evidence, UNKNOWN remains unresolved indefinitely.

Under fence → request → approval → attempt locks, claim one unused ordinal1..3. Atomically insert ActionVerification with
nonce, exact candidate ID, request hash/create nonce, startedAt, deadlineAt=startedAt+35 seconds; increment count/seq and set
active claim token/ordinal/candidate/deadline on attempt with audit. No port invocation before claim commit. Port read deadline
is startedAt+15 seconds; remaining20 seconds are persistence/crash grace, not a longer network timeout. One active claim only:
action-verify returns ACTION_VERIFICATION_BUSY while ACTIVE, including after expiry (safe recoveryRequired hint). Only
action-recover at/after deadlineAt marks ABANDONED and releases an expired claim; expiry alone cannot mint another claim.
DB partial unique index prevents two ACTIVE rows. Count includes failed, crashed and initial reads.

Result publication locks request → attempt → claim, never fence/approval, and requires exact active token+ordinal+candidate+hash+create nonce, ACTIVE row and
DB clock < deadlineAt. Otherwise discard as stale with bounded audit; never alter current outcome or refund the ordinal.
A read failure completes FAILED and clears active claim; preserve established request outcome. Mismatch completes MISMATCH
and clears claim: CANDIDATE mismatch preserves UNKNOWN (or CREATED_UNVERIFIED if a late original attached); only ORIGINAL
mismatch records VERIFICATION_MISMATCH. That outcome is non-terminal for remaining read ordinals, never for create replay.
Matching result completes VERIFIED, sets private verified ticket ID
and request result ID once, clears claim and commits outcome+audit. VERIFIED is terminal; repeated verify returns stored safe
summary with zero read. All result fields and audit commit together, so audit failure cannot create partial verified success.

If process dies after claim commit, action-recover at/after deadlineAt locks and marks that ordinal ABANDONED, clears active
claim and preserves the last established create/verification outcome. Earlier recovery returns ACTION_RECOVERY_NOT_DUE.
A later verification may use only a remaining ordinal with new nonce; three consumed ordinals return ACTION_VERIFICATION_BUDGET.
Late results from abandoned/expired claims are stale even if no replacement has started. Recovery cannot reset budget/identity.

## Late create results and candidate ordering

All create/read fact publications use request → attempt → ordinal (if any), including late original conflict handling.
Known rollback 40P01/40001 allows at most3 publication transaction attempts with the SAME in-memory result and token; no
new create/read/ordinal, no deadline extension. Stable fact identity makes a committed identical publication a no-op, with
no duplicate audit. Failure after budget leaves prior stored state/active claim for recovery and returns safe conflict code.
This exception applies only to recording already-observed facts, never admission, reservation or port invocation.
Original create ID is immutable once and publishable only by the same private original create token/nonce. Recovery never
replaces that token. If VERIFIED already names a different candidate, audit result conflict and preserve VERIFIED/result ID;
same ID may attach original provenance without downgrade. Conflicting second original ID also cannot replace the first.
If first late original ID arrives during an active candidate read and differs, atomically abandon that claim, clear its token
without refund, attach original ID and retain CREATED_UNVERIFIED. Its later candidate result is stale. Same ID preserves claim.
If no active claim or VERIFIED result, attach original ID and record CREATED_UNVERIFIED; future verification must use that ID.
Candidate input cannot replace a known original ID. These rules serialize on attempt and preserve verified facts regardless
of response ordering. Conflicts are safe audited outcomes, never justification for replay or invented upstream uniqueness.

## Live contract gate

Primary references: [Atera API FAQ](https://support.atera.com/hc/en-us/articles/11071761826844-API-FAQ) confirms ticket creation
via POST; [Using the API](https://support.atera.com/hc/en-us/articles/219083397-Using-the-Atera-API) documents token permissions
and authenticated documentation access. Official app.atera.com/apidocs was unavailable unauthenticated.
No unofficial wire schema or upstream idempotency guarantee is assumed.
Before LIVE, freeze current official create/read schema, routing/default/notification effects, HTTPS/auth/projection semantics;
obtain independent amendment reviews and explicit designated write admission; satisfy privacy/retention and recovery gates.
A LIVE flag added to this MOCK implementation does not satisfy that gate.
