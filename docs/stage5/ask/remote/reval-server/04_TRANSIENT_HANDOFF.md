# Manual browser-to-instrument evidence handoff

## Proposed fixed-surface exception

Add exactly one optional same-origin route:
`POST /clients/:id/ask/evaluation-handoff`.
It is enabled only for the measured registered synthetic sandbox and one owner-paired run. Otherwise it is
ordinary404. No query/path encoding aliases, GET, generic proxy, arbitrary destination, file upload/download,
provider call, tool, source query or account/policy mutation. It never invokes the Ask service.
Two closed operation DTOs below cover pairing and delivery; they do not extend AskRequestV2/AskAnswerV2.
The additional synthetic focus choice and registered-sandbox ingress gate below are explicit critical
amendments to the accepted browser focus/selection and Ask ingress contracts; they require fresh review.

The existing Ask POST accepts the extra opt-in header `X-Atlas-Evaluation-Session` ONLY in that registered
sandbox. A paired armed request may receive `X-Atlas-Evaluation-Receipt` on the ordinary Ask response.
Neither header travels to the provider or grants authority. The token/header exception and route need fresh
architecture/code review. They are not claimed as part of the previously accepted two-operation surface.

The browser still manually fetches capabilities and performs every per-question checkbox/Ask click under
its accepted generation guards. The instrument never consents, edits or submits the browser request, uses
a provider route, or drives a synthetic UI click. A separate manual "Send evaluation evidence" button is
available only for the current eligible completed response. This button cannot submit/retry a question.

## Pairing and arm

The nonce-entry control exists ONLY in the dedicated measured console build whose assets are sealed at
RS-C. It is a plain manual control available before pairing, not discovered through a capability flag.
AskCapabilityV2 remains byte/schema-compatible and gains no field. Its manual PAIR POST to an unregistered
server receives ordinary404; a browser checkbox, local setting or ordinary console build cannot enable the
server endpoint. The synthetic focus pane appears only after a valid bound PAIR200. No automatic PAIR probe.

The measured owner controller already binds registration, process boot and instrument connection (01).
An explicit owner `pair` command generates a one-use 256-bit base64url pairing nonce (43 canonical chars),
valid for120s, mapped to one expected workspace/client/actor/admission and instrument connection. It stays
in memory and is entered into the local browser pairing panel; no URL/query/storage/cookie/history/receipt.
Displaying the nonce is transient; terminal/session recording and clipboard managers must be excluded by
platform privacy proof. Prefer direct typing; do not copy question/answer data through a clipboard.

PAIR request body exact:
`{contractVersion:'RevalBrowserHandoffV1',operation:'PAIR',pairingNonce}`.
It uses the private existing browser bearer and an exact same-origin Host/Origin check. The server checks
current ACTIVE actor and same-membership context:read+ask:remote, scope matches owner registration and
nonce, existing credential epoch, measured boot/instrument connection, and real nonce lifetime. It reads
no source or provider key. Missing/foreign bearer, scope, nonce or origin cannot create a pair.

PAIR200 body exact:
`{contractVersion:'RevalBrowserHandoffV1',pairId,sessionToken,serverBootId,expiresAt,evaluationFocus}`.
`evaluationFocus` is the exact closed metadata object defined in the synthetic focus section below.
PAIR200 is <=2KiB. PairId/serverBootId are UUID; sessionToken is independent256-bit canonical43-character
base64url. receiptNonce below has this same Token format with independent randomness. A pair lasts at most10 minutes,
no later than the real admission expiry, and is revoked on pause/fixture generation/credential/actor/scope/
policy change, disconnect, server restart or instrument loss. One pair per registered server; no overwrite
of an occupied pair. Browser stores it in its private closure only; it never replaces or contains a bearer.
PAIR failure has a fixed code only; successful pairing does not mean policy ACTIVE or data/budget admitted.

The registered instrument sends `arm-case` to the controller under the explicit operator GO command; the
controller checks and forwards it to the measured server. This request is metadata only (directions in06):
`{caseId,fixtureId,fixtureGeneration,admissionId,policyVersion,preSnapshotId,browserPairId}`.
The controller checks the frozen case-to-fixture mapping, exact fresh complete snapshot/fixture/process
binding, current policy/headroom and the instrument's consumed-case/GO prerequisites. Only the case just
consumed by its FIRST current GO transition below may arm ONCE. Previous consumption, an older GO, a
second in-flight case or an unadmitted run is ineligible. The instrument still checks question
and focus equality IN MEMORY before GO; no expected label/question/hash is sent in this command.

ARM_ACK payload exact:
`{armId,caseId,fixtureId,fixtureGeneration,admissionId,policyVersion,preSnapshotId,expiresAt}`.
ArmId is random UUID. The reviewed future arm/PRE/GO window is30s from completion of the PRE snapshot,
measured on controller/server monotonic clocks bound by the2s challenge exchange; expiresAt is its real-time
ceiling. Use the earliest remaining limit of those30s, pair/credential/policy expiry, or UTC day/month change.
Latency/clock uncertainty subtracts from the window, never adds time. Every bridge/READY step spends this
same window. No renewal/re-arm; the accepted Ask/provider deadline remains unchanged.
This replaces the draft5s arm and requires an explicitly reviewed future instrument GO-window change;
current instrument bytes and evidence remain unchanged. Operator focus/question/checkbox preparation occurs
before requesting GO; an expired window consumes the case and stops, rather than encouraging rushed retry.

The explicit operator GO command first performs the instrument's accepted local admission checks and
irrevocably consumes a previously unconsumed case and creates its private current-GO marker, then requests
ARM_CASE ONCE and READY. This current-GO consumption is the prerequisite for its first arm, not a denial.
It displays GO permission for ONE manual
Ask click only after both acknowledgements. Failed/expired arm or READY consumes that case without positive
credit; no second GO. Server claim timing is precisely the ingress pipeline below, not proof of authority.
Manual Ask still supplies the exact five-key V2 body; no case/model/budget/authority field is added.
This explicitly tightens R-EVAL RC6 `S5ASKREMOTE_REVAL_PLAN.md:236–238` for the added ARM/READY phase:
ordinary capability/local admission preflight failure BEFORE consumption still leaves the case unconsumed;
AFTER the irreversible GO transition, ARM_UNAVAILABLE, SNAPSHOT_STALE, IPC_LOST or any READY/expiry failure
leaves it consumed even without an HTTP submission. No armed slot may exist for an unrecorded case.
This can lose denominator credit without provider work and makes fragile IPC materially affect acceptance.
RS-C must rehearse consecutive ARM/READY cycles on the target platform, report attempted/successful/failed
arm counts and bounded latency, and demonstrate this distinction with injected failures before and after
consumption. No assumed reliability, threshold waiver, implicit retry or re-arm is allowed.

### First-current-GO bookkeeping

The ARM_CASE DTO and06 envelopes remain unchanged. No caller `consumed:true`, GO token, browser flag or
new authority field is added. A GO marker is private measured instrument state, not a transferable permission.
The authenticated first ARM_CASE frame's existing connectionId/sequence/challenge, caseId and preSnapshotId
bind its one issuance. C records that binding and maps it to its own single forwarded C->S frame; S trusts
only that measured C channel. C/S do not independently attest a human GO or I's memory: that property rests
on the measured I state machine plus authenticated channels, never a self-consistent copied JSON object.

| Owner | Required per-registration/admitted-run state and transition |
|---|---|
| I | Retain consumed case IDs. An explicit GO may transition only an unconsumed current staged/consented case after its local preflight. Atomically add it to consumed and create currentGO for that case with the exact pair/fixture/admission/policy/PRE tuple. Before the first ARM_CASE write, bind the next control sequence/challenge and mark armIssued:true. Only that marker may emit that one frame; a failed write still counts as issued. Previously consumed cases cannot create another marker |
| C | After authenticated direction/schema/sequence validation, admit only the registered I's first ARM_CASE for a not-yet-seen case and no other active case. Atomically mark that case seen/current with its I-frame binding BEFORE checking/forwarding the arm. Failure during later checks still leaves it seen. Forward at most once; retain the mapping to the C->S sequence/challenge. A repeated case under either old or fresh frame identity returns CASE_CONSUMED, never another forward |
| S | After authenticated C direction/schema/sequence validation, mark that case seen/current BEFORE arm creation. Create at most one arm after all existing pair/PRE/policy checks pass, bound to that forwarded frame and tuple. A repeated case/forward cannot allocate a second arm even if the first arm failed, expired, was claimed or its ACK was lost |

Each set is bounded by the frozen200 case IDs. The current marker/active slot retires only after the existing
case completion, terminal-observation collection and POST-census checks permit the NEXT previously
unconsumed case. Historical consumed/seen entries remain until the admitted run is closed; they never reset
on successful response, pair replacement, fixture/policy change or UTC day change. No protocol command clears
or reuses them. Loss of I/C/S state, channel continuity or process identity stops that run; an empty set in a
new process is never permission to resume it. Existing restart/closure/unknown-liability rules still apply.

ARM validation failure or missing/lost ARM_ACK/READY_ACK after consumption leaves the I case consumed and
all reached C/S seen entries spent and stops that run for required closure/accounting; it never advances
to an adjacent case. I cannot display GO without both valid acknowledgements. No party may
retry/resend ARM, reconstruct a marker, re-arm from an ACK/status query, or refund/credit the case because
no click was observed. An already-created arm expires under its original deadline or is revoked with its
pair; it cannot be transferred to an adjacent case. Existing integrity failures, explicit closure and
conservative accounting remain mandatory.

## Synthetic evaluation focus choice

The normal console cannot emit FX10's frozen missing focus through selectedObservation. Preserve the corpus,
its exact requestedFocus predicate and all15 FX10 cases. Add a dedicated synthetic evaluation pane enabled
ONLY by the measured registered-server pairing. It offers one fixed choice for the installed fixture:
```
{registrationId,fixtureId,fixtureGeneration,requestedFocus,focusState,syntheticFreshnessAt}
```
This is the exact `evaluationFocus` object in PAIR200: UUID registrationId, frozen fixtureId, positive Dec64
fixtureGeneration, requestedFocus null or a frozen ScopeId, focusState NONE|FOUND|MISSING, and the exact Time
in03. It is derived from the registration, frozen fixture bytes and successful current DB=fixture check;
never from a browser parameter. NONE requires null; FOUND/MISSING require the exact non-null fixture ID.
No question, expected label, source fact or authority permission is returned. Pairing cannot alter the fixture.

The pane starts with an empty draft and no choice. The operator enters the exact question, then manually
selects its single labeled choice (including explicit "No focus" for NONE), then manually checks the existing
per-question consent before GO/Ask. Editing after selection requires selecting that choice again. Pairing, fixture installation, capability refresh or instrument commands never select, check or submit.
The ordinary console focus control/selected observation cannot override this choice while evaluation pairing
is active. There is no arbitrary ID input, query parameter, devtools state hook, stale-selection procedure,
new source endpoint or additional case selector. Outside this registered pairing the pane does not exist and
the normal selectedObservation focus path is unchanged.

In this pane only, the accepted request's observationId comes from that MANUALLY selected fixed choice,
independent of queue selection. The local Ask validator still validates its normal V2 type/length. The
server claims its private arm and checks equality with the arm's registered fixture requestedFocus after
ordinary authentication/V2 validation; mismatch is ASK_REQUEST_INVALID400 before phase1/reserve. It does
not accept focusState or fixtureGeneration in the request as evidence or authority.
For FX10 it sends observationId:'syn-obs-not-found'; that row remains ABSENT. The existing scoped DB reader
must return focus.state:MISSING and derived hasFocus:false. A non-null request never manufactures FOUND,
off-page evidence, entity links or an urgency fact. The normal selector/compiler processes MISSING exactly
as before. There is no source insertion/removal trick or predicate relaxation.

Add a private evaluation-focus generation to the browser's captured request tuple, alongside ALL existing
context/queue/selection/focus/disclosure/auth/scope/request guards. Capture pairId, registered metadata,
manual choice and its generation; no asynchronous event can retarget a pending request. Use the following
EXACT event transitions. "Invalidate pending" means advance the evaluation generation, retire prior pending
request identity and discard its answer/handoff eligibility; it never cancels/forgets possible paid liability.
A new event's input is distinguished from the OLD draft/choice that it replaces.

| Event | Draft and manual choice after event | Consent, pending request and visible evidence |
|---|---|---|
| Manual question input/edit | Retain the exact newly typed draft; clear manual choice | Clear consent and old answer/handoff; invalidate pending. Do not erase the newly typed input |
| Manual selection of the registered fixed choice | Retain the current draft AND the newly selected exact choice | Clear consent and old answer/handoff; invalidate pending. Do not clear the new choice or draft |
| Manual consent checkbox | Retain draft/choice; checking is allowed only for the current valid draft, deliberate choice, pair and capability tuple | Check/uncheck ONLY this generation's consent; never select a focus, edit a draft or submit. Stale checkbox events cannot set consent |
| Manual Ask submit | First capture the exact draft/choice/consent and all current guards; then clear draft, choice and checkbox synchronously | Create a distinct pending-request identity for the immutable captured tuple; clear old answer/handoff. Clearing form inputs does not invalidate this just-captured request |
| Current matching completion | Leave cleared draft/choice/checkbox cleared | May show only its eligible answer/error and handoff; apply existing current-generation error rules. Never repopulate form state or restore consent |
| External invalidation listed below | Clear BOTH draft and manual choice | Clear consent/answer/handoff and invalidate pending; retain fixed choice metadata only if that same pair/fixture remains independently valid |
| Stale success/error/finally or stale UI event | No change | No state mutation, no authority reset, no consent/choice restoration and no effect on a newer pending request |

External invalidations are context/queue refresh, page/filter/ordinary selection change, credential/scope/
actor/capability/policy change, fixture/registration/boot change, pair expiry/revocation, instrument loss,
disconnect, pagehide and bfcache restoration. Lost pairing requires fresh pairing, never restoration from
saved UI state. Each new input or deliberate choice is handled synchronously before accepting consent.
Typing repeatedly therefore preserves the full latest draft; selecting AFTER typing preserves both required
inputs. Editing after selection clears that choice and consent; manual reselection followed by a fresh
checkbox check makes the edited draft ready again. No programmatic selection/check/submit is permitted.

Retaining the draft on deliberate FIXED evaluation-choice selection is an explicit synthetic-only departure
from ordinary focus-change draft clearing. Ordinary console focus behavior and all other scope/authority/
consent rules remain unchanged. Use a separate pending-request generation so form clearing at submission is
not mistaken for a new user edit. Any subsequent input/choice/external change retires that pending identity;
its later success/error/finally can neither retarget the request nor overwrite newer state.

A matching fixed focus grants neither context access nor provider admission. UI readiness proves only local
pair/choice/consent state; browser does not claim to know server arm state. An early manual click is denied
by the server below, counted and terminal for the run. No new status poll or third handoff operation is added.

## Registration lifetime and exact Ask ingress pipeline

Every Ask SUBMIT targeting the registered synthetic scope requires the pair/arm gate for the ENTIRE
immutable registration lifetime: unpaired, expired, paused, disconnected, before/after a case and after a
run all remain gated. Ending a pair or process restart does not restore ordinary unmeasured dispatch.
The measured runtime refuses startup if its required registration/DB binding is missing or mismatched;
registration removal is not a supported runtime/owner command. Other scopes cannot use its pair/arm.

Enabled Ask failures remain the exact AskErrorV1 body, fixed status in06, no-store and server-generated
X-Atlas-Correlation-Id. Correlation existence is not scoped task/attempt proof. No new Ask error code:
- Registered-scope absent, unknown, expired, revoked or consumed pair/arm: ASK_REMOTE_NOT_ADMITTED503.
  Increment rejectedUnpairedCount once; do no source/actor/authority DB read or reservation. The generic
  result exposes no pair/registration detail. Malformed/duplicate session header: ASK_REQUEST_INVALID400,
  also rejectedUnpairedCount once. Duplicate submits additionally stop integrity; no new attempt is admitted.
- An evaluation-session header on an enabled Ask outside the registered scope: ASK_REQUEST_INVALID400,
  never silently ignored. OFF remains ordinary404 and no evaluation endpoint is enabled. The header is
  forbidden on capability/other methods/routes; enabled intercepted Ask shapes reject it with400, ordinary
  unrecognized routes remain404. Existing method/query/content-type/size denials remain authoritative.
- Once an arm is claimed, ordinary authentication401, scope403, V2/request400, policy409/503, budget429 and
  other accepted failures retain their fixed mapping. Current authority is always checked independently.

Ordered pipeline for registered remote SUBMIT:
1. Count submit ingress before asynchronous work. Apply accepted canonical route/method/query, JSON media,
   content-encoding and declared-length checks, strict single43-character session-header syntax, and exact
   same-origin Host/Origin/Fetch Metadata checks for this evaluation header (invalid origin is400).
   These are bounded header checks only; do not parse bearer as authority, read body/source or reserve money.
2. Match the private token to the current measured pair and unexpired arm for the URL's exact registered
   client. Atomically move the arm ARMED->CLAIMED once, recording an unscoped ingress/task nonce. This
   measurement claim occurs BEFORE raw body decoding, bearer authentication and all DB work. A valid token
   is a measurement capability only. Parallel requests cannot both claim; a rejected request cannot re-arm.
3. Apply the existing bounded physical-task acquisition/body16KiB/fatal-UTF8/JSON parse, then existing bearer
   authentication, scoped all-of permission, V2 validation and policy tuple checks. Any failure consumes
   the claimed arm; body overflow, malformed JSON, missing/foreign/invalid bearer cannot retry that arm.
   Pre-header rejection has no arm claim, but the instrument already consumed the GO case; any rejected or
   hidden submit stops the run. No automatic retry after busy/pre-parser failures.
4. After ordinary authentication, REQUIRE exact authenticated workspaceId/clientId/actorId equality with
   the immutable registration. On ANY mismatch return the fixed AskErrorV1 ASK_SCOPE_DENIED403 BEFORE
   phase1/source read/reservation; the claimed arm remains consumed. A valid foreign bearer plus a stolen
   session token supplies neither registered scope nor permission to dispatch. Never create a registered
   Binding for that foreign principal. Before successful authentication AND this equality check, retain
   only aggregate unattributed ingress/counters, with no fabricated scoped terminal record.
   Only then establish the scoped task/correlation Binding, check fixed focus equality, and use accepted
   phase1 -> reservation/egress -> settlement/publication with
   unchanged authority/consent/budget/private-proof fences. No gate step supplies authority to those phases.

Claiming before authentication deliberately permits someone possessing a stolen live session token to burn
that one arm and cause a denied run. It cannot grant actor/source/provider authority or a passing case.
Token theft is covered by memory-only/no-log/origin/process protections; lack of attribution stays UNKNOWN.
Guard/ledger reconciliation must still detect hidden or foreign activity; the gate does not replace census.

## The server must bind the actual values

For a claimed arm the API retains the parsed, exact original AskRequestV2 in a private memory slot, associated
with task identity, server correlation, credential epoch, fixture generation, policy/fence and pairing.
After final current-authority/audit commit and immediately before HTTP serialization, attach the EXACT
immutable answer projection/status/correlation that the server sends to that slot. For an eligible scoped
error, bind the exact public error/status/correlation and its known task terminal metadata instead.
Never place upstream content or errors in the slot. Raw values cannot enter a generic logger/receipt object.

The one-use response nonce in `X-Atlas-Evaluation-Receipt` identifies the private slot, not an answer cache.
Mint it only when a slot has a bound actual publication; a caller-supplied nonce/correlation cannot make one.
The server may not expose slot contents via GET, polling, owner metadata export or another client's call.

The browser retains its exact actually-submitted request snapshot and the actually-received parsed response,
status and correlation header under the accepted private generation state. Its existing WHOLE response
validator runs first. A stale, wrong-scope, malformed, wrong-model or rejected response does not become
eligible by toggling a new button. Every accepted credential/scope/context/queue/selection/focus/disclosure/
request guard remains authoritative; edits/refresh/pagehide/bfcache clear the handoff reference as required.
A manual click captures the still-current immutable values; no checkbox consent is reused or altered.

RESPONSE body exact:
```
{contractVersion:'RevalBrowserHandoffV1',operation:'RESPONSE',pairId,receiptNonce,
 request:<exact AskRequestV2>,response:{status,correlationId,body:<AskAnswerV2|AskErrorV1>}}
```
Use the private bearer plus session header. The server first authenticates scope/pair/current authority,
then atomically moves the nonce from AVAILABLE to CLAIMED before validating/transferring values. It checks
strict DTOs and structural equality against its private request AND publication objects: all keys/values,
exact question/focus/requestId/acknowledgement, status/correlation and every answer/error field. No content
hash, signature over a question, body logging, client `validated:true` flag or claimed current authority.
Edited text/answer before POST cannot match the server slot and is not accepted as authentic evidence.

The endpoint repeats the bounded current all-of/credential/actor/scope/policy/fixture checks under the
accepted authority fence; no source read, financial lock or owner mutation. A successful answer handoff
requires both the stored successful publication authority result and current authority at handoff. These
are distinct instants. Revocation in between invalidates handoff; it does not retroactively assert an
unauthorized original publication. Errors without sufficient scoped task continuity remain unattributed.
Release DB locks before IPC; recheck private pair/nonce/generation before committing the transfer.

Only the matched BROWSER values are delivered once over the separate S<->I transient protocol in06. Its
exact Binding/READY/TRANSFER/ACK/COMMIT schemas carry the server binding and fixed comparison result. The instrument reruns
its accepted request/answer validators and independent frozen-fixture comparator; it cannot trust a server
"pass" in place of those checks. It acknowledges only the closed SafeResult; matching COMMITTED plus an
atomic safe-summary save is required to confirm handoff. Browser204 has no body and does not by itself
prove the instrument received COMMITTED. Lost/delayed ACK/commit semantics and persistence are exact in06.
A missing acknowledgement, disconnect, bad comparison, expiry or overflow burns the nonce and yields
`LOCAL_HANDOFF_UNVERIFIED`; do not retry Ask or silently send the handoff again. The original liability is
still determined separately; no handoff failure grants a refund. An already authenticated fault/truth/
threshold failure keeps its stronger FAILED state despite transfer uncertainty; positive credit remains blocked.

Successful transport does not prove a human clicked, that the browser was uncompromised, or that intent was
correct. The measured browser build and UI tests support the generation/manual-action property; operator
identity remains separately attested unless independently authenticated. Receipt provenance never treats
an untrusted browser assertion as owner/server authority.

## Memory, bounds and time

PAIR body <=1KiB. RESPONSE body <=288KiB incremental actual bytes (16KiB original request, <=256KiB accepted
reply plus bounded wrapper). The total encoded cap wins if components plus wrapper exceed it; reject without
truncation or partial credit. These are transient byte checks, never persisted body-length metadata. Use fatal UTF-8, strict duplicate-key rejection, closed keys, max nesting as the
accepted DTO permits. Independent 2s handoff receive/validation/IPC deadline; it never extends the original
Ask/provider deadline or supplies another provider attempt. No request/response file, clipboard body, HAR,
trace, video, saved devtools response, shell paste or temporary spool.

One transient publication slot per pair, at most one pair per server. Retained values have combined serialized size <=288KiB; bounded parsed-object overhead is measured separately. Reject rather
than evict/reassign an occupied slot. Drop references on successful acknowledged transfer, failure,
server-observed revocation, pair loss, server shutdown, or at120s from Ask ingress,
whichever is first. This erases RAW slot values only: the separate closed original-task terminal observation
in06 survives for safe owner collection, including fault before failed settlement/publication. Timer uses real monotonic time and cannot renew on reads/retries. Original transport/DB
physical ownership remains subject to its existing four-owner bound independently of this one-slot buffer.
The extra120s synthetic handoff lifetime is an explicit proposed exception to the ordinary drop-at-task-
settlement rule. It is not enabled for ordinary remote traffic. No secure physical memory erasure is claimed.

The instrument processes the transient frame in a type/module that cannot be passed to its persistence API.
Only enums/booleans/numeric money/counters/latency, safe case/fixture/correlation/attempt IDs and approved
artifact/process identities leave it. Raw request, raw answer, observed intent, question or body hash/length,
receipt/session/pairing secret, credential, arbitrary exception text and provider content are never saved.
RequestId may be compared transiently but is not added to financial/runtime evidence persistence.

## Ingress and threat coverage

Retain existing private bearer, Host and no-store boundaries; add exact same-origin Origin and Fetch Metadata
checks for this route, no CORS wildcard/credentialed cross-origin path, no cookies or CSRF token authority.
Reject null/absent/unexpected Origin here. Route/method/content type/body limits are checked before expensive
work. Response headers/body are allowlisted, cache disabled, no redirect/location, URL parameter, callback,
webhook, arbitrary path or deserialization hook. Pair/receipt tokens are unguessable AND scope/process bound.

Test forged/foreign pairing, stolen old nonce, parallel handoff races, replay after success/expiry/restart,
response mutation, wrong actual request, swapped same-shape answer, mismatched requestId/correlation,
policy/scope/focus generation changes, extra keys/duplicate keys/oversize/bad UTF-8, CSRF, origin/DNS rebinding,
IPC peer replacement, unauthorized local read and stalled consumer. Neither devtools editing nor a valid
DTO alone proves server provenance. Root/kernel/owner compromise is outside this local attestation boundary.

Failure to obtain a bound handoff means UNKNOWN/unverified, never observed schema violation solely because
a paste/transport was malformed and never a verified zero. After raw values are dropped, replay can check
numeric/census/closure consistency and receipt allowlists; actual live truth/intent predicates remain
unreplayable under the privacy contract. Keep that qualification in every resulting report.
