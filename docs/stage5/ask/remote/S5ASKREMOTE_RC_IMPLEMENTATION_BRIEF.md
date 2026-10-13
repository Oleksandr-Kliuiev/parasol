# ASK-REMOTE R-C execution brief

Owner explicitly authorized R-C preparation and implementation through a FRESH native `claude-opus-5-5`/high session,
then fresh explicit `gpt-6-astra`/xhigh actual-code acceptance. Mandatory fixes stay in that SAME implementation session.
Native included subscription only; no API/credits/fallback or premium speed. A subscription limit leaves implementation
or acceptance pending; do not substitute another model. R-C stops at its accepted offline engineering checkpoint.

Repo `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`,
branch `planning/stage2-m365`. Preserve the complete dirty/untracked baseline, not HEAD alone. Before any write verify
`verification/stage5/S5ASKREMOTE_RC_IMPLEMENTATION_BASELINE.json` exact pathset/hashes (itself excluded), all244 compiled
outputs, approved norms and dependency seals. Preflight is `S5ASKREMOTE_RC_PREFLIGHT.json`; actual response-model stream
must establish identity. Sole checkout writer after handoff is Opus, including builds/formatters/snapshots; no other agents
or model subprocesses. Codex regains ownership only after CLI and all own subprocesses end.

## Accepted basis and smallest context

R-B `S5ASKREMOTE-RB-rc2` is ACCEPTED by fresh Astra/xhigh, required findings0. Exact identity was independently verified
before preparation:1296 working files,244 compiled outputs,1231 archived source files. Package
`a579f960a041b5bcd39f1f6eb6eb773015a4911dee9a04c00c76b4f9472f5337`; manifest SHA256
`130cc342b2fcd3d6696a5bdf135624b45bb6b3552a76761296223330d6a9630c`; seal SHA256
`560f0ed3666f14af2c15a6ec4817070fe35a6f12c37ff556ae0c54e187f2e333`; closure SHA256
`0b5c7e4056511f1d3a1e04f6e9d2ede03a78b8122f87bac2ba3a8cc87630fd62`.
R-A, ASK-A/B and console acceptance remain dependencies. No R-A/R-B product code changes are authorized here.

Remote DESIGN RC2 ten-file package `9c92327f6a3d693031c30cc907091f6dd61f4e0747491e10f00a784f877719d3` is dual-approved
by fresh Astra/xhigh and native actual Fable5.1/high; seal `S5ASKREMOTE_DESIGN_APPROVED.json`, closure
`S5ASKREMOTE_DESIGN_CLOSURE_VERIFICATION.json`. R-C is explicitly covered by02 contracts and05 acceptance. Ordinary
implementation choices within them need no new architecture review. A material contradiction/public-contract/authority
change must stop for renewed dual approval. Ten remote norms and six Ask/eight console norms stay byte-identical.

Read root AGENTS.md, relevant rows of docs/AI_CONTEXT_MAP.md, docs/DEVELOPMENT_WORKFLOW.md roles/handoff/provider sections,
docs/stage5/AGENTS.md, docs/stage5/ask/AGENTS.md, remote AGENTS.md/README.md/DESIGN_STATUS.md,02_CONTRACTS.md and05_ACCEPTANCE.md;
03/04 only for a specific boundary. Browser instructions: apps/operator/AGENTS.md. This accepted amendment and current
brief supersede parent OFF/MOCK-only prohibitions ONLY for R-C's reviewed browser journey. No live activation is granted.
Query histories only for a named finding; do not load whole history/generated assets/node_modules/logs.

## Deliverable and write scope

Add exact REMOTE V2 capability/request/answer support to the local operator console, disclosure, per-question consent,
policy/disclosure generation isolation, offline unit/browser/PG journeys and runbook guidance. Preserve accepted OFF/MOCK
wire and behavior exactly, including focus persistence after submit and MOCK typing during pending work.

Permitted product areas: focused `apps/operator/src/ask-*`, `validate-ask*`, `controller-ask*`, `view-ask*`, narrow integration
with operations/credential/state/controller/panels/main and existing index/styles where necessary. Keep credential ownership
private. Extract cohesive shared factual-validation/controller boundaries rather than create loose duplicate V1/V2 stacks.
No backend, Prisma/migration/roles, provider adapter, financial ledger, auth, dependency/lockfile/tsconfig or unrelated-domain
changes. Existing server V2 contracts are authoritative. Only narrow context routing/source AGENTS/runbook updates allowed;
root status/brief/baselines/preflight and all earlier reports/reviews/seals/manifests are immutable during implementation.
Tests/support may add offline synthetic seams through explicit test construction, never a production HTTP/env bypass.
Modules cohesive, near500/hard700 lines; direct imports, thin orchestration, DOM only in existing view/dom/main boundaries.

Entry files: apps/operator/src/{ask-contracts,validate-ask,validate-ask-facts,ask-transport,ask-state,controller-ask,
ask-messages,view-ask,view-ask-answer,operations,credential,state,controller,panels,main}.ts and index.html/styles.css.
Tests: operator-ask-{validate,transport,controller}, operator-contracts; ui/ask-{fixture,pg,races,visual}.spec.ts;
support/operator-ask{,-ui}.ts and ask-remote-{api,http-fake}.ts. Server contracts read-only: packages/ask/remote/{contracts,
answer,input}.ts. Existing R-B offline DB seam may support a focused synthetic browser test server; no production injection.

## Exact V2 boundary and privacy

Only existing GET `/ask/capabilities` and POST `/clients/:id/ask`, through the private credential holder. No caller URL,
method/header/model/provider selection, generic proxy, key entry, policy editor or admission toggle. GET ordinary404 alone
means OFF. Exact200 MOCK V1 remains accepted; exact200 REMOTE V2 requires every disclosure key/value from02. Validate
admissionId lowercase UUIDv4 and canonical positive policyVersion string≤9223372036854775807, never Number coercion.
Reject extra/missing/wrong keys, malformed profile/region/dataClass/retention/reserve and mismatched mode/version.
503 NOT_ADMITTED is unavailable, never OFF. Capability is informational, not proof of authority or admission.

REMOTE POST is exactly the five-key AskRequestV2 from02; capture explicit current disclosure acknowledgement, original
unchanged question and focus before clearing. No acknowledgement injection/default in a generic transport helper; validate
the closed operation before sending. Each manual submit has a fresh lowercase UUIDv4. Missing/unchecked/stale consent
sends NOTHING. One pending question, no automatic retry/fallback/poll. No question trimming/sanitizing/history/storage/log.

REMOTE answer is EXACT15 V1 keys plus fixed provenance, AskAnswerV2/mode remote/sourceMode db. Require captured remote
capability and full request/workspace/client/focus binding. Share strong V1 fact/bank/claim/coverage/urgency predicates;
reject whole malformed answers, wrong version/mode/provenance, unknown fields or partial projection. OFF/MOCK predicates
must not weaken. Do not reinterpret a provider error as a successful UNSUPPORTED or mock answer.
Keep fixed AskErrorV1 header/envelope/status validation; remote code allowlist from02. Upstream401/403/404/429/5xx are
server503 ASK_REMOTE_UNAVAILABLE; never disconnect/clear scope/OFF for them. Actual current browser401/403 preserve
accepted behavior; stale errors cannot change current authorization. No raw response/error body rendering.
Keep original10s across serialization/send/incremental≤256KiB/fatalUTF8/whole validation and safe DOM/textContent/local
citations. No external resource, analytics/request-body instrumenter, storage, cookie, URL or durable state for questions,
answers, token or checkbox. No HAR/trace/video; synthetic screenshots only after token/question empty and marker-free checks.

## Disclosure, consent and generation rules

Visible REMOTE text: “OpenAI GPT-6 Luna interprets the question; Atlas compiles facts locally.” Explain that the original
question and focus-present flag leave Atlas, stored evidence does not; paid API usage is separate from subscriptions;
retention is owner-verified; synthetic questions only. Show: “Up to US$0.30 reserved per attempt; unknown outcomes retain
this reservation.” Only fixed local disclosure text; no arbitrary links. REMOTE lists four supported tasks; MOCK examples
and MOCK label remain only in MOCK. Keyboard labels/live regions and320/768/1440 layouts remain usable.

Separate initially unchecked checkbox: “I consent to sending this question to OpenAI and confirm it is synthetic.” Manual
check on EVERY question. Reset on edit, submission, credential/scope/context/queue/page/filter/observation/focus change,
capability refresh/version change, disconnect/pagehide/bfcache. Capture acknowledgement/focus BEFORE synchronous clearing
input/consent; retain submitted focus choice as ASK-B does. Consent never transfers to a new draft. No question in state.

Disclosure/policy generation joins credential/scope/context/queue/selection/focus/request guards for EVERY completion,
including success/error/401/403/finally/spinner cleanup. REMOTE edit invalidates older pending work, clears consent/old
answer while preserving the newly typed draft; this REMOTE-only hook must not alter MOCK typing behavior. Both deliberate
focus directions in READY/PENDING synchronously clear draft/answer/consent. Abort alone never establishes isolation.
Capability refresh invalidates previous work and consent even if tuple repeats. A current policy409 clears input/answer/
consent, marks unavailable and offers explicit capability refresh; no auto refresh/resubmit and no revived old question.
Late success/error/auth/policy409/finally/citation callbacks cannot reset authorization or clear a newer draft/spinner.

## Verification, evidence and stopping gate

No provider network even with dummy keys; no real data/key/account access, paid inference, policy/client admission or
ask:remote grant shipped. All production accounts/admissions inactive. Tests may create disposable synthetic PG admission
and synthetic resolver/transport in a test-only server; prove no external call and remove only owned resources afterwards.
R-EVAL, real TLS/provider quality/latency, customer use, LIVE/deployment/PR/commit/background work remain NOT_ADMITTED.

Scratch ONLY `/tmp/atlas-stage5/askremote/rc/impl`; other checkpoint scratch and evidence READ ONLY. Capture prewrite proof
and metadata-only PG resource inventory BEFORE PG. Use silent `/tmp/atlas-stage3/claude-tools/pgenv.sh` with ONE absolute
executable runner and explicit child cwd/argv. Never read/print wrapper/env/DBURLs/secrets. Four pre-existing atlas_it DBs
of unknown ownership untouched. Preserve every failed attempt and its diagnosis; after two ineffective repairs diagnose,
do not blindly repeat. An isolation failure or architecture contradiction requires immediate escalation.

Focused units: exact V1/V2 parity and version/mode/provenance rejection; BigInt edge cases; no-consent/no-POST; exact
question/ack capture+clear; refresh/409 and current vs stale401/403/503; ignored-abort stale successes/errors/finally in BOTH
focus directions and every reset boundary; old citations/local facts/caps/timeout/privacy. Real browser E2E: synthetic
REMOTE success, malformed answers, non-admission, policy409→manual refresh→new consent/newUUID, typing during pending,
credential/client/context/queue/page/filter/focus/pagehide/bfcache and late response/newer spinner. Include real disposable
PG + confined runtime through the accepted server journey and offline provider seam, distinguish it from route-stub tests.
Keep all405 unit/PGlite,687PG,73browser behaviors. No removed/weakened earlier assertions; add focused fixtures/tests.

After focused checks run ALL14: npm test, schema:validate, db:generate, typecheck, ui:typecheck, ui:build, api:build,
api:smoke, test:pg, db:check:pg17, db:check:drift, test:ui, git diff --check, untracked whitespace. Clean sealed-source install/
generate/build/dev-prune/foreigncwd OFF/MOCK browser/assets and inactive REMOTE startup with network trap; reproduce exact
current compiled outputs (operator changes expected, old server modules unchanged). No claim of live/provider proof.
Meaningful isolated mutants for consent bypass, generation/policy guards, wrong V2/provenance/bank, stale auth/finally and
mode downgrade; retain pristine identity and honest redundant-layer survivor qualifications. Prior R-B mutants are frozen
historical proof, not substitutes for R-C regressions. Test meaningful invariants, not implementation mirroring.

Write NEW docs/stage5/ask/remote/S5ASKREMOTE_RC_IMPLEMENTATION_REPORT.md with changed paths/behavior, checks, preserved
failures, model/high/session/elapsed and PENDING fresh Astra/xhigh. Scratch EVIDENCE_INDEX.json binds baseline/prewrite,
files{path:sha256},14check commands/results/logs/counts, production/mutation/cleanup evidence; scope-final.json has exact
changedExisting/added/removed/builtDelta and immutable server/norm/dependency/history proofs. Finish ALL subprocesses and
cleanup before returning ownership. Codex packages exact source/evidence; fresh Astra/xhigh independently accepts it.
Required fixes use this SAME R-C session. Stop R-C; no R-EVAL/paid/live activation or dependent checkpoint work.
