# Scope and user journey

## Useful first slice

From a validated selected client, the operator asks a free-text question and gets a bounded answer grounded in Atlas's
stored Atera/Huntress context. Supported intents: summarize this bounded read, explain the selected observation's source
urgency, show its stored source-read state, or explain its confirmed/unresolved entity reference. No question chooses
another client, discovers a person by name, supplies authority, invents source facts or executes a tool/action.
Examples: “What needs attention?”, “Почему это срочно?”, “How fresh is the evidence?”, “Which device is confirmed?”.
Questions about root cause, remediation, historical exhaustive search, another client, finance/M365 or unknown intents
return an explicit unsupported/insufficient answer; they never trigger a broader read or tool fallback.

The answer presents source severity independently of Atlas route/confidence/priority, fixed explanations and evidence
cards with request-local citations. Scope, bounded coverage, independent source times, stale/missing/error/fixture states
and uncertainty stay visible. An absent item means only absent from this stored bounded read. No “client is healthy”,
exhaustive absence, root-cause conclusion, automatic recommendation or authorization claim is inferred.

## OFF/MOCK boundary

`ATLAS_ASK_MODE` accepts exactly `off` (default) or `mock`; unknown values fail startup. Off omits both Ask routes.
Mock works with fixture and disposable DB-backed API. It exercises the actual authorization/read/compile/audit/HTTP/UI
path with a local deterministic planner. Its small documented RU/EN intent recognizer is a simulation, not an LLM;
unrecognized questions are unsupported. Test injection may replace only this private planner with deterministic replies.
The UI prominently says “Ask Atlas — local synthetic MOCK; no external model”. This is an engineering checkpoint,
not production Ask acceptance. It is not an unconnected chat placeholder or a replacement guided tool form.

This contract approves no external planner implementation. Raw question text can contain sensitive content and cannot
be declared sanitized by regex. It stays in local request memory, is never logged/persisted, and is never sent externally.
No existing OPENAI key, Decisions mode, environment endpoint or tool registry entry can activate Ask egress. A later
external-inference amendment must review question handling/consent, data minimization, exact provider protocol/model,
billing/budgets, retention, response identity, evaluations and live admission before implementation/activation.

## UI

After authenticated capability discovery and valid context, show a labelled textarea (max2000 codepoints), optional
“Use selected observation” checkbox and Submit. Focus is optional and captures an exact current observation ID; the
question does not parse names into IDs. No tool picker/model selector/client/workspace override or source URL input.
Clear previous answer before every submit; clear question input on submit; retain one answer only, no chat history,
polling or automatic retry. A different client/credential/context/queue page/filter/observation clears answer and pending
work immediately. An answer is an older separate read: it never overwrites queue/detail/evidence state.
Citation controls reveal only evidence already returned with that answer; they do not fetch or navigate externally.
Keyboard, focus/live announcements and320/768/1440 layouts match the accepted console. Off hides the Ask input.
