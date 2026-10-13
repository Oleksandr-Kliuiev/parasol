# Remote HTTP and browser contracts

## Versions and fixed surface

Keep GET `/ask/capabilities` and POST `/clients/:id/ask`; no additional inference/proxy/model-selection route.
All accepted route classification, raw16KiB/fatal UTF-8, no query/encoding aliases, exact200, no-store/correlation,
private bearer authentication and non-Ask parser behavior remain. OFF ordinary404 and MOCK V1 are unchanged.
Remote mode refuses V1 requests with400 ASK_REQUEST_INVALID; MOCK refuses V2. No mode downgrade or silent retry.

Remote capability exact DTO (all keys required):
```
{contractVersion:'AskCapabilityV2',mode:'remote',questionMaxCodepoints:2000,
 disclosure:{contractVersion:'AskRemoteDisclosureV1',admissionId:<lower UUIDv4>,policyVersion:<decimal string>,
 provider:'openai',model:'gpt-6-luna',profile:'ask-remote-openai-luna-v1',
 sent:'QUESTION_AND_FOCUS_FLAG',dataClass:'SYNTHETIC',region:'EU',retention:'OWNER_VERIFIED_ACCOUNT_POLICY',
 reserveMicroUsd:300000}}
```
policyVersion is a positive canonical decimal integer≤9223372036854775807, handled as string/BigInt, never Number.
Capability follows accepted ingress/auth/budget ownership, then bounded workspace-policy read; no client source,
question charge, provider call or completion audit. Expired/missing/inactive policy gives503 ASK_REMOTE_NOT_ADMITTED,
not404/OFF. Capability is informational; POST rechecks every gate. No key/project/owner-approval document in the DTO.

Remote request exact DTO (five keys):
```
{contractVersion:'AskRequestV2',requestId:<lower UUIDv4>,question:<original string>,observationId:<string|null>,
 acknowledgement:{contractVersion:'AskRemoteDisclosureV1',admissionId:<lower UUIDv4>,policyVersion:<decimal string>,
 questionDataClass:'SYNTHETIC'}}
```
Question and observation-ID rules are exactly V1. Acknowledgement is required, never defaulted or injected by a
generic transport helper. It records an operator declaration; it supplies no authority. A current policy-version
mismatch is409 ASK_REMOTE_POLICY_CHANGED; correct version with no active admission is503 ASK_REMOTE_NOT_ADMITTED.
No provider call on either. Invalid acknowledgement structure is400. No raw question hash/length/echo in any record.
The server compares the tuple BEFORE financial reservation; a later request's newly captured authority fence cannot
make an older consent revision current. Every material policy/allowlist revision advances the separate policyVersion
under04; the capability must be explicitly refreshed and consent checked again before resubmitting a cleared draft.

Remote answer has EXACT the15 V1 keys plus `provenance`: contractVersion becomes AskAnswerV2, mode becomes remote;
provenance exact `{provider:'openai',model:'gpt-6-luna',profile:'ask-remote-openai-luna-v1',
 dataPolicy:'QUESTION_ONLY_V1'}`. All other types, claim/evidence/coverage/focus/sourceMode/urgency predicates remain
V1. Compiler produces one immutable V2 projection from the existing validated candidate, with fixed provenance;
no raw upstream model string/usage/text is forwarded. Browser requires remote capability/captured scope and V2;
reject wrong mode/version/provenance and the whole malformed answer. V1 bank and claim validators are shared focused
primitives, not weakened by a generic loose V1/V2 union. Returned sourceMode must be db in remote mode.

AskErrorV1 envelope/header remains exact. Only remote adds fixed codes:
ASK_REMOTE_NOT_ADMITTED503, ASK_REMOTE_POLICY_CHANGED409, ASK_REMOTE_BUDGET429,
ASK_REMOTE_UNAVAILABLE503, ASK_REMOTE_INVALID503, ASK_REMOTE_MODEL_MISMATCH503,
ASK_REMOTE_USAGE_INVALID503. Existing ASK_DEADLINE504/ASK_AUDIT_FAILED503/authority codes retain meanings.
Upstream401/403/404/429/5xx all map to ASK_REMOTE_UNAVAILABLE503; they NEVER mean browser credential revocation,
scope loss or OFF. Refusal, tool calls, incomplete output or invalid intent produce ASK_REMOTE_INVALID503, never a
successful UNSUPPORTED answer. A valid explicit UNSUPPORTED intent is200 with its usual local evidence/urgency.

## Consent and generation isolation

Remote panel says “OpenAI GPT-6 Luna interprets the question; Atlas compiles facts locally.” It explains original
question + focus-present flag leave Atlas, stored evidence does not, paid API usage is separate from subscriptions,
account retention is owner-verified and the current slice accepts synthetic questions only. Show a concise visible
cost notice: “Up to US$0.30 reserved per attempt; unknown outcomes retain this reservation.” Link only to fixed local
disclosure text. No browser pricing/model selectors, arbitrary URLs, credential entry for provider or policy editor.

A separate unchecked checkbox: “I consent to sending this question to OpenAI and confirm it is synthetic.” Submit
requires manual check on every question. It resets on question edit, submission, credential/scope/context/queue/page/
filter/observation/focus change, capability refresh/version change, disconnect/pagehide/bfcache. Focus persists after
submit as in accepted ASK-B; consent does not. Capture both in the submitted request before clearing input/consent.
No durable checkbox storage/history. The original question is transmitted unchanged; no misleading regex sanitizer.

New disclosure/policy generation joins existing credential/scope/context/queue/selection/focus/request guards on
every success/error/401/403/finally. A deliberate focus change clears draft/answer synchronously. A question edit
clears consent and old answer, invalidates older pending work. Acknowledgement never transfers to a new draft.
Current policy409 clears input/answer/consent, marks unavailable and offers explicit capability refresh; no automatic
resubmission. Auth401/403 retain accepted current-generation behavior. Stale provider failures cannot reset current
browser authorization. One pending question, no automatic retry/fallback/poll; every manual submit fresh UUID/read.
Keep token private, fixed two operations, ≤256KiB incremental response cap, original10s, safe DOM/citations, keyboard
live states and320/768/1440 layouts. Old MOCK examples/label remain only in MOCK; remote lists the four supported tasks.
