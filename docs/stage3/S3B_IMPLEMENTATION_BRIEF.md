# S3-B implementation handoff

Scope is the already dual-approved MOCK architecture S3-design-rc4, eight-file package
`e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c`.
S3-A is accepted as S3A-rc3, package `754eee15cf8e89cd7f61d8914f4796d3a5314f44e41169fac33145495134a51c`;
verification/stage3/S3A_APPROVED.json records the exact administrative deltas after acceptance. This brief routes existing
requirements; it does not amend architecture. Owner requested continuing with S3-B. LIVE remains deferred.

## Writer and stopping checkpoint

Native Claude Opus5.5 (`claude-opus-5-5`), explicit high, native Anthropic subscription only, no API/usage credits/fallback.
Fresh implementation session for this cohesive checkpoint; retain it for its related repairs. Sole checkout writer from
Codex's explicit handoff until it finishes or is confirmed stopped. Preserve all preexisting dirty source; no commits,
branch changes, PR/deployment/account work, provider/LIVE calls, pilot/config inspection or persistent DB operation.
Only own disposable PG17 databases/roles. Stop after S3-B evidence; first actual acceptance is fresh explicit Astra/xhigh.
No S3-C synthetic port, create/read dispatch, publication, verification/recovery services or operator CLI yet.

## Minimal entry context

Read nearest AGENTS, docs/DEVELOPMENT_WORKFLOW.md current routing, docs/stage3/02_CONTRACTS.md approval/reservation sections,
03_DATA_AND_CONCURRENCY.md signing proof/locking, 04_EXECUTION_AND_PORT.md reservation capability paragraphs,
05_IMPLEMENTATION_PLAN.md S3-B row and 06_ACCEPTANCE.md B1–B5/R1/R2. Source: packages/actions/{contracts,canonical,
private-file,policy,authority,requests}; prisma/actions.prisma and lifecycle/history/claim sections of migration
202610091100; roles.sql, graph/{fence-role,runtime-role}; support/action-fixtures, pg-harness and relevant action tests.
Query narrowly; no historical collections/full diffs/logs/migration history. Hash manifests programmatically.

## Approved behavior to implement

- Cohesive approval/rejection/revocation/cancellation, signer/binding guard and reservation/permit modules; direct imports,
  thin orchestration, roughly500 lines per active file, hard700. Preserve accepted S3-A retrieval/read/privacy behavior.
- Fresh current opaque bearer admission for every service. context:read + actions:read + command-specific grant all-of on
  ONE client membership; no workspace-admin inference or actor DTOs. Original requester and approver are independent ACTIVE
  actors. Approver may approve with no request grant. Recheck stored requester request/read/context, original signer expiry
  snapshots and exact epoch/binding behind the fence. Never add signer ApiToken SELECT policies/views/functions/hash storage.
  Signer Actor/membership reads may use the existing confined actor context, then restore caller scope and clear token hash.
- Approve exact STORED_ACTION_PREVIEW loaded from protected0600 file: exact whitelist/all exported fields + expected hash
  compared to immutable DB request; requester input never replaces stored content. Self approval refuses. Existing APPROVED
  replay only for same signer with matching content/hash and current authority: no decision/audit mutation or TTL renewal.
  Other decisions/signers and terminal outcomes refuse; fresh approval only on AWAITING_APPROVAL.
- Approval TTL is DB clock +15 minutes capped by BOTH immutable requester expiry and approver signing expiry (nullable means
  no cap). Pending request itself has no added TTL. Re-query DB clock AFTER all request/approval locks; caller's own captured
  expiry may elapse while waiting too. No caller-supplied time. Epoch mismatch is permanent invalidation, no restored rights
  or expiry edits can rebind/renew old intent. Stored deployed policy/port versions must match at approve/reserve.
- Guard loss before reservation commits INVALIDATED (version drift ACTION_CONTRACT_VERSION_CHANGED), natural expiry EXPIRED,
  revokes unconsumed approval and writes safe audit atomically. Return fixed refusal AFTER commit; do not throw away this
  terminal outcome. Unauthorized fresh client/grant admission instead follows existing single workspace-denial audit.
- Original signer alone may explicitly revoke with fresh approve/read/context and exact request/hash. Repeated own revoke
  returns stored revoked result with no mutation. Requester alone may cancel before reservation (request/read/context);
  approved decision is revoked atomically. Reject pending request with approve/read/context. No terminal revival. Any
  cancel/revoke/reject after reservation refuses ACTION_ALREADY_RESERVED; never suggests a prevented effect.
- Reservation: fence -> request -> approval -> attempt, READ COMMITTED, no explicit auth/Connection row lock. Revalidate
  current executor execute/read/context, stored requester and approver rights/ACTIVE/expiry/epoch/binding/policy. Consume
  approval + unique lifetime attempt + DISPATCH_RESERVED request + audit in ONE transaction. No port call or automatic
  pre-dispatch SQL retry. Concurrent reserve/cancel/revoke is deterministic; rollback/deadlock/cancel means no permit/effect.
- Only successful commit may return a private WeakMap-bound, mode/binding/hash/create-nonce-bound permit. Consume exactly
  once, within the existing five-second start deadline and before approval expiry; don't renew deadlines at commit or replay.
  No caller timestamp, serialized permit, fabricated handle or public body/binding/token/nonce output. Test this capability
  as a local primitive with zero actual create/read/provider calls. Failed/expired consumption never resets the durable
  attempt latch. S3-C will implement dispatch/fact publication; do not add it now.

## Integration and preservation

Grow runtime grants/readiness for ONLY S3-B writes: approval/request mutable columns, approval/attempt INSERT as needed;
immutable intent/signer/hash/epoch/binding/nonce fields and result/verification/mock writes stay inaccessible. Preserve
all fence-definer routine identity hardening (public schema + exact signature, PUBLIC shared-invoker allowlist, extra EXECUTE
rejection), role memberships/attributes, cleanup surface and original ApiToken policies. Existing protected tables and
exact grant checks remain enforced; scoped FORCE tests use confined runtime, not unscoped nonsuperuser owner observation.
Update focused area AGENTS/context map/workflow routing and administrative Stage3 status for this checkpoint.
ALL already accepted migrations (now20 + lock) are frozen. Any necessary SQL adjustment is a new additive migration,
never edit 202610091000/1100. Frozen Stage1 report, Stage2 normative11 (including ROADMAP) and Stage3 normative8/review
snapshots stay byte-exact. Preserve S3A_APPROVED/manifests/evidence/reports. If installed SQL/contracts cannot support the
approved behavior, diagnose and report before changing architecture or critical invariants; no silent amendment.

## Checks and evidence

Meaningful B1–B5 tests: no permission merging/admin shortcut, approver without request grant and exact protected content,
replay/no renewal, cross-actor/client refusals, both expiry caps and natural expiry after locks, actor/token/member/Connection
mutation/remove-restore/noop invalidation, terminal denial audit commit and rollback, original signer revoke/repeat/requester
cancel/reject, concurrent reserve/revoke/cancel/disable and one attempt/permit, known rollback fixed errors with zero calls,
immutable SQL fields/extra grants/readiness, Stage2 and S3-A regression/upgrade. Preserve prior routines/FIFO/nullable-CHECK tests.
No tests just mirroring implementation. Two ineffective repair attempts require diagnosis/replan, critical failure escalation.
Run focused checks during work then all ten: npm test, schema:validate, db:generate, typecheck, api:build, api:smoke, test:pg,
db:check:pg17, db:check:drift, git diff --check plus untracked whitespace. Fresh private log directory, preserve old logs.
Don't print .env, DB URLs, bearer/token values, protected file content/paths or private pilot settings.
Deliver verification/stage3/S3B_IMPLEMENTATION_EVIDENCE.json with exact supplied baseline/current dirty hashes/delta,
commands/exits/counts, fixes/risks, model/effort/session/elapsed and write handoff. Implementer report is not acceptance.
Codex freezes the actual artifact and launches fresh Astra/xhigh; do not mark S3-B accepted or start S3-C yourself.
