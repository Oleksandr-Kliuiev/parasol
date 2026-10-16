# Checkpoints and acceptance

## Implementation boundaries

| Checkpoint | Deliverable | Coding/review |
|---|---|---|
| ASK-A | OFF/MOCK config, bounded HTTP parsers, private two-phase current authority, source reader/projection, planner contract/mock, compiler/citations, safe audit, fixture+DB endpoints | Fresh native Opus5.5/high; fresh explicit Astra/xhigh actual-code gate |
| ASK-B | Capability-gated free input, fixed transport, answer/citation UX, generation isolation, responsive/keyboard journeys, actual fixture+PG integration | Separate fresh native Opus5.5/high; fresh explicit Astra/xhigh actual-code gate |
| ASK-REMOTE | External inference/provider/data/billing contract and admission | NOT_STARTED; separate dual-reviewed amendment, no adapter or flag in ASK-A/B |

Before ASK-A, both architecture reviewers must approve the same current six-file package. Before ASK-B, verify the exact
accepted ASK-A source/build identity; no dependent implementation before acceptance. Keep one implementation session
per cohesive checkpoint and repairs, sole writer; original findings/failures preserved. New scope/critical invariant
changes use fresh Astra/xhigh; bounded fix re-review may retain effective xhigh. No commits/deployment implied.

ASK-A sources: focused `packages/ask/{contracts,config,input,credential,authority,read,projection,planner,compiler,budget,
audit,service}.ts` (combine cohesive modules when useful), nearest AGENTS; `apps/api/src/{db/ask,ask-fixture}.ts` and thin
module composition. Explicit shared-source delta: apps/api/src/main.ts BOTH bootstrap branches disable automatic parsing,
keep accepted Host gate first, install enabled Ask's provisional owner/raw parser/error boundary, then restore unchanged
express.json()/express.urlencoded({extended:true}) defaults ONLY for non-Ask shapes (also in OFF). Ask uses a private
parsed-body property consumed explicitly, no @Body()/second parser; private bounded credential guard leaves shared guards
unchanged. Regression goldens prove non-Ask size/type/syntax behavior. No accepted
decision provider, permission/registry, schema/migration/role, source sync, live adapter or audit allowlist change.
Read accepted context mapper/query semantics narrowly; do not import browser validators into server or duplicate a broad
ClientContext implementation. Implement a focused Ask projection reader with fixed selected fields/limits in admitted tx.
ASK-B sources: focused browser ask contracts/validation/controller/view modules and narrow existing composition/holder
hooks; relevant unit/PG/browser tests/support, context map/RUNBOOK/status/evidence. Preserve existing A1-A8/B1-B9 gates.
Any unavoidable shared-source alteration requires explicit delta, surrounding regressions and renewed affected review.

## Acceptance matrix

| Gate | Required evidence |
|---|---|
| Q1 configuration/HTTP | Default off404/unchanged API and console; unknown mode fails; mock only; exact200/version/body/lowercase UUID/unknown-key/query rejection; raw16KiB including chunked, fatalUTF8/type/encoding/JSON rejection with no question excerpt; route case/trailing/percent aliases cannot bypass private parser, HEAD/OPTIONS404 no controller/auth; exact AskErrorV1/header/no-store even guard401; private parsed body/no second read; original non-Ask100kb/strict/type/syntax JSON+urlencoded goldens (tools/execute) in OFF/MOCK; no arbitrary source/model/tool/URL path |
| Q2 current authority | PG runtime confinement, token unknown/revoked/expired/actor inactive, absent/missing membership/context:read and malformed/crossworkspace clients; one workspace denial/no client leakage; barriers revoke/expire/change permissions while phase1 waits and while planner waits; final fence change even if permissions restored yields409; token actor/workspace rebinding cannot move owner or phase2 scope even with coincident epochs; set workspace hint before fence, Ask-only shared lock contention with authority UPDATE/Stage3 admissions, no other explicit locks/cycle |
| Q3 scoped evidence | Exact focus in sameclient/all lifecycle; missing/unsupported focus insufficient for focus-dependent intents (SUMMARY still allowed); scope/enum/type/time/caps/duplicate identities invalid; whole validation before truncation; active page/bank omissions/counters honest; no finance/M365/email/raw payload; exact confirmed-only graph identity |
| Q4 untrusted planner | Unknown/duplicate/crossrequest refs, wrong kinds/focus, injected tools/URLs/prose/extra keys/refusals/deadline; exact intent/cardinality/claim matrix server+browser; LOW focus E1 plus HIGH other E2 cannot support WHY refs[E1,E2] or[E2]; supported empty plans/nonempty bank insufficient, missing focus empty vs unrelated refs; SOURCE_STATE exact tuple, ENTITY exact ID+kind+CONFIRMED Atera/Huntress; ERROR/MISSING/FIXTURE not successful read; urgent notice outside plan only and urgent omission flag; unsupported explicit |
| Q4 eligible refs/mock goldens | Paired otherwise-identical descriptors with matching vs unrelated connections; two same-system connections, missing focus/tuple, matching MISSING/ERROR/FIXTURE; server-only focusResourceRef gives positive cited answer or INSUFFICIENT, injected unrelated ref rejects; SUMMARY exact first8 observation-else-resource selection; ENTITY any confirmed same-entity/kind Atera/Huntress link qualifies independently of focus tuple, ordered confirmation; evidence/urgent notice retained for all statuses |
| Q5 privacy/audit | Synthetic secret markers in question/excluded source fields/exception never in new Ask persistence/log/diagnostic/capture; excluded fields absent bank/planner/answer; included display strings local only, absent audit/logs; no question persistence/hash/echo; fixed metadata+correlation; finalaudit commit failure returns noanswer; no ToolExecution/DecisionRun/business-table mutations; no provider/network or registry access by planner |
| Q6 bounded work | Original server8s/browser10s incl sync parse/validate/serialize; caps;4global/1actor/64keys/10per60s; four ignored-abort public timeouts keep four owners and subsequent same/new actor requests429, eventual settlement+DB cleanup releases exactly once/recovery, never-settling bounded; admission counter timing; DB cleanup uncertainty retains capacity; post-fence AND post-audit-wait expiry/deadline rollback; failure/audit matrix; no active eviction/retries/locks across planner |
| Q6 provisional auth ownership | Real PG auth barrier plus ignored-cancellation seams, >4 mixed GET/POST valid/invalid credentials; active/queued auth owners≤4, raw deadline starts before body/guard; public timeout/disconnect keeps owners until actual cleanup, no replacement/phase1/audit after terminal; exactly-once recovery, sameowner actor binding; capability/invalid/denied never charge rolling questions; shared non-Ask auth preserved |
| Q7 browser isolation | Delayed capability/Ask success/error/401/403/finally across credential/client/context/filter/page/observation/focus change; no stale answer/clear/spinner/disconnect; fullcurrent403 reset/picker once; double submit; disconnect/pagehide/bfcache; oneanswer/nohistory |
| Q8 UX and positive journeys | Actual fixture and PG free-input→answer→citation→change→disconnect; RU/EN mock supported+unsupported queries; no guided-tool substitute; badge says local synthetic MOCK; source urgency, uncertainty and storedread times; keyboard/focus/live regions and320/768/1440 synthetic PNGs |
| Q9 preservation | All accepted console A/B regressions; unchanged Stage1–4 contracts/roles/data; no action/sync/vendor/model/M365/finance route; byte identities before/after; narrow modules under700 |

Each actual-code checkpoint: all14 established checks (unit/PGlite/contextbudget, schema/generate, root+browser types,
UI/API build/smoke, actualPG17 suite, PG17 check/drift, browser E2E, tracked/untracked whitespace). At ASK-A the unchanged
browser suite suffices; ASK-B adds full Ask browser journeys. Fresh clean install/build/prune/foreign-cwd serve; actual
browser version/built manifest; synthetic visual review when UI changes. Independent reviewer runs meaningful probes;
restored-byte negative controls must catch removed current-authority/fence/scope/ref/claim/urgency/generation guards.
Barrier tests use actual confined PG and known synthetic planner injection, not HTTP mocks for authorization claims.
No trace/HAR/video/failure screenshots. No real customer credentials/data, model/vendor calls or paid route changes.

Review/acceptance binds exact package/source-baseline/built inventory, both named models/effort, actual native Claude
message model, provider/billing preflight, checks/findings/fixes/residuals and attributable usage when exposed. Quota unknown
otherwise; API estimates/cache hit ratios do not prove subscription savings. Stop each checkpoint at independent acceptance.
