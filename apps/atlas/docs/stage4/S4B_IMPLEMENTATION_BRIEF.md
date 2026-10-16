# S4-B implementation brief

Authorized continuation2026-10-09. Native Claude Code **claude-opus-5-5/high**, fresh cohesive implementation session;
Codex coordinates/integrates, fresh explicit GPT-6 Astra/xhigh accepts actual code/evidence. Stop at S4-B acceptance;
S4-C and LIVE remain separate. This brief implements the already dual-approved Stage4 architecture, not an amendment.

## Exact dependency and ownership

Start from S4A-rc5 ACCEPTED: package `7efcdf162c9912655de0f812dbbb13cef83d6adb1564111525c737c025021bd9`,
manifest `verification/stage4/S4A_RC5_MANIFEST.json` SHA `36bc34fae3c2fe78ea22b0334b66c05dc7ca52e6efe6cbfbe0c6c2fad1e60209`,
seal `verification/stage4/S4A_APPROVED.json` SHA `74b94cfc74222fa75e89555e16398f3d1bf43e8c9b64db869a548223696c51e2`.
HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`, plus accepted dirty work and declared
status-only administration. Codex verified this identity before preparing the brief. Exact delegate baseline and preflight
are `verification/stage4/S4B_BASELINE.json` and `S4B_PREFLIGHT.json`; do not treat HEAD diff as the checkpoint delta.
Codex transfers sole checkout write ownership at launch and regains it only after the writer exits/stops. No parallel writers.

Approved eight-file design remains package `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`.
Read root/nearest AGENTS and context map, docs/stage4/01–06 only relevant sections, and IMPLEMENTATION_HANDOFF.md
SHA `9f199dbb27d255f60db9f926e788cc23b5cba83722d5c0aff780a913f18b94ab`. The latter's publication/FK/replay clarifications
are mandatory. S4-A acceptance remains preserved; later B changes obtain B review rather than rewriting A evidence.

## Scope and entry files

Implement B1–B5: built-in synthetic export/session; default DISABLED/exact MOCK configuration; durable one-ACTIVE claim;
fresh one-call-per-page admission, complete bounded export, atomic publication, owned private failure continuation,
explicit recovery, cancellation/concurrency/privacy evidence. No public financial reads, API/CLI, maintain admission or
runner timeout wrapper, vendor HTTP/auth/credentials, automatic sync/retry/scheduler, binding or pilot setup.

Start with packages/poweroffice/AGENTS.md and authority.ts, binding.ts, locks.ts, contracts.ts, export.ts, aggregate.ts,
audit.ts; prisma/poweroffice.prisma and the relevant accepted guards; existing tests/support/poweroffice-fixtures.ts.
Create cohesive new modules under packages/poweroffice and connectors/poweroffice (contracts/private built-in port only).
Keep orchestration thin and files near500/hard700. Use focused new unit/PG tests and small support modules; update local
AGENTS/context-map routes to actual modules. Existing A helpers may be extended narrowly if essential, with explicit delta
and nearby regression evidence. Preserve the A3 grant/MAINTAIN/grant-option/tablespace fixes. No schema/role/migration
change expected; all23 accepted migrations+lock, norms, fixtures, historical reports/ZIPs/seals stay byte-exact. No change
to Stage1/2/3 source/public contracts; no new shared invoker routine. If an actual architecture contradiction emerges,
stop that change with evidence instead of adding authority or weakening constraints. Small default-mode env example allowed.

## Required contracts and checks

- Public B operations receive the private bearer credential and explicit client/connection, never caller Actor/authority.
  Use the accepted authority foundation: one membership all-of, fence/readiness, scoped plain Connection read, State then
  Attempt lock, current token/actor/DB clock after ALL locks. No Connection SELECT row lock after fence. No DB transaction
  or lock over source work. No secret resolver; no supplied file/script/URL/callback/port/raw DTO chooses production source.
- Trusted composition issues unforgeable session/claim/failure capabilities pinned to workspace/client/connection/company,
  lifecycleVersion, attempt/token/sequence/allocatedSnapshotId/asOf. Built-in connector contains no fetch/HTTP/OAuth.
  Deterministic synthetic pages, strict detached validators, synthetic:true receipts and fixed safe errors. Test faults
  are private in-process seams, never caller-selectable source behavior. Actual built-in behavior needs its own evidence.
- Admission alone initializes State under the fence; ON CONFLICT, then State UPDATE lock. Allocate identities once, persist
  ACTIVE with DB startedAt, +60s readDeadlineAt/+80s deadlineAt; sequence and State lastAttempt update + safe audit atomic.
  Existing ACTIVE returns BUSY even expired;1000retained attempts returns SYNC_LIMIT before any source call. No admission retry.
- First and every later page require fresh current sync/binding authority and exact owned active claim; one invocation per
  admission, no page retry. Conservative monotonic anchor precedes final admission DB-clock read; pool/lock waits consume
  original60s. Per-page deadline min(now+10s, original read deadline); no timer/window restart after await. Abort checks
  before/after built-in work, in-flight cancellation honored, late results inert. Dispose buffers/IDs on every exit.
- Validate complete header/company/asOf/export/ordinal/count/kind/currency/money/date/bytes/duplicates BEFORE contribution.
  Reuse accepted ExportAccumulator; malformed/incomplete/overflow/timeout/unknown failure aborts whole export, preserves
  previous snapshot. No staging/raw invoice IDs/bodies persisted or logged. Complete fact detached/frozen, exact BigInt.
- Publication uses allocated IDs/sequence and SAME complete fact; fence → plain Connection → State → Attempt, fresh auth,
  unchanged FIXTURE binding/version, ACTIVE and actual DB clock<original deadline. Snapshot/pointer/SUCCEEDED/completed
  metadata/lastSuccessAt/audit commit together. Stable audit identity survives lost acknowledgement. Changed fact with
  reused identity is PUBLICATION_CONFLICT. Full identical SUCCEEDED receipt after deadline is a no-op after fresh sync
  authority/unchanged binding, no financial payload/duplicate audit. No generic unknown-commit fallback/new export.
- Only positively known rollback40P01/40001 permits max3 total publication transactions with same immutable fact/IDs,
  fresh authority/binding/time each time and ZERO extra source calls. Exhaustion fixed PUBLICATION_CONFLICT, claim remains
  recoverable. Admission/page/recover never auto-retry. Unexpected/ambiguous commit stays visible fixed error.
- Private failure capability can close only its own still-ACTIVE claim before original80s despite caller revocation/binding
  loss, with fixed allowed code, audit/lastCompleted update, no source/read/publication authority or old snapshot mutation.
  Terminal replay no-op. Same bounded known-rollback rule may record failure; audit/persistence failure leaves ACTIVE for
  explicit recovery. At/after deadline private failure cannot mutate. No claimed success on unknown persistence outcome.
- Explicit recovery fresh sync authority, no source I/O, no State initialization. Before deadline RECOVERY_NOT_DUE;
  at/after deadline ABANDONED + clear active pointer + completed metadata/audit atomically. Allow current DISABLED/advanced
  lifecycle in same immutable synthetic binding, no reactivation. No ACTIVE returns NO_ACTIVE_ATTEMPT with zero audit/domain
  effects, including lost successful publication acknowledgement. Late old result cannot publish. New sync is new attempt.
- Mandatory FK residual: INSERTs implicitly KEY SHARE Connection/Actor after fence; direct tuple mutation can deadlock.
  Real PG tests cover Stage4 and Connection UPDATE each being victim at admission/publication, fixed outcomes/no partial
  effects, next command sees committed lifecycle. Do not add Connection FOR UPDATE or broaden grants to hide the problem.
- Tests cover parallel BUSY/expiredBUSY/cap, fresh page authority/revocation/last-lock expiry, forged capabilities/pins,
  whole-export rejection preserving prior snapshot, publication audit rollback/idempotency/conflicting replay/retry identity,
  crash/recovery/disable drift/late completion/privatefailure/auditfailure, original real-time bounds/pool/lock waiting and
  actual built-in cancellation (trusted fault mocks alone insufficient). Pure validators can use deterministic dates;
  service deadlines require stored DB-clock comparisons/conservative real waits, no caller clock override. Batch long waits
  where meaningful. Capture audit/log/error/source-call privacy and synthetic network trap with positive self-control;
  actual HTTP/CLI journey and C-only read precedence remain deferred.

## Safety, evidence and stopping checkpoint

Disposable PG17 DBs/unique roles ONLY via silent `/tmp/atlas-stage3/claude-tools/pgenv.sh`; never read wrapper/.env/private
pilot/config credentials or print URLs/tokens. No persistent schema/tenant/account/vendor changes. Shared/global/builtin/
host-capable ACL tamper ALWAYS uncommitted, guaranteed outer rollback and separate observer. DB-local synthetic fixtures
may use commit with finally repair/drop; never describe that as universal no-PUBLIC-commit evidence. No real tablespace
storage/host/file/network/credential operation. Test-only network trap uses local synthetic endpoint and safe positive control.
Preserve all failed runs/negative controls; after two ineffective repairs diagnose/re-plan, no blind retries.

Run focused meaningful tests, then once on final checkpoint source: npm test, schema:validate, db:generate, typecheck,
api:build, api:smoke, test:pg, db:check:pg17, db:check:drift, git diff --check and untracked whitespace. The delegated command
wrapper is `/tmp/atlas-stage4/s4b-tools/checks.sh rc1`. Report changed paths, implemented gates, actual counts/commands,
failures/residual risks, model/effort/provider/elapsed, source identity and ownership return. Do not update review/status/
verification evidence yourself. Codex freezes exact package/logs and fresh explicit Astra/xhigh independently accepts it.
