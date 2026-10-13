# ASK-B implementation brief — browser OFF/MOCK journey

Owner authorized ASK-B, fresh native claude-opus-5-5/high session de9faf68-215d-4742-8d88-503f198c1f3e; sole checkout writer after handoff.
Same-session mandatory repairs, then fresh explicit gpt-6-astra/xhigh actual-code acceptance. No self-acceptance.
Repo /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1; HEAD916a4d69853ff6da636e8609a2e0bd33aa787f66, planning/stage2-m365.
Substantial accepted dirty/untracked work: exact write baseline verification/stage5/S5ASKB_IMPLEMENTATION_BASELINE.json;
HEAD alone is wrong. Verify every baseline file and built hash BEFORE first write, then frozen dependency/norm hashes.

## Approved basis and smallest context

Read root AGENTS.md and docs/DEVELOPMENT_WORKFLOW.md, apps/operator/AGENTS.md, docs/stage5/ask/AGENTS.md, then six immutable
Ask RC3 norms (README,01_SPEC,02_CONTRACTS,03_SECURITY_AND_STATE,04_PLAN_AND_ACCEPTANCE; AGENTS is sixth). Current architecture
package a9e43a42655ddfea64577d9640fa5778bbf9acf2bd979abdb55e53459a4ab13a is dual-approved Astra/xhigh + actual Fable5.1/high.
Seal verification/stage5/S5ASK_DESIGN_APPROVED.json SHA25690b5ad7c598f5b89a193bfd7035efe1539bc13feaf0d9338d7fc7b49425e2c15.
ASK-A accepted S5ASKA-rc3 package213eec92b91a907514161c485258304e197babb42fd5c63da66e3849112f5362;
seal S5ASKA_APPROVED.json SHA2560111e76cff410a4ee7706312cbc2d062ac7fbf134b62ee3ae4cf43109500f6ab;
closure SHA2564d02d0c03f3f33d2ac251cda2332bc1d71e124200945153a760b6acd09946de8. Source/build identity verified before prep,
only declared administrative preparation differs. Accepted S5B seal/closure and eight console norms remain immutable.
ASK-A backend accepted; exact established totals326 unit/PGlite,616PG17,50browser (no failing/skipped).
Don't load historical reports wholesale. Query exact required finding only if current invariant needs it.
Existing apps/operator AGENTS says Ask was a future separate gate; the dual-approved Ask amendment and explicit current
owner request authorize this browser concern. Update only its routing text/rules for the now-approved fixed operations.

Relevant entry files: apps/operator/src/{operations,credential,transport,state,panels,controller,controller-queue,
controller-evidence,view,main}.ts, apps/operator/index.html/styles.css; tests/operator-contracts.test.ts,
tests/ui/artifact.spec.ts, tests/support/operator-{ui,journey,dist}.ts. Read narrowly, files near500/hard700.
Add focused Ask contracts/validation/transport/controller/view modules with direct imports; keep composition thin.
Browser may not import server/runtime or Node code. Tests can compare parity against packages/ask/contracts.ts read-only.

## Outcome and normative boundaries

Implement Q7/Q8 and all browser-relevant Q1/Q3/Q4/Q5/Q6/Q9 inside approved contracts; preserve console A1-A8/B1-B9.
Capability once per connected credential AFTER validated client list; guards credential epoch+own generation, no cross-epoch
cache. Only capability404 means OFF/hides input. Exact200 capability3keys+header canonical correlation, no body correlation.
Other errors fixed unavailable+explicit retry, current401 disconnect, current403 full scope reset and picker refresh once,
no auto-select/loop. Valid current context required to submit. No premature/stale capability exposing input/sending Ask.

Free input labelled textarea max2000 Unicode CODEPOINTS, reject whitespace/control/surrogate invalid input (no truncation);
optional Use selected observation checkbox captures exact current Atlas observation ID≤256, no invented narrower pattern.
Supported RU/EN MOCK examples accurately labelled exact matching; no guided tool substitute. Prominent badge:
"Ask Atlas — local synthetic MOCK; no external model". No general NLP/LLM or production claim.
Submit exactly AskRequestV1 four keys, fresh lowercase UUIDv4, captured current client path; no caller authority/tool/model/
source URL. Clear previous answer BEFORE submit, clear question input on submit, double submit while pending sends once.
Manual retry is a deliberate new question with fresh UUID/current read, no retained question/history/autoretry/polling.

Only fixed authenticated GET /ask/capabilities and POST /clients/:id/ask added to holder/closed operations. Same-origin,
bearer closure/no getter/token state/storage/DOM/log/cookie/URL; omit/no-store/redirect:error/no-referrer; no generic sender.
Ask success exactly200; existing evidence201 unchanged. Incremental Ask response≤256KiB, ordinary UTF8 request≤16KiB,
fatal decode/JSON parse/whole validation under ONE original10s browser budget including synchronous work; no phase resets.
Unknown/extra keys/enums/bad times/scopes/IDs/ref duplicates/too-large invalidates WHOLE response; no partial render.
AskErrorV1 fixed codes/body/correlation handling, no body/server exception/prose echo. Capability404 OFF only for capability;
Ask404 clears answer with fixed unavailable. Preserve current401/403 handling and stale-ignore behavior for every result.

Validate AskAnswerV1 exact fields from02, fresh explicit projections only: requestId captured, workspace/client/current
context sourceMode, mode/mock, focus equals requested including missing focus, generatedAt, closed status/intent/coverage.
Every fact ref E1..E32 consecutive unique, obs IDs unique, all scoped identities unshortened; OBS/RESOURCE/ENTITY exact shapes,
known source/type enums, times/nullability/display caps, confirmed-only entity exact ID+kind/confirmation shape. ENTITY
confirmation need not match focus source tuple; SOURCE_STATE DOES require exact focus source/type/nonnull connection tuple.
Coverage counters/flags honest bounded values; source bank32, claims8 unique refs1each, urgentRefs exactly ALL HIGH/CRITICAL
bank observations. Recheck exact compiler matrix, cardinality/focus/tuple/state/claim-code bindings; WHY lowfocus+otherhigh
must reject refs[focus,other] and[other]. Supported empty claims=>INSUFFICIENT even with nonempty bank; unsupported0claims.
SUMMARY may succeed even if requested focus missing. Do not invent private planner membership or new selection rules.
Evidence/coverage/independent urgency retained/rendered for ALL statuses. ERROR/MISSING unavailable, FIXTURE synthetic,
STALE old; absence only within stored bounded read, independent source asOf/lastSuccessAt vs generatedAt. Omission warnings,
uncertainty/conflict/superseded/entity text preserve semantics; no healthy/rootcause/exhaustive inference.

Capture credential epoch, scope epoch, context generation, queue/selection generation, focus and own Ask generation.
Every success/error/401/403/finally checks ALL before state change. Client/credential/context-refresh/filter/page/observation
or focus change, disconnect/pagehide/bfcache reset synchronously clears answer/input and invalidates pending work.
Abort alone is not isolation; test ignored aborts and late success/error/finally. Late401 must not disconnect new session;
late403 must not clear new scope; stale finally must not clear new spinner. No answer overwrites context/queue/detail/evidence.

Safe createElement/textContent only and fixed message dictionaries; citation controls reveal ONLY returned request-local
stored cards, no fetch/navigation/source links. One answer, no transcript/storage. Keyboard/focus/live regions, usable
320/768/1440 layouts. Preserve token clearing and pagehide/pageshow protections.

## Explicit shared-source deltas and write scope

Existing browser hooks allowed only for this approved concern: operations.ts (two closed ops), credential.ts (fixed bearer
operations), transport.ts (reuse bounded primitive or focused extraction preserving old behaviors), state.ts/panels.ts/
controller.ts/controller-queue.ts/controller-evidence.ts (Ask composition+generation reset hooks), view.ts/main.ts,
index.html/styles.css (safe Ask region/composition); contracts.ts/messages.ts/dom.ts/view-parts.ts only if narrow typed/UI
integration requires it, report exact reason. Independent Ask rules belong in NEW focused modules, not central accumulators.
Update apps/operator/AGENTS.md, docs/AI_CONTEXT_MAP.md, docs/RUNBOOK.md for routing/operation. Add focused unit/PG/browser tests
and small support modules. Existing tests/operator-* and tests/support/operator-* may need typed additive compatibility;
preserve all old behaviors/assertions, record each exact delta. tests/operator-contracts.test.ts adds named module/parity
classification; tests/ui/artifact.spec.ts adds ONLY approved fixed Ask route/module/literal ARIA expectations, retaining all
security/no-network/no-storage/no-dynamic-URL/tool checks. Existing UI journey tests should remain unchanged where practical.
No dependency/lockfile/tsconfig/build script change expected. Ask new modules emitted by existing build automatically.
If any extra shared-source/API/dependency/architecture change is necessary, report concrete need BEFORE editing beyond scope.

Frozen: packages/ask backend, apps/api, all other server/domain/CLI/schema/roles/migrations/source sync/providers/registry/
permissions; six Ask and eight console norms; all older reports/reviews/baselines/manifests/seals/evidence; coordinator
status/workflow/root AGENTS. dist/operator built changes expected; ALL nonoperator dist files must stay byte-identical.
No commits/PR/deploy/LIVE/ASK-REMOTE/external SDK/model/vendor/network adapter or real tenant data. Native subscription only.

## Acceptance and evidence

Focused tests during work, then final ALL14 established checks with full logs/exact counts: npm test, schema:validate,
db:generate, typecheck, ui:typecheck, ui:build, api:build, api:smoke, test:pg, db:check:pg17, db:check:drift, test:ui,
git diff --check, untracked whitespace. Retain existing50browser regressions, add real fixture+confinedPG browser journeys:
free input RU/EN summary/focus urgency/source-state/entity, supported/unsupported/insufficient with citations, changes and
disconnect; actual authorization/audit integration. HTTP mocks qualify only transport/race/malformed-response probes,
NEVER authorization proof. Check no new action/ToolExecution/DecisionRun/business writes from Ask.
Meaningful hostile validator/matrix/cap/privacy and ignored-abort/generation tests, current401/403 fullreset, capability
late/404/failure/retry, double-submit, bfcache/pagehide, question clearing, keyboard/focus/citations no network, response
10s original budget (incl synchronous parse/validate/serialize), exact request/response/correlation/status caps.
Restored-byte negative controls for NEW browser scope/ref/claim/urgency/generation guards; concrete assertion failures,
unique logs, restore exact source bytes and rebuild. Accepted backend authority/fence controls remain frozen evidence;
full currentPG suite + affected actual browser integration establish preservation, no backend mutation needed.

Fresh clean production copy npmci/generate/build/prune and foreign-cwd OFF/MOCK smoke; current manifest and ALL served asset
hashes, API/Gateway preserved, built nonoperator hashes. Record actual browser version. Synthetic visual PNGs320/768/1440,
after token input cleared and verified token/question secret-marker free; no trace/HAR/video/failure screenshots. Save
outside repo and visually inspect them. No real credential/customer data capture, no raw question/answer/exception logs;
synthetic privacy markers only in explicit test fixtures, never diagnostics/persistence/artifacts/captures.

ALL new scratch/logs/failed attempts/probes/prodcopies/PNGs under /tmp/atlas-stage5/askb/s5askb-impl/. Never overwrite older
ASK-A/review evidence. PG ONLY silent /tmp/atlas-stage3/claude-tools/pgenv.sh; NEVER read/print wrapper/env/URLs/secrets.
It enters fixed cwd: use ONE absolute scratch runner with explicit subprocess cwd for isolated tests, no shell arg guesses.
Bounded barriers, finally cleanup, stop all jobs/servers/disposable DBs. After two ineffective repairs diagnose/re-plan.
Write docs/stage5/ask/S5ASKB_IMPLEMENTATION_REPORT.md: exact baseline/deltas, behavior, checks/counts, test/negative/production/
visual evidence paths, failed attempts, risks/limits, model/effort/session and no self-acceptance. Stop at ASK-B, return sole
ownership on exit. Acceptance PENDING fresh explicit Astra/xhigh; required findings repaired SAME fresh ASK-B Opus session.
