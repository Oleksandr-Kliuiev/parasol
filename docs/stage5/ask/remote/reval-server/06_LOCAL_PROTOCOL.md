# Closed local protocol and terminal observations

This module completes the interfaces in01–05. All schemas are exact, required-key objects. It adds no
inference/activation/financial mutation and never relaxes raw-handoff current authority or cleanup.
Common UUID/Dec64/Time/CaseId/fixture bounds are in01; byte/deadline limits are in04. `Token` below is a
256-bit OS-random canonical43-character base64url secret, transient only. No arbitrary JSON/error strings.

## Roles, channels and sequences

Use separately authenticated, measured local connections for owner CLI(O)->controller(C), instrument(I)->C,
C->server evidence bridge(S), and S<->I transient handoff. The C->S connection is independent of browser
pair/credential authority and survives its revocation for SAFE metadata collection. O and I capabilities
are selected from verified peer identity and the owner's explicit connection registration, never a `role`
field, command-line assertion, copied token or the requested operation. A C command cannot acquire an owner
credential by delegation from I. The raw S<->I connection is never accepted as an O/C command channel.

Each connection has an OS-bound random connectionId and two independent positive Dec64 send sequences,
starting at1. Every frame consumes its sender's NEXT sequence exactly; no gaps, reuse or wrap. New connection
means new ID and loss of outstanding operations, never resuming/resending them. An operation request supplies
an independent fresh UUID challenge; its one response must echo that challenge and the request sequence.
There is at most one outstanding command per connection. Response meaning is checked against the outstanding
operation, not merely its `kind`. A trusted bridge forwarding a safe response creates a NEW outer frame on
its own connection and preserves the original server observation binding inside the payload.

Exact safe request:
`{contractVersion:'RevalOwnerCommandV1',registrationId,serverBootId,connectionId,challenge,sequence,
operation,payload}`.
Exact safe response (supersedes the incomplete envelope in RC1):
`{contractVersion:'RevalOwnerEvidenceV1',registrationId,serverBootId,connectionId,challenge,sequence,
requestSequence,observedAt,emitter,databaseInstanceId,kind,payload}`.
All IDs are UUIDs, sequences positive Dec64; observedAt real Time. A saved timestamp/sequence is not freshness
by itself. Body cap256KiB; command timeout2s. A FAILURE payload is exactly `{code:<FailureCode>}` below.
emitter is CONTROLLER|SERVER and identifies the ORIGINAL payload producer, not the final IPC hop.
SNAPSHOT/FIXTURE_CHECK/PLATFORM_PROOF/PRIVACY_PROOF/CLOSURE are CONTROLLER. PROCESS_CENSUS,
TERMINAL_OBSERVATION/ARM_ACK/OBSERVATION_ACK are SERVER; forwarding by C preserves that origin.
PAIR_ACK is CONTROLLER for owner initiation/end and SERVER for server installation/end acknowledgement.
DRAIN is CONTROLLER composition: its process/commit/owner gauges come from SERVER and its DB/platform
coverage from the controller's independent adapters; do not call server gauges independent measurement.
IDENTITY delivered to O/I is CONTROLLER measurement; the inner C->S acknowledgement is SERVER and cannot
self-assert MEASURED. FAILURE identifies the principal that detected the fixed failure. C rejects producer/
kind mismatches before forwarding. databaseInstanceId is the immutable physically verified registration UUID
from01 in EVERY response, not a caller-supplied hint. The source DB socket/identity is controller-checked.
Saved emitter/provenance is allowlisted metadata, never a substitute for the independent platform proof.

| operation / exact payload | Permitted sender -> receiver | Response kind |
|---|---|---|
| IDENTITY / `{}` | O->C, I->C, C->S | IDENTITY |
| SNAPSHOT / `{}` | O->C, I->C; C uses its confined DB reader | SNAPSHOT |
| PROCESS_CENSUS / `{}` | O->C, I->C, C->S | PROCESS_CENSUS |
| TERMINAL_OBSERVATION / `{armId}` | O->C, I->C, C->S | TERMINAL_OBSERVATION |
| DRAIN / `{}` | O->C, I->C; C composes DB plus authenticated PROCESS_CENSUS | DRAIN |
| PLATFORM_PROOF / `{}` and PRIVACY_PROOF / `{}` | O->C, I->C; closed local evidence adapters | corresponding proof |
| FIXTURE_CHECK / `{}` | O->C only; bounded verifier in03 | FIXTURE_CHECK |
| PAIR / `{instrumentControlConnectionId,instrumentHandoffConnectionId}` | O->C only | PAIR_ACK plus separate secret frame below |
| END_PAIR / `{pairId}` | O->C; I->C for ITS own pair; C->S | PAIR_ACK |
| ARM_CASE / `{caseId,fixtureId,fixtureGeneration,admissionId,policyVersion,preSnapshotId,browserPairId}` | I->C under the explicit operator GO command; C->S after all controller checks | ARM_ACK |
| PAUSE_EXPORT / `{admissionId,expectedPolicyVersion,policyFloor,fenceFloor}` | O->C only; short-lived owner executor in01 uses existing owner DB routine; no resident owner credential in C | CLOSURE |
| OBSERVATION_COLLECTED / `{armId,observationId,revision}` | C->S only AFTER C durably saves that safe observation | OBSERVATION_ACK |

These are the complete ordinary command directions; all others return WRONG_DIRECTION/OWNER_REQUIRED before
any DB/slot change. I cannot PAIR another peer, FIXTURE_CHECK, PAUSE_EXPORT, provision/switch fixtures, activate,
settle, refund, or supply DB credentials. END_PAIR cancels measurement, not the policy or admitted work.
ARM_CASE arms measurement only; it never clicks Ask or grants authority, and cannot be issued by O in place
of the registered instrument's GO checks. C->S commands are narrowed forwards of these checks, not a generic
execute/fetch primitive. Fixture provisioning is the separate offline owner operation in03, not this IPC.
ARM_CASE eligibility and the non-resetting I/C/S case sets are exact in04: the first current GO has already
consumed its case and may issue ONE arm frame. An older/prior-consumed case, repeated frame/case or lost ACK
cannot arm again. Existing envelope sequence/challenge binds that issuance; no new DTO authority is added.

PAIR_ACK exact `{pairId,expiresAt,paired}`: pairId UUID, expiresAt Time, paired boolean.
For PAIR, C reserves pairId before browser pairing and returns the reserved nonce expiry with paired:false;
the later browser PAIR200 establishes its own bounded actual pair expiry. END_PAIR returns paired:false and
the known actual pair expiry, or reserved nonce expiry if the browser never paired. An unknown pair fails;
no null/fabricated expiry or secret enters the safe ACK. ARM_ACK is the object in04. CLOSURE payload is EXACTLY the four-key object in02; the
transport wrapper is kept separately and never inserted into that object. OBSERVATION_ACK exact
`{armId,observationId,revision,collected:true}`; it acknowledges ONLY that revision, not future observations.
The remaining response payloads are exactly01–05 or the terminal object below. No extension keys.

Pair secrets are excluded from both ordinary command and safe response schemas. After authorized PAIR, C
sends a separate exact private frame to O and separately to S:
`{contractVersion:'RevalPairSecretV1',registrationId,serverBootId,connectionId,sequence,challenge,
requestSequence,pairId,instrumentControlConnectionId,instrumentHandoffConnectionId,pairingNonce,expiresAt}`.
This is <=2KiB, once per target connection, tied to the authorized PAIR request/bridge challenge; nonce is a
Token, expiry<=120s. On C->O, challenge/requestSequence echo the pending owner PAIR; the secret follows its
PAIR_ACK on the next C send sequence within that same2s operation, then closes that two-frame response.
C->S is a restricted installation request with a fresh challenge and requestSequence===sequence; S returns
one ordinary PAIR_ACK echoing that sequence/challenge. S never forwards the secret to I. O displays it only in its protected raw TTY.
No safe persistence schema accepts this contractVersion or any nonce. No extra ordinary control command
can install a secret. Browser sessionToken/receiptNonce stay solely in the browser/S flow in04.

## Original-task terminal observation (safe, independent of raw handoff)

At the unscoped ingress claim in04, reserve bounded observer capacity; only AFTER ordinary scoped
authentication AND exact registered workspace/client/actor equality in04 create the Binding/safe original-task
record, still BEFORE provider work. Pre-authentication
failures produce aggregate unscoped census evidence only, not an invented terminal observation. The
observer latches a fixed adapter fault synchronously when the accepted validation/circuit verdict occurs,
BEFORE awaiting settlement/publication/pause. It consumes existing verdicts only; it does not read/parse late
provider content after the original deadline or alter the private dispatch proof. Its failure cannot disable
the required circuit/pause. Missing observation coverage blocks credit and further arming.

`Binding` is this exact reusable object:
```
{registrationId,serverBootId,guardEpoch,handoffConnectionId,pairId,armId,taskId,caseId,
 fixtureId,fixtureGeneration,admissionId,policyVersion,preSnapshotId,correlationId}
```
All ...Id and guardEpoch are UUID except frozen CaseId/fixtureId; fixtureGeneration and policyVersion are
positive Dec64. TaskId is server-random per claimed task, distinct from untrusted requestId; correlationId
is the server UUID. Registration uniquely binds the immutable workspace/client/actor scope in01; every consumer compares it
with its independent registered mapping. These capture the ORIGINAL arm/task/authority context. They cannot be reassigned when
policy, browser pair or owner connection changes. A failure before such scoped binding exists has NO
invented Binding/terminal record; it remains an aggregate unattributed guard observation in05.

Exact TERMINAL_OBSERVATION payload, <=8KiB:
```
{contractVersion:'RevalTerminalObservationV1',observationId,revision,binding,
 detectedFault,detectedAt,reservation,settlement,attemptId,publication,
 physicalOwnerReleased,final}
```
observationId UUID; binding is Binding; revision integer1..16 (increments on observed state change, never on
reads); detectedAt Time|null; flags boolean. detectedFault is exactly NONE|MODEL_OR_TIER_MISMATCH|
USAGE_INVALID|UPSTREAM_AUTH|UPSTREAM_INVALID. NONE requires detectedAt:null; a non-NONE fault and its first
real detection time latch forever. It is a detected fixed verdict, never an intended/delivered HTTP code.
An upstream401/403 configuration verdict maps to UPSTREAM_AUTH without storing status/body/header; generic
429/5xx/transport UNAVAILABLE never maps to it. Refusal/envelope/intent-content rejection maps to
UPSTREAM_INVALID only when the accepted adapter actually reaches its ASK_REMOTE_INVALID verdict.

reservation is NONE_CONFIRMED|COMMITTED|COMMIT_UNKNOWN; settlement is NOT_ATTEMPTED|CONFIRMED|
FAILED_KNOWN|COMMIT_UNKNOWN. These record the original task's observed transaction outcomes, not a guessed
DB state. attemptId is UUID|null (null unless a committed attempt was actually identified). A later DB read
is independent accounting evidence and does not rewrite an unknown original commit acknowledgement.
Neither these enums nor a captured attemptId reconstruct a dispatch/no-dispatch/refund capability.

publication is exactly `{state,kind,status,code}`:
- state NOT_ATTEMPTED|PENDING|FAILED requires kind:NONE,status:null,code:null. A candidate/desired error or
  successful phase2 alone does not become a completed public response. Failed audit/serialization/disconnect
  before observed HTTP completion remains NOT_ATTEMPTED/FAILED as applicable.
- state SERVER_FINISHED requires kind ANSWER or ERROR. ANSWER requires status200/code:null and completed
  accepted current-authority publication. ERROR requires the actual fixed PublicError/status mapping below.
  Set this only on the server HTTP writer's completion observation for that exact outgoing reply.
  SERVER_FINISHED means the server completed its HTTP write; it does NOT prove browser receipt/display.
- Browser receipt of those values is separately established only by a bound transient transfer. A public
  error can differ from the detected fault, e.g. detected MODEL_OR_TIER_MISMATCH followed by public504.

physicalOwnerReleased becomes true only on actual underlying task/DB/transport/pause cleanup. final:true
requires that release and a terminal publication state (never PENDING). No later revision after final.
Changes are captured from the original measured task only, <=16 revisions/task; excessive updates are a
protocol/coverage failure, never eviction of a known fault. Repeated reads do not extend retention.

Pair revocation, loss of browser authority, raw120s expiry, failed/unknown settlement, handoff failure or
public-response failure DOES NOT delete or suppress this SAFE record. The owner evidence channel may read
it after raw access is denied because it authorizes registered accounting/safety metadata, not source/body
access. Current-authority raw cleanup in04 remains immediate. No new runtime audit/log/ledger column is
added for this record; it goes only through the closed owner evidence/receipt path.

S retains at most four active-task records plus one completed uncollected record; it refuses a new arm while
the prior case's required metadata/POST census is uncollected. Safe records contain no raw object/reference.
Retain through final and until C acknowledges durable collection of the latest final revision, with a hard
10-minute monotonic limit AFTER actual physical release. Expiry of an uncollected record increments the
sticky uncollectedTerminalCount and makes guard coverage UNKNOWN; never turn it into a zero/no-fault claim.
Active physical ownership retains its bounded record. Crash/lost continuity before collection remains UNKNOWN.

For each requested observation C validates S's fresh authenticated response and atomically saves ONLY the
closed safe record/provenance before forwarding it or sending OBSERVATION_COLLECTED. Journal cap32MiB,
max200 cases x16 revisions x8KiB; no raw/secret frames or arbitrary strings. Save failure returns
METADATA_PERSIST_FAILED, retains S's record and stops arming. A collection ACK lost at S causes retention,
not data resubmission or inference. Explicit later metadata collection with a fresh challenge is allowed;
it cannot retry an Ask, erase an original unknown, or make a failed run resume.

Already-authenticated/saved facts remain facts if a later revision/connection is lost. A fresh export from
S requires the original live boot; an old saved record can be reviewed as historical evidence, never relabeled
fresh/current. A known latched fault is not downgraded because subsequent continuity/settlement is unknown.

Failure precedence is mandatory: any authenticated non-NONE detectedFault gives TERMINAL_FAILED even when
no raw handoff is possible and even if publication never completed; retain full/unknown financial liability
until independently established, and never grant pass/provider credit. UPSTREAM_AUTH is a known configuration
fault; ordinary UNAVAILABLE without such a verdict remains TERMINAL_INCOMPLETE. A missing record does not
prove NONE. Known authentic claim/safety failure or unreachable semantic threshold also retains its stronger
FAILED state. Metadata proves neither semantic success nor a received answer and cannot supply missing credit.

## Exact transient transfer and acknowledgements

Raw S<->I messages use a SEPARATE versioned decoder/module and socket capability. They are NOT a `kind` or
payload of RevalOwnerEvidenceV1 and cannot enter that schema/persistence API. Sequence rules above apply
independently in each direction. One pending raw transfer per arm; both parties bind the measured peer.

After ARM_ACK and before displaying GO permission, I sends exactly one ready frame to S:
`{contractVersion:'RevalTransientReadyV1',registrationId,serverBootId,connectionId,sequence,challenge,
pairId,armId,caseId,fixtureId,fixtureGeneration,admissionId,policyVersion,preSnapshotId}`.
connectionId is the pair's registered handoffConnectionId; it must be the same I process as the control
connection. challenge is fresh UUID, valid only for this arm until the earlier of raw120s expiry/pair loss.
READY is measurement readiness, never permission to invoke Ask. No body or label is sent.
S returns exactly `{contractVersion:'RevalTransientReadyAckV1',registrationId,serverBootId,connectionId,
sequence,challenge,readySequence,armId,disposition,failureCode}` within2s; it echoes the READY challenge/
sequence/arm. disposition READY requires failureCode:null; FAILED uses a FailureCode. I must receive the
matching READY acknowledgement before GO, while the original arm/pre-snapshot remains unexpired. This
handshake does not renew the shared30s arm/PRE/GO window in04. Raw transfer later uses the next S sequence, not the READY-ACK sequence.

After the manual browser POST has passed all checks in04, S sends at most once:
```
{contractVersion:'RevalTransientTransferV1',connectionId,sequence,challenge,readySequence,
 transferId,ackChallenge,binding,bindingResult:'SERVER_VALUES_MATCHED',
 publicationAuthority,handoffAuthority:'CONFIRMED',request,response}
```
transferId/ackChallenge fresh UUIDs; challenge/readySequence echo I's READY; Binding matches every READY
field and connectionId===binding.handoffConnectionId. publicationAuthority is CONFIRMED for ANSWER,
NOT_APPLICABLE for an error; handoffAuthority describes the actual current check in04, not a browser flag.
request is exact parsed AskRequestV2; response exact `{status,correlationId,body}` with the actual matched
AskAnswerV2 or AskErrorV1. Header/body/binding correlation MUST agree. Total raw frame<=288KiB. No upstream
content, body hash/length, bearer/sessionToken/receiptNonce or expected/observed intent field outside the
accepted transient answer itself. Its binding must equal the active arm; a self-consistent foreign frame fails.

I checks the authenticated frame/binding, reruns accepted validators, and derives its own frozen-fixture
results. Exact `SafeResult`:
`{requestMatchesFrozen,semantic,schema,claims,coverage,urgency,publicOutcome,publicErrorCode}`.
requestMatchesFrozen/schema are boolean. semantic MATCH|MISMATCH|NOT_EVALUATED; publicOutcome ANSWER|ERROR;
publicErrorCode PublicError|null. For ANSWER, code=null, schema=true, claims/coverage/urgency boolean;
semantic is MATCH/MISMATCH only when requestMatchesFrozen, otherwise NOT_EVALUATED. For ERROR, schema=true,
semantic NOT_EVALUATED, claims/coverage/urgency null, and code is the actual validated public error.
This never contains observed intent, question, response data, requestId, length/hash or arbitrary reason text.
If whole validation fails, no SafeResult is constructed; it is an unverified handoff, not an invented server
schema violation. Independent terminal-fault observations still apply.

I first atomically saves an allowlisted PENDING handoff summary (bindings/transferId/SafeResult only), then
sends at most one ACK:
```
{contractVersion:'RevalTransientAckV1',connectionId,sequence,challenge,transferSequence,transferId,
 binding,commitChallenge,disposition,result,failureCode}
```
challenge echoes S's ackChallenge; transferSequence echoes S's transfer; commitChallenge is fresh UUID.
disposition ACCEPTED requires SafeResult result and failureCode:null. REJECTED requires result:null and
failureCode VALUE_VALIDATION_FAILED|WRONG_BINDING|METADATA_PERSIST_FAILED. I cannot acknowledge an unseen,
partial, expired, revoked or previously consumed frame. ACK<=8KiB. Wrong/replayed ACK burns the transfer.
An accepted ACK asserts received/validated/safely summarized values, not case pass, liability or human action.

S atomically accepts a matching ACK only while the pair/current transfer is still valid and within the same
2s end-to-end handoff deadline from the browser POST. No fresh deadline at transfer/ACK. It sends exactly one:
`{contractVersion:'RevalTransientCommitV1',connectionId,sequence,challenge,ackSequence,transferId,binding,
 disposition:'COMMITTED'|'FAILED',failureCode}`.
challenge echoes commitChallenge; ackSequence matches ACK. COMMITTED requires failureCode:null; FAILED uses
ACK_INVALID|ACK_TIMEOUT|PAIR_REVOKED|RAW_EXPIRED|IPC_LOST. Commit<=4KiB; receipt/sequence errors close the channel.
S can return browser204 once it has accepted ACK and emitted COMMITTED, but this does not prove I received it.
I accepts success ONLY after the matching COMMITTED frame and an atomic safe COMMITTED-summary save.

Exact persistable handoff summary:
`{contractVersion:'RevalHandoffSummaryV1',binding,transferId,state,result,failureCode}`.
state PENDING|COMMITTED|UNVERIFIED; result SafeResult|null; failureCode FailureCode|null. PENDING has result
and no failure; COMMITTED requires result and no failure; UNVERIFIED has a fixed failure and optional earlier
SafeResult. Only this separately constructed summary and safe terminal records/provenance reach the receipt
writer. Raw/secret/ready/ACK/commit objects are rejected even if spreading/removing a key would appear safe.
Safe bindings contain identifiers, not credentials. No acknowledgement turns verifiedPass/live eligibility true.

State order at S is AVAILABLE -> CLAIMED -> TRANSFER_SENT -> ACK_VALIDATED -> COMMITTED, or BURNED from any
nonterminal state. I has READY -> RECEIVED_VALIDATED -> ACK_SENT -> COMMITTED, or UNVERIFIED. Nonce is claimed
before comparison; one claimant wins. On timeout, expiry, revocation, bad frame or disconnect burn/drop raw
references immediately; no retry, resend, reused nonce/arm or automatic Ask. Delayed ACK/commit cannot resurrect.
If transfer arrived but ACK/commit was lost, the receiver may know its validated values but successful handoff
is UNVERIFIED; no positive case/provider credit or refund. Preserve a previously authenticated fixed fault or
truth/threshold failure as FAILED; transport uncertainty must not erase that stronger evidence. Missing or
unauthenticated data alone never creates a safety fault. After crash, saved PENDING remains UNVERIFIED.

## Closed codes

`FailureCode` is EXACTLY:
UNAUTHORIZED, SCOPE_MISMATCH, OWNER_REQUIRED, IDENTITY_UNVERIFIED, REGISTRATION_MISMATCH,
PROTOCOL_INVALID, WRONG_DIRECTION, WRONG_BINDING, SEQUENCE_INVALID, CHALLENGE_INVALID, OPERATION_BUSY,
FRAME_TOO_LARGE, DEADLINE, PAIR_UNAVAILABLE, PAIR_EXPIRED, PAIR_REVOKED, ARM_UNAVAILABLE, ARM_EXPIRED,
CASE_CONSUMED, ADMISSION_NOT_ACTIVE, POLICY_CHANGED, FIXTURE_MISMATCH, SNAPSHOT_STALE,
CENSUS_LIMIT_EXCEEDED, CENSUS_UNAVAILABLE, CENSUS_CHANGED_UNEXPECTEDLY, CONTENT_MISMATCH,
VALUE_VALIDATION_FAILED, ACK_INVALID, ACK_TIMEOUT, ACK_UNCONFIRMED, IPC_LOST, RAW_EXPIRED,
LOCAL_HANDOFF_UNVERIFIED, UNATTRIBUTED_PRE_RESERVE_FAILURE, OBSERVATION_UNAVAILABLE, OBSERVATION_GAP,
METADATA_PERSIST_FAILED, CONTAINMENT_UNCONFIRMED, DRAIN_NOT_QUIESCENT, PRIVACY_UNVERIFIED,
PLATFORM_UNVERIFIED, INTERNAL_FAILURE. Unknown system/DB/exception details map to INTERNAL_FAILURE only.
Browser handoff failures use exact `{contractVersion:'RevalBrowserHandoffErrorV1',code:<FailureCode>}`,
with no body echo. While the route is enabled, statuses are fixed: UNAUTHORIZED401,
SCOPE_MISMATCH403, FRAME_TOO_LARGE413, PROTOCOL_INVALID400, DEADLINE504, all remaining FailureCodes503.
No-store and no secret/body echo apply to every response. Ordinary disabled404 has no handoff DTO.
Unauthenticated/foreign requests expose only UNAUTHORIZED/SCOPE_MISMATCH (or ordinary404
when disabled), never internal registration state. This DTO is not an Ask provider error or an attempt result.

`PublicError` and its required status is EXACTLY the accepted19-code union:
ASK_REQUEST_INVALID400, ASK_SCOPE_DENIED403, ASK_AUTHENTICATION_FAILED401, ASK_CONTEXT_UNAVAILABLE404,
ASK_TOO_LARGE413, ASK_SCOPE_CHANGED409, ASK_BUSY429, ASK_DEADLINE504, ASK_PLANNER_INVALID503,
ASK_AUDIT_FAILED503, ASK_RUNTIME_NOT_READY503, ASK_SOURCE_INVALID503, ASK_REMOTE_NOT_ADMITTED503,
ASK_REMOTE_POLICY_CHANGED409, ASK_REMOTE_BUDGET429, ASK_REMOTE_UNAVAILABLE503, ASK_REMOTE_INVALID503,
ASK_REMOTE_MODEL_MISMATCH503, ASK_REMOTE_USAGE_INVALID503. No raw upstream status/string enters this enum.

## Required protocol checks

Strict schema round-trips/extra-key/duplicate-key rejection for EVERY contractVersion; sender/direction denial
before side effects; swapped registration/boot/connection/task/arm/case/fixture/policy/pre-snapshot/correlation;
sequence/challenge gaps/replay and delayed ACK/commit; reconnect/PID reuse; simultaneous nonce claims; all
byte/deadline limits; raw/secret object injection into persistence; owner mutation attempted from I/raw channels.
Model/tier/usage/upstream-auth/invalid faults before failed/unknown settlement, pause/revoke before handoff,
failed publication/expiry/disconnect/unacknowledged transfer; ordinary UNAVAILABLE remains distinct. Verify
safe latched fault survives every raw cleanup and known FAILED outranks unknown financial/public outcome.
