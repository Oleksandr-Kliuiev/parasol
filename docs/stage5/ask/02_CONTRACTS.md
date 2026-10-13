# HTTP, evidence and planner contracts

## Fixed HTTP surface

Only when mock is enabled, add authenticated GET `/ask/capabilities` and POST `/clients/:id/ask`. Capability200 JSON:
`{contractVersion:'AskCapabilityV1',mode:'mock',questionMaxCodepoints:2000}`; no keys, model name or authority grant.
The browser treats only capability404 as OFF (no input), validates200 exactly, and retains normal401/403 handling.
No capability cache across credential epochs. Capability is queried once per connected credential, after clients load;
valid current context is still required to submit. Other failures show fixed unavailable state with explicit retry.

POST has explicit `@HttpCode(200)` and application/json. Path client matches SCOPE_ID_PATTERN1..128; malformed path IDs
receive authenticated403 ASK_SCOPE_DENIED with the same workspace-denial audit as absent/forbidden clients. Body has exactly:
`{contractVersion:'AskRequestV1',requestId:<UUIDv4>,question:<string>,observationId:<string|null>}`.
All four keys required; unknown keys rejected. Question1..2000 Unicode codepoints with at least one non-whitespace;
reject NUL, lone surrogates, DEL and C0 except TAB/LF/CR, do not silently truncate. Body UTF-8 max16KiB (route-local
parser/limit before JSON parse; preserve other endpoints' parser behavior). Observation ID nonempty≤256, unshortened;
never interpreted as source ID or fetched outside the captured client. UUIDv4 must be canonical lowercase (uppercase
rejected); it is a correlation aid, not idempotency or
authority. No user actor/workspace/context/model/tool/parameters/URL. No query parameters on either route.

Errors use a fixed new Ask-code allowlist with no upstream/body/details echo: request invalid400, authenticated scope
denied403, invalid/currently revoked or expired credential401, source context unavailable404, response/source cap413,
authority epoch changed409, local budget429, disabled routes404, deadline504, planner/audit/runtime failure503.
Codes: ASK_REQUEST_INVALID, ASK_SCOPE_DENIED, ASK_AUTHENTICATION_FAILED, ASK_CONTEXT_UNAVAILABLE,
ASK_TOO_LARGE, ASK_SCOPE_CHANGED, ASK_BUSY, ASK_DEADLINE, ASK_PLANNER_INVALID, ASK_AUDIT_FAILED,
ASK_RUNTIME_NOT_READY, ASK_SOURCE_INVALID (503 for malformed original source). Successful unsupported/insufficient questions are200 answers, not transport failures.
Unknown exceptions map to ASK_RUNTIME_NOT_READY; diagnostics contain only server-generated correlation UUID.

Every enabled Ask error, including parser and guard failures, has EXACT JSON keys
`{contractVersion:'AskErrorV1',code:<one code above>,correlationId:<server canonical lowercase UUIDv4>}`.
Every enabled Ask response has application/json, Cache-Control:no-store and X-Atlas-Correlation-Id matching its body's
correlationId; capability200 has no body correlation field and uses only that header. No message/statusCode/details/body
or exception text in an error. A route-bound error boundary must wrap even enabled-route guard401; OFF routes retain
ordinary Nest404 (status-only browser treatment). Non-Ask errors/headers keep accepted behavior.
The browser must not require a capability body correlationId. Raw16KiB and question2000-codepoint caps are independent:
Unicode escape expansion may make an otherwise valid-length question fail413; the browser sends ordinary UTF-8 JSON.

Bootstrap explicitly disables Nest's automatic parsers (`bodyParser:false`) in BOTH fixture and DB branches of
apps/api/src/main.ts. Keep the accepted operator Host gate/security middleware ahead of request parsing. Install Ask raw
parsing BEFORE re-registering the same existing JSON and urlencoded parser defaults
for every non-Ask route, including in OFF mode. In MOCK intercept only the exact capability GET and client Ask POST shapes;
OFF does not parse as Ask. Recognize every alias that can reach an Ask controller, or reject it before the general parser;
case/trailing-slash/percent-encoding variants must not bypass the private boundary. HEAD/OPTIONS on Ask shapes are rejected
synchronously with ordinary404 before authentication/controllers (including Express's implicit HEAD→GET fallback).
POST accepts application/json with optional charset=utf-8, no other charset or Content-Encoding;
count actual incoming bytes, including chunked bodies, stop buffering at16KiB before any JSON parse, decode UTF-8 fatally.
Oversize is413 ASK_TOO_LARGE; invalid type/encoding/UTF-8/JSON is400 ASK_REQUEST_INVALID, never a parser excerpt. Close or
bounded-drain rejected streams without unbounded buffering. Capability accepts no query and only absent/0 Content-Length
with no Transfer-Encoding; any actual body bytes also reject400. POST accepts no query.
Fully consume or terminate the Ask stream; attach parsed JSON to a private request property, consumed explicitly by the
Ask controller, never @Body(). Raw syntax validation is distinct from later exact DTO semantic validation. Register
express.json() and express.urlencoded({extended:true}) with the installed runtime's unchanged defaults (100kb, strict JSON,
application/json; same charset/inflate behavior) ONLY for non-Ask path/method shapes. Explicit classification excludes
Ask from both generic parsers, independent of stream-finished heuristics. Early errors terminate without next()/second read.
Capacity reservation precedes raw/body/guard async work (03); raw size/syntax may reject before authentication; exact body
semantics follow the Ask-private bearer guard, then actor reservation and fenced membership. Goldens prove non-Ask parser
behavior in OFF/MOCK and that no Ask stream is parsed twice.

## Server evidence bank

Read context from authoritative storage, never from browser JSON. New focused reader uses one already-admitted scoped
transaction; no nested getClientContext/withScope transaction or browser HTTP loopback. Preserve the public context API.
Its field semantics mirror the accepted ClientContextV1 projection: source Atera/Huntress only; graph scope/confirmed
links, observation enums/lifecycle/identity, ResourceView status/mode/nullable-time/truncation and item shape validation.
Validate original selected source rows/items BEFORE any existing mapper fallback, unknown-source substitution, truncation
or malformed-item-to-ERROR repair. Such repair cannot turn invalid Ask evidence into valid evidence; fail ASK_SOURCE_INVALID.
No email, raw payload/facts, externalDevice/receivedAt, safeErrorCode, financial/M365 content or source URL extraction.
No source sync or Gateway/tool call. Context: active first100 observations in existing server order, people/devices/links
max1000 each, resources100, items1000 per resource, total decoded/serialized context≤4MiB. Fetch graph arrays with cap+1
where possible and reject overflow; JSON snapshot size is checked after DB materialization, not claimed pre-allocation.
Ambiguous duplicate observation IDs, graph IDs or resource source/type/connection tuples invalidate the whole source read;
never pick an arbitrary row. Unknown source, malformed item-array/type, observation summary/time/enum, graph kind or scope
violations are ASK_SOURCE_INVALID, never mapper-repaired empty/ERROR evidence. Missing source snapshots legitimately map
to accepted MISSING state, distinct from malformed snapshots. Ask display summary cap4000 intentionally differs from console300.
An optional selected observation is one additional exact scoped row (all lifecycle statuses), validated and restricted
to Atera/Huntress; missing/unsupported focus yields INSUFFICIENT for focus-dependent intents, with no lookup/fallback
elsewhere. SUMMARY may still summarize the validated active page; UNSUPPORTED stays UNSUPPORTED. Invalid source DTOs
remain errors, not missing focus.

Bank≤32 facts: up to24 observations (focus first, deduplicated by exact ID, then source order), up to7 resource-state
facts (focus source/type/connection first when present), and1 focus entity fact. Entity confirmation follows S5-B exact
unambiguous graph ID+CONFIRMED link, never a name guess. Validate the whole source read before selecting facts.
Fact IDs are E1..E32, assigned by server per request, consecutively in observation-bank order, then resource-bank order,
then entity, with no gaps. Facts have closed kinds OBSERVATION/RESOURCE_STATE/ENTITY. Resource order is
the accepted context order except eligible exact focus tuple is promoted first. No other ordering is inferred by planner.
Use explicit projections only. Observation: scoped Atlas ID, source/type/connection/externalEventId, summary, severity,
priority/route/confidence/reasonCodes/status/conflict/superseded and independent times. Resource: captured tuple,
status/asOf/lastSuccessAt/truncated; no snapshot items are copied into this first Ask bank. Entity: exact graph ID,
confirmed/unresolved/unavailable state and existing display label only. Display strings cap4000 codepoints with marker;
request identity fields remain validated unshortened. An overlong identity is invalid, never reconstructed from labels.

Coverage records read limit100, bank limit32, source-page truncation, bank omissions and fixture limitation. Drop context
global counts: they may include excluded sources; any displayed counts describe only included facts. Never claim the
bank is exhaustive or atomically fresh. Separate reader times from source asOf/lastSuccessAt. Fixture Huntress evidence
lookup remains unsupported; its existing resource-state fixture card is not a performed lookup.

Exact bank element: `{ref,kind,data}`; no additional keys. `ref` matches `^E([1-9]|[12][0-9]|3[0-2])$`.
OBSERVATION data keys: observationId,source,resourceType,connectionId,externalEventId,summary,severity,priority,route,
confidence,reasonCodes,status,entityId,conflictOfEventKey,supersededById,occurredAt,createdAt,updatedAt,acknowledgedAt,
resolvedAt. Types/enums/nullability are the accepted ObservationSummary fields (ID renamed observationId); reasonCodes
max100 strings. IDs≤256 except connectionId uses scope pattern1..128; source request IDs are not generated from labels.
RESOURCE_STATE data keys: source,resourceType,connectionId,status,asOf,lastSuccessAt,truncated (accepted ResourceView
semantics, nonnull explicit connectionId, accepted time/null/status/mode checks; no items property).
ENTITY data keys: observationId,entityId,state,entityKind,displayName,confirmation. State CONFIRMED/UNRESOLVED/UNAVAILABLE;
entityId is nullable accepted graph ID; kind PERSON/DEVICE or null; displayName string or null. CONFIRMED requires exact
graph row and confirmation `{source,resourceType,connectionId,externalId}` from one CONFIRMED matching entity link with
the SAME entityId AND entityKind, system Atera/Huntress, within the captured client, chosen in existing link-ID order.
Matching does NOT require the focus observation's resourceType/connection/source tuple: any such confirmed link of the
exact entity qualifies, consistently with the console's entity rule. Browser checks this projection/confirmation shape,
not a focus-resource tuple for ENTITY. Otherwise confirmation/displayName/kind are null: missing graph row UNAVAILABLE,
no entity ID or no confirmed link UNRESOLVED. All bank objects are fresh explicit projections, not raw-object spreads.

Exact coverage keys: observationLimit:100,bankLimit:32,observationsRead (safe integer0..100),observationPageTruncated
(boolean),focusExtra (boolean),observationFactsOmitted (boolean),urgentFactsOmitted (boolean),resourcesRead (safe integer0..100),resourceFactsOmitted
(boolean),fixture (boolean). observationsRead counts ONLY the active page, excluding cap+1 sentinel and additional focus;
focusExtra is true exactly when a returned focus row was not on that page (at most101 observed rows total).
urgentFactsOmitted is true if any HIGH/CRITICAL source-read observation is omitted from the bank. resourcesRead includes
valid Atera/Huntress null-connection placeholder resources; these cannot enter the explicit-tuple bank and set
resourceFactsOmitted=true. reasonCodes strings use the4000-codepoint display cap/marker too; observationId256 is intentional
direct DTO support, not a promise that the observation-list cursor supports that ID. Counts describe source read before
bank reduction, not whole-client totals. Invalid source
scope, modes or DTOs fail the request instead of becoming missing data. The source read has no claim of atomic snapshot.

## Local planner and answer compiler

Private interface `plan(AskPlannerInputV1, AbortSignal): Promise<AskPlanV1>`. Input exact keys: question (original, local MOCK),
focusRef (focus OBSERVATION E-ref or null), focusResourceRef (RESOURCE_STATE E-ref or null), focusEntityRef (ENTITY E-ref or
null), bank (descriptors `{ref,kind,source,type,severity?,route?,status?,entityState?}`). Server computes focusResourceRef
ONLY from the finalized bank's exact validated focus source/resourceType/nonnull connectionId match; absent focus/tuple
gives null even with same-source/type unrelated resources. focusEntityRef names only the bank's focus entity fact.
These request-local refs are server-derived eligibility, not authority; never accepted in HTTP/body input. Descriptors contain
known enums/flags only: no names, summaries, free-text reason codes, identifiers, times or raw records. Question is
untrusted input, never authority/instructions to execute. Planner has no DB, network, credentials, Gateway or registry.
Private factory/DI injection for synthetic tests is in-process only; no HTTP switch, environment-selected module or public registry.

Plan exact keys: `{version:'AskPlanV1',intent,refs}`; intent SUMMARY/WHY_URGENT/SOURCE_STATE/ENTITY/UNSUPPORTED;
refs≤8 unique current E-refs, no other keys, arbitrary prose, URL, tool or parameters. Unknown version/enum/refs, wrong
types, duplicates or unexpected keys reject the whole plan. Mock intent recognizer handles only documented RU/EN
phrases; unmatched input gives UNSUPPORTED. First implementation uses exact case-insensitive trimmed matches, with
optional terminal '?' removal: SUMMARY “what needs attention”/“что требует внимания”; WHY_URGENT “why is this urgent”/
“почему это срочно”; SOURCE_STATE “how fresh is the evidence”/“насколько свежи данные”; ENTITY “which device is confirmed”/
“какое устройство подтверждено”. UI labels these as supported MOCK examples, not general language understanding.
Deterministic selection: SUMMARY takes the first up to8 OBSERVATION refs in bank order; only if none exist, first up to8
RESOURCE_STATE refs. WHY_URGENT selects [focusRef] or[]; SOURCE_STATE selects [focusResourceRef] or[]; ENTITY selects
[focusEntityRef] or[]; UNSUPPORTED selects[]. No retry/fallback to Decisions or another model.

Compiler alone derives claims; this exact matrix also controls browser validation:

| Intent | Valid nonempty refs | Exactly one claim per ref, in plan order |
|---|---|---|
| SUMMARY |1..8 OBSERVATION or RESOURCE_STATE facts|OBSERVATION_RECORDED for observation; RESOURCE_RECORDED for resource|
| WHY_URGENT |Exactly1 OBSERVATION whose observationId equals requested focus|SOURCE_URGENT iff HIGH/CRITICAL; otherwise SOURCE_NOT_URGENT_IN_READ|
| SOURCE_STATE |Exactly1 RESOURCE_STATE matching focus observation's source/resourceType/nonnull connectionId tuple|RESOURCE_RECORDED|
| ENTITY |Exactly1 ENTITY whose observationId equals requested focus|ENTITY_CONFIRMED/ENTITY_UNRESOLVED/ENTITY_UNAVAILABLE exactly matching validated state|
| UNSUPPORTED |Exactly0 refs|UNSUPPORTED status,0 claims|

Any supported intent with empty refs is INSUFFICIENT,0 claims, even with a nonempty bank. Missing focus/required fact with
empty refs is INSUFFICIENT; supplying unrelated refs in its place is invalid. Wrong kind, extra refs/cardinality, missing
ref, incompatible focus/tuple/entity or nonempty UNSUPPORTED yields ASK_PLANNER_INVALID. Valid nonempty SUMMARY needs
no focus, even when the optional requested focus is missing. For example LOW focus E1 plus
unrelated HIGH E2 cannot support WHY_URGENT refs[E1,E2] or[E2]. ANSWER requires valid nonempty refs and claim count=refs count.
Each claim has EXACTLY1 ref, and that ref must be in the plan; no additional inferred claims. No free-form explanation.
RESOURCE_RECORDED means the recorded status: ERROR/MISSING is unavailable, FIXTURE synthetic, STALE old; never successful
lookup/freshness. SOURCE_NOT_URGENT_IN_READ does not mean healthy. Independent mandatory urgency notice lists exactly all
HIGH/CRITICAL observations in the bank even if omitted by the planner; only this notice can cite outside the plan.
urgentFactsOmitted warns about urgent evidence omitted from the bank. At most8 claims/32 facts; no root-cause assertion.

Answer200 exact projection: `{contractVersion:'AskAnswerV1',requestId,correlationId,workspaceId,clientId,mode:'mock',sourceMode,
status:'ANSWER'|'INSUFFICIENT'|'UNSUPPORTED',intent,generatedAt,focusObservationId,coverage,urgentRefs,claims,evidence}`.
Claims `{code,refs}` and evidence bank above; fixed UI message dictionaries render claims. Every ref must resolve once;
all scope/identity/version/mode/time/enum/cap predicates are validated again in browser. Response≤256KiB; exceeding
it fails closed413, never partial JSON. No raw question, planner plan, provider text, chat transcript or persistent answer.
RequestId must match captured request; response focus equals requested focus (including missing focus), never auto-selected.
sourceMode is fixture/db, must match current validated context; status/mode of resource evidence must be consistent.
urgentRefs≤24 unique observation refs, exactly all HIGH/CRITICAL observation facts in the returned bank. Evidence, coverage
and urgentRefs are returned/rendered for ALL statuses, including unsupported/insufficient. Empty bank or missing
focus-dependent facts with empty plan gives INSUFFICIENT with no claims; UNSUPPORTED likewise has no claims.
Claims have exactly1 ref each, unique across claims and valid for the exact matrix predicate/cardinality; claims are empty
iff status is not ANSWER. The browser rechecks intent/focus/tuple/entity/state bindings and claim-count rules; plan membership
is server-private and enforced there. All duplicate bank/observation IDs, mismatched focus/entity references,
or unexpected fields invalidate the answer in browser; no partial safe-looking subset is rendered.
