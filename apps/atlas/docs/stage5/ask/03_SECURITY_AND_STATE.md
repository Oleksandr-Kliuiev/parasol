# Authority, privacy, resources and asynchronous state

## Current bearer and client authority

Reuse accepted bearer syntax/hash and currentToken lookup; an Ask-private opaque credential retains only the digest in
request memory. No browser Actor, new token/permission or auto-grant. Required permission: context:read on one current
membership of the path client, because this slice reads only the same stored context; no tool execution is admitted.
Order on BOTH enabled routes: synchronous provisional GLOBAL owner reservation429 before the first async body/auth work
→ bounded raw size/syntax400/413 → Ask-private bearer authentication401 → POST exact body semantics400 → bind the SAME
owner to authenticated actor limits429 → POST phase1 fenced current authentication401 → membership/permission403 → source
read. Capability follows the same ingress/raw/auth/actor ownership path, returns its fixed DTO without phase1/source/audit
and never charges a question. Capacity exhaustion may precede invalid-body/credential errors; no body/DB work on refusal.
Malformed/nonexistent/nonmember path IDs
use403 ASK_SCOPE_DENIED and reason SCOPE_DENIED; a current member lacking context:read uses the same HTTP403 with reason
PERMISSION_DENIED. Denial writes exactly one workspace SecurityAuditEvent `ask.scope_denied`, requested client escaped,
fixed reason, server correlation UUID, empty metadata; no client audit/data on denial. After valid membership+permission,
missing Client row alone is404 ASK_CONTEXT_UNAVAILABLE; missing focus/resource/graph yields explicit insufficient evidence.
SCOPE_DENIED for malformed paths is an intentional Ask-only normalization of existing INVALID_SCOPE_ID diagnostics.

Ask-private authentication reuses accepted parseBearerToken/hashToken/currentToken/ACTIVE-actor semantics under the same
confined runtime/RLS policies, not the unbudgeted shared ApiTokenGuard/authenticateToken call. It resolves ONLY a current
token's workspace/actor budget key and active actor in a bounded transaction, with transaction-local settings cleared,
token lookup digest-only and DB-clock expiry; no memberships/client data/permissions read yet. Fixture uses the accepted
equality-token/actor semantics. No shared non-Ask authentication change. Auth pool maxWait≤500ms, transaction/statement
timeout≤min(2s, original remaining budget); before/after every await, no resetting deadline. Provisional owner remains
through auth timeout/disconnect until its actual query/transaction cleanup is confirmed; no phase1/audit after terminal.
Actor binding uses exact (workspaceId,actorId), not token/string concatenation. Same owner is never released/reacquired.

DB phase1, confined runtime role: clear transaction-local scope/actor/token settings; currentToken digest lookup obtains
workspace hint; set app.workspace_id to that hint BEFORE locking the workspace-scoped ActionAuthorityFence FOR SHARE
as the FIRST lock; verify existing fence readiness. Re-authenticate after lock wait, SAME workspace AND actor as private
authentication/budget binding, ACTIVE actor, current single-membership context:read; only then
set one-client RLS scope and read bank inputs. Capture fence version as exact DB integer/string, never lossy JS Number.
No schema/role/definer change and no PowerOffice readiness dependency. Actor/token/membership mutations already use
the accepted fence triggers; missing fence/role guarantees fail closed. No locks/transaction survive the planner call.
This is an explicit Ask-only read-admission exception to Stage3's FOR UPDATE invariant; frozen Stage3 actions still use
FOR UPDATE. No schema/role/readiness SQL/ACL change. FOR SHARE allows concurrent Ask readers, but blocks authority-trigger
version UPDATE and Stage3 admissions (and waits behind them), bounded by each2s phase/original remaining budget. Ask
takes no further explicit row/advisory/domain locks; ordinary existing audit INSERT/FK/index locks remain transactional.
All authorization mutations acquire the same fence first; test contention/cleanup and preserve this order to avoid cycles.

After plan validation/compile and bounded pre-serialization of an immutable candidate, DB phase2 repeats bearer/fence/current actor/permission admission under FOR SHARE (workspace hint set before lock as in phase1). If
current credential is invalid OR token rebinds to another workspace/actor return401; scope lost403; if still authorized but fence version differs, discard the answer
with409 ASK_SCOPE_CHANGED. No automatic re-read/retry. Expiry compared with the DB clock after all lock waits and again
AFTER audit INSERT (including its waits), immediately before transaction return; also recheck the original monotonic
deadline there. Expiry/deadline failure throws and rolls back the audit. Denial audit has the same post-INSERT checks;
expiry during its write yields401 and no audit. Successful/failure audit and decision commit in this final transaction before HTTP.
This is a read-admission/publication boundary, not revocation of information already received or an atomic wire send.
No source-data snapshot consistency is promised across queries; coverage/timestamps say exactly what was read.
Phase2 is bound to EXACT captured phase1 workspace/client/actor AND private authentication identity; it never follows a
new token hint into another scope. Compare epochs only within that captured workspace, even if two workspaces' integers match.
generatedAt is compilation time, not commit time. No heavy compilation/serialization after final commit.

Each final admitted answer/unsupported/insufficient or local planner failure writes one client AuditEvent `ask.completed`
or `ask.failed`, using existing clientAuditData and only existing keys: provider='fixture', ruleVersion='ask-mock-v1',
itemCount (bank count), outcome (fixed status), safeErrorCode (fixed failure only). No question, plan, answer, source IDs,
names, raw text/hash or question length. No ToolExecution/DecisionRun/new ledger. Final invalid authentication has no
client audit; final scope denial has one workspace denial. Denial/audit failure fails closed503; commit failures return
no answer and are not retried. A crash/disconnect after commit may leave an audit without a delivered answer; a manual
repeat is a new read/audit, not an idempotent write. Correlation UUID server-generated; input requestId is echoed only.

Fixture path applies accepted equality-token/client checks, same DTO/compiler caps and memory audit semantics; label
fixture authority as synthetic. DB revocation/fence claims require real disposable-PG tests, never fixture substitutes.

| Terminal outcome | HTTP / final audit |
|---|---|
| Provisional/actor capacity unavailable |429; no audit, no further raw/auth/source work after refusal|
| Raw/semantic invalid or initial invalid authentication |400/413 or401; no audit|
| Private authentication phase timeout/failure |504 ASK_DEADLINE/503 ASK_RUNTIME_NOT_READY; no audit, owner retained until cleanup|
| Scope/permission denied, credential valid through denial INSERT |403; exactly1 workspace denial, no client audit|
| Missing Client, invalid original source or source cap before planner |404/503 ASK_SOURCE_INVALID/413; no completion audit/planner|
| Planner invalid or2s planner timeout, original budget remains |503 ASK_PLANNER_INVALID/504 ASK_DEADLINE; phase2 authority then1 ask.failed if still admitted|
| Original8s exhausted |504; no NEW final transaction; in-progress transaction rolls back on post-INSERT check|
| Final authentication invalid/inactive/expired, including post-INSERT expiry |401; rollback/no audit|
| Final scope lost |403; workspace denial only, subject to original deadline/current auth|
| Still authorized but fence epoch changed |409; no client completion audit; UI says authority changed, manual retry|
| Audit/known rollback or commit failure |503 ASK_AUDIT_FAILED; no answer, no retry|
| Unknown commit outcome or deadline crossed after commit |503/504; no answer, row may exist, no retry|

Completion auditing records admitted planner outcomes, not every rejected request. Budget/HTTP parsing failures produce
no client audit. Capability GET authenticates but reads no client source and has no Ask completion audit.

## Resource budgets and privacy

Server original8s monotonic deadline on BOTH routes covers raw ingress, private authentication, admission, reads, projection, local planner, compilation, final authority,
audit and serialization, starting at enabled Ask ingress before awaiting the raw body or guard. Before/after every
awaited and synchronous phase check the same deadline; synchronous work
cannot be preempted but a late result is discarded. DB phases max2s each, pool maxWait≤500ms, each bounded also by
remaining original budget; provider phase max2s and remaining budget. Abort is courtesy, never authorization/isolation.
If insufficient remaining budget to publish, return504. A completed audit records a compiled/currently admitted result,
not delivery: commit completion or HTTP delivery may outlast the original deadline, in which case no answer is returned
but an already committed audit remains. Do not retry an unknown commit outcome or rewrite it as a new completion.

One API process:≤4 underlying Ask task owners total, including provisional raw/auth owners on BOTH GET/POST, and≤1
actor-bound owner per actor, at most64 tracked actor budget entries;10 admitted questions per actor per rolling60s.
Reserve global capacity atomically/synchronously at enabled Ask ingress before ANY asynchronous work; after authentication
and POST semantic validation, bind its existing permit atomically to actor capacity, without a release/reacquire gap.
Provisional owners have no actor entry; multiple concurrent authentications for one actor still total≤4 and only one can
bind. Capability binds actor capacity too but never charges rolling questions. Idle entries expire only when no owner
remains and their last admitted question is≥60s old (uncharged entries can be removed immediately);65th entry gets429.
Charge rolling admission ONLY after positive phase1 authority immediately before source read; source failures consume it,
invalid/denied requests do not, and charged admissions are never refunded. Monotonic clock; prune only idle expired entries.
Full capacity gives429. Never evict an active/draining entry; actor-key allocation is bounded even for denied requests.

Each permit belongs to a unique task owner and covers ALL underlying planner, DB and cleanup work, including abandoned
work after public timeout/disconnect. Public timeout stays bounded without waiting for an ignored AbortSignal; capacity
remains occupied until the underlying promise actually settles or termination is proven AND all DB commit/rollback/query
cleanup completes. A Promise.race timeout/wrapper rejection does NOT release it. Release exactly once by that owner;
late callbacks cannot release a newer request's permit or start new reads/audits after terminal publication state.
A2s planner timeout may publish its admitted failed audit while the underlying planner drains; original8s exhaustion
cannot start a new audit. Configure transaction-local statement_timeout≤min(2s, original remaining budget), in addition
to transaction/pool timeouts; unconfirmed rollback/query cleanup retains the permit and cannot reuse an uncertain connection.
Never-settling planners retain their slot until process restart: fail closed429, no accumulating replacements. This bounds
one local process, not distributed quota. Per-request deadline timers allowed; no background polling/retry/eviction worker,
provider billing or external calls. Provisional ownership covers parsing; body caps precede source/planner work.
Logs contain fixed codes/counters only.
Drop question/answer references as soon as their owning task/browser state permits; underlying ignored-abort tasks may
retain local question memory until actual settlement (at most4 owners); no persistence or claim of forced memory erasure.
No DB hash/trace/analytics, localStorage/sessionStorage,
cookie, URL query, HAR/video or source text in diagnostics. Synthetic screenshots follow accepted password-cleared,
token-free DOM/capture checks. Error paths never echo body/question, upstream exception or credential.
Allowlisted source display strings remain potentially sensitive; they are local authorized display data, not certified
secret-free text. Excluded fields never enter bank/planner/answer; included display strings never enter audit/logs or an
external planner. No regex redaction guarantee is claimed for either questions or source text.

## Browser state

Add only fixed capability GET and Ask POST to the holder/operation union, never a generic sender. Same origin, bearer
closure, omit/no-store/redirect:error/no-referrer, incremental caps and original10s browser total deadline including
decode/parse/validation; Ask success200, evidence success201 remains unchanged. Capability404 is OFF only in its own
operation; Ask404 clears answer with fixed unavailable state. Current401 globally disconnects; any current403 clears
full selected scope and refreshes picker once, no auto-selection/loop. Stale failures/401/403/finally are ignored.

Ask captures credential epoch, scope epoch, context generation, queue/selection generation, chosen focus and own request
generation. Every success/error/finally check all captured identities before state change. Client/credential/context
refresh/queue filter/page/observation change/disconnect/pagehide/bfcache reset invalidates work and clears answer/input
synchronously. Submitting twice while pending sends once; manual retry uses fresh UUID and current server read. Capability
completion has credential epoch/generation guards; no stale completion can expose input or start an Ask request.
No answer modifies accepted context/queue/detail/evidence or urgency. Safe DOM/textContent and fixed claim dictionaries
only; request-local citation buttons reveal stored answer cards, never source URLs or another scope.
