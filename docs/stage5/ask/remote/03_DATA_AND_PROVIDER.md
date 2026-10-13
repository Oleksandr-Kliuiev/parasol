# Data flow and private provider adapter

## Projection and lifetime

```
private bearer → current scope/source read → finalized local bank
                                      ↓ hasFocus only
original question + explicit acknowledgement → durable egress admission → OpenAI intent enum
local bank + intent → local deterministic refs → unchanged compiler → final current authority/audit → V2 answer
```
The local bank never enters the transport adapter. Adapter accepts only fresh exact `{question,hasFocus}` plus
AbortSignal and a private dispatch capability minted by committed egress admission. No actor, DB handle, registry,
evidence object, browser DTO, arbitrary URL or stringified source is in its interface. Key stays in a private server
closure, resolved from an Ask-specific secret reference; no browser/getter/log/error or Decisions-key reuse.

At the remote boundary original question is untrusted content, not authority. It may include names, IDs or secrets
typed by an operator. Minimize server data and explain this risk; do not call the question anonymized/redacted or
promise a content classifier prevents sensitive text. Only explicitly admitted synthetic questions are allowed in
this slice. Operator attestation is not proof of content; trusted test operators and synthetic DB registration are
admission prerequisites. Customer use remains blocked regardless of identical field shape.

No question, hash, length, answer, plan, raw upstream response/error/header, or provider content in logs/audits/ledger/
traces/APM/captures. Disable request/response body instrumentation on both Ask and upstream client before egress.
Fixed codes, numeric usage/cost and server correlation may be persisted only in the specified ledger. Drop transient
references on actual task settlement; ignored abort may retain at most4 local owners. No forced-erasure claim.
There is no customer conversation, background session, provider storage API, file, embedding or vector store.

## Wire profile ask-remote-openai-luna-v1

Exactly one POST to `https://eu.api.openai.com/v1/chat/completions`, HTTPS443, no custom base URL, redirect,
environment proxy, SDK retry, DNS-supplied alternate host or user URL. Use a dedicated direct Node HTTP transport;
verify TLS hostname/default trust, ignore proxy env and reject redirects. Integration tests capture exact host/method/
headers/body. Platform egress allowlist must restrict this service to that provider host before paid admission.
No startup network probe; offline tests inject an in-process transport behind the private adapter, not a public switch.

Headers allow only Authorization (dedicated project key), Content-Type/Accept application/json and transport-required
Host/Content-Length plus fixed Connection:close; no forwarded browser headers, user IDs, cookies, correlation, OpenAI-Organization or arbitrary
OpenAI-Project override. Dedicated key is provisioned to the recorded project; verify account/key association out of
band before admission. No subscription/Codex/Claude login credential may authenticate product inference.

Payload exact keys: model='gpt-6-luna', messages=[developer,user], reasoning_effort='none', service_tier='default',
store=false, stream=false, n=1, max_completion_tokens=512, prompt_cache_options={mode:'explicit'},
response_format={type:'json_schema',json_schema:{name:'ask_remote_intent_v1',strict:true,schema:<intent-schema.json>}}.
Messages have exact role/content keys with string content. Developer content is the exact prompt JSON's text value;
user content is JSON.stringify of fresh `{question,hasFocus}`. No cache breakpoints, tools/tool_choice, history,
metadata/user/safety_identifier, logprobs, images/audio, prediction, reasoning transcript or unknown option.
Entire serialized upstream payload≤16KiB UTF-8; overflow ASK_TOO_LARGE413 before admission/egress. No truncation.
Do not set legacy prompt_cache_retention on this model. No fallback to global endpoint or another model.

Prepare/serialize the immutable bounded payload BEFORE egress admission under the original8s deadline. No payload
reconstruction after commit. Provider phase starts immediately before one-use dispatch-capability consumption and uses
min(2s, remaining original8s), covering final request construction/network/incremental capped read/fatal UTF-8/JSON/
envelope/intent/usage validation; never restart its timer. Read at most64KiB actual bytes; reject overflow before
unbounded buffering and bound stream cleanup. Stop on request disconnect/terminal. Abort is courtesy; never automatically
retry even on429/transport errors. Public deadline remains bounded; underlying transport cleanup still owns its permit.

Require HTTP200/application/json, object='chat.completion', model exactly'gpt-6-luna', service_tier exactly'default',
one choices element index0 with finish_reason='stop', message.role='assistant', content nonempty JSON string≤2KiB,
refusal absent/null, tool_calls/function_call absent/empty and no nontext output. Parse intent content EXACT against
intent-schema.json locally; schema generation is not validation. Benign extra upstream envelope metadata is ignored,
never projected/logged; a second choice, bad usage or forbidden output rejects the whole result. No partial rendering.
Reject duplicate JSON keys throughout the bounded upstream envelope and inside intent content; JSON.parse alone
cannot detect them. No permissive repair/first-or-last-key selection. Usage is required for success: safe integers
prompt_tokens0..32768, completion_tokens0..512, total_tokens=their sum. The32768 limit is a conservative anomaly gate
for this small profile, NOT a proven input-token billing bound; the full-window reservation still protects unknowns.
Usage keys are only prompt_tokens,completion_tokens,total_tokens and optional prompt_tokens_details/completion_tokens_details.
Known detail counters are nonnegative/in-range; text_tokens≤its parent total. For this text-only/none/no-cache profile,
cached_tokens,cache_write_tokens,image_tokens,audio_tokens,reasoning_tokens,accepted_prediction_tokens and
rejected_prediction_tokens must be0 if present. Unknown usage/detail keys or positive forbidden counters reject.
Cost-only settlement can use validated
model/tier/usage even if content/refusal fails. Model/tier/usage mismatch retains the whole reservation and trips the
workspace remote circuit (durable pause); any pause failure still returns no answer and refuses future local calls.
Upstream401/403 also trip this configuration-fault circuit; retain the reserve, do not misclassify browser auth.
If a future provider response starts reporting a dated model ID, the exact-ID gate pauses instead of accepting it.

The current official ID has no published dated snapshot. Pin exact ID/profile/prompt/schema and response model;
do not claim immutable weights. No aliases such as latest, dynamic allowed-model list or silent upgrade. Owner-admitted
synthetic evaluation is required before activation and renewed for a model/profile change or detected semantic drift.
Provider account access, EU/ZDR eligibility and actual response shape are unverified until separately admitted R-EVAL.

## Deterministic local selection

Provider returns only `{version:'AskRemoteIntentV1',intent:<five-enum>}`. It cannot return refs or prose. Extract the
accepted MOCK selection algorithm into a focused pure selector shared without behavior change: SUMMARY first≤8
OBSERVATION refs, else first≤8 RESOURCE_STATE; WHY_URGENT exact focusRef or[]; SOURCE_STATE exact focusResourceRef
or[]; ENTITY exact focusEntityRef or[]; UNSUPPORTED[]. Input is already validated local descriptors/focus refs.
Build AskPlanV1 locally, run existing whole-plan validator and claim compiler. Empty refs remain INSUFFICIENT;
all-bank urgency and honest coverage remain independent of intent. The remote classifer cannot alter route/severity,
scope, source, eligibility, freshness or action policy. Wrong semantic intent remains an evaluation failure even when
the locally compiled result is structurally safe. No fallback to the phrase recognizer on remote failure.
