# Stage 3 implementation status

Architecture: S3-design-rc4 (verification/stage3/S3_DESIGN_APPROVED.json), MOCK only. Live: DEFERRED_BY_OWNER.
Implementer reports are not acceptance. Each checkpoint needs actual independent Astra/xhigh acceptance first.

| Checkpoint | State | Evidence |
|---|---|---|
| S3-A | ACCEPTED — S3A-rc3, fresh GPT-6 Astra/xhigh; F1–F4 and F1-R1 closed | [Acceptance](reviews/ASTRA_S3A_RC3.md); verification/stage3/S3A_RC3_IMPLEMENTATION_EVIDENCE.json |
| S3-B | ACCEPTED — S3B-rc2, GPT-6 Astra/xhigh; RC1-F1/F2 closed | [Acceptance](reviews/ASTRA_S3B_RC2.md); verification/stage3/S3B_APPROVED.json |
| S3-C | ACCEPTED — S3C-rc2, GPT-6 Astra/effective xhigh; RC1 R1–R3 closed | [Acceptance](reviews/ASTRA_S3C_RC2.md); [seal](../../verification/stage3/S3C_APPROVED.json) |
| S3-LIVE | NOT_STARTED — LIVE DEFERRED_BY_OWNER; no vendor adapter, network transport or live write exists | — |

## Accepted S3-C artifact

Stage 3 MOCK engineering is complete: S3-A/B/C are independently accepted. S3-LIVE remains NOT_STARTED and DEFERRED_BY_OWNER.

S3C-rc2 package `212005fd24b4f23a810ccc9afb2f3213ff7f67ae50f226ac51e8b3b0379e521b`, 608 source files / 641 inventoried files.
[Manifest](../../verification/stage3/S3C_RC2_MANIFEST.json), [source archive](../../verification/stage3/S3C_RC2_PACKAGE.zip),
[acceptance seal](../../verification/stage3/S3C_APPROVED.json), [Astra acceptance](reviews/ASTRA_S3C_RC2.md).
Source archive SHA-256 `1633a93d6c9262abf813debed54b13dd146de1d456860effd060f4995744fac7`.

First review: fresh explicit gpt-6-astra/xhigh; RC1 CHANGES_REQUIRED. The bounded RC2 re-review continued the same reviewer
at retained effective xhigh and closed R1 (built-in cancellation), R2 (identical conflict/stale audit replay), R3 (CLI synthetic marker).
Native Opus5.5/high implemented and repaired S3-C in the same cohesive session, observed response model only claude-opus-5-5;
2563.4s initial implementation + 1143.0s repair. Native subscription; attributable quota unavailable, cache/API estimates are not quota.

All ten final checks plus whitespace passed: **181 unit/PGlite and 401 PostgreSQL**, PG17.11, schema validation/generation,
typecheck, API build/smoke, zero schema drift. Independent Astra: **35 tests (31 PG + 4 unit)** plus the original blocked-create
probe and concurrent-receipt probe. Eight identical conflicting/stale publications each produce one audit; the original
pool3s/lock16s scenario ends UNKNOWN at approximately15s with zero ticket rows. [Repair evidence](../../verification/stage3/S3C_RC2_IMPLEMENTATION_EVIDENCE.json).

Residual limits: exact equal-instant timing is not deterministic; early abort cannot immediately interrupt Prisma's blocked SQL,
but the original deadline bounds it and observed cancellation before COMMIT rolls it back. An in-flight COMMIT can remain
ambiguous/UNKNOWN. Durable fact receipts depend on append-only audit rows; future retention must preserve equivalent replay protection.
Only administrative deltas in the seal follow acceptance; accepted source/tests/migrations remain byte-exact. No pilot, vendor or LIVE operation.

## S3-C RC2 repair delta (accepted in RC2)

RC1 (package `99529a43db18f4087dca4afabc1d7352ed1fcf3569c96e5435d9a5aa6c372485`) is CHANGES_REQUIRED, not accepted. Bounded repair in the
same session; no migration, grant, contract or authority change:
- R1: the built-in port binds create/read work to the invocation's ORIGINAL deadline (PortCall = AbortSignal + the instant
  it fires): no pool wait/transaction once cancelled, maxWait/timeout capped by the remaining time, statement_timeout = time
  left after acquiring the connection (blocked SQL cancelled by PostgreSQL), re-check before COMMIT (cancelled work rolls
  back), promise settles only after commit/rollback. Ambiguous commit races stay OUTCOME_UNKNOWN; no port retry.
- R2: every fact audit row has a deterministic keyed ID (HMAC-SHA256 keyed by the attempt token / claim nonce, UUIDv8
  layout; no private value in metadata or ID). Identical conflict and stale facts are recognized by that committed row
  under the publication's locks: no-op, first audit retained, distinct facts audited once; durable across restart; a
  rolled-back attempt leaves no receipt, so retries record once within the three-attempt bound.
- R3: every action CLI envelope (usage and missing-configuration failures included) carries synthetic:true.
- Tests: tests/pg/action-port-cancel.pg.test.ts (real built-in port: pool wait, blocked SQL, abort before COMMIT, real
  15 s dispatcher scenario), tests/pg/action-replay.pg.test.ts (both reproductions, distinct facts, restart, audit rollback,
  40001/40P01 retries, privacy), R3 cases in tests/action-cli.test.ts and an envelope assertion in action-cli.pg.

## S3-C implementation delta (RC1; CHANGES_REQUIRED — superseded by the RC2 repair above)

- Code: packages/actions/mock-port.ts (internal TicketPort; only the built-in scoped ActionMockTicket store), attempts.ts
  (request → attempt → ordinal locks, recovery-due rules, safe summary), publication.ts (all post-dispatch facts; never the
  fence/approval/auth/Connection; exact private capability; ≤3 same-fact runs on 40P01/40001; identical no-op; stale claims
  inert), execution.ts (reservation → one permit use → one createOne, 15 s AbortSignal → publication → separately authorized
  initial read; owned late continuation), verification.ts (fenced claim of ordinal 1..3, protected reconciliation file,
  15 s read, exact match), recovery.ts (explicit action-recover after 35 s), packages/ops/actions.ts (all eleven action-*
  commands; routed by scripts/ops.ts before the unchanged Stage 1/2 parser).
- Adjacent accepted sources: reservation.ts (dispatch carries executor/correlation for safe publication audit;
  takeReservationPermit returns a spent dispatch only for a late first use so NOT_DISPATCHED can be published; reserveAction
  also returns its permit expectation; consumeReservationPermit behavior unchanged), guard.ts (exports bindingHolds),
  contracts.ts (S3-C constants/result types), audit allowlist (+attemptState, verificationOrdinal, targetKind, verificationResult).
- No migration: all 20 migrations and the lock unchanged. roles.sql grants INSERT on ActionVerification/ActionMockTicket and
  UPDATE of exactly the history triggers' mutable columns (request resultTicketId; attempt outcome/claim; verification
  state/completedAt/safeErrorCode); fence-role.ts ACTION_RUNTIME_PRIVILEGES is the same allowlist. No DELETE/TRUNCATE.
- Tests: tests/pg/action-{execute,verify,late,recovery,cli,upgrade-s3c,exec-nonsuper}.pg.test.ts, tests/action-cli.test.ts;
  support tests/support/action-exec.ts, action-network-trap.ts (TEST-ONLY preload), roles-s3b.sql (byte-exact accepted
  S3-B roles.sql). The exact-grant assertions of action-signers (A4) and action-reserve (A4/R2) now encode the S3-C surface.

Implementation choices inside the approved contracts (accepted in RC2): ActionPorts is a trusted in-process dependency — the CLI
always composes the built-in store and no setting selects a port; tests wrap it. Recovery also rechecks deployed versions and
the exact binding (drift refuses, outcome preserved). verify on DISPATCH_RESERVED, or with a candidate when the original is
known, returns ACTION_STATE_CONFLICT; on UNKNOWN without a candidate ACTION_OUTCOME_UNKNOWN; on NOT_DISPATCHED
ACTION_NOT_DISPATCHED. A missing ticket is a MISMATCH; a non-whitelisted/non-synthetic reply, exception or timeout is FAILED.
Abandon codes: ACTION_VERIFICATION_FAILED (recovery), ACTION_STATE_CONFLICT (superseded by the late original). A later
original that differs from a VERIFIED candidate is not attached (conflict audit only). STALE results and BUSY refusals are
audited; BUSY carries only the boolean recoveryRequired. action-execute/verify exit 0 only for VERIFIED (1 otherwise).

## S3-A integration delta (accepted in RC3)

- Schema: migrations 202610091000_stage3_action_fence (permission CHECK + four action permissions; ActionAuthorityFence,
  backfill before FORCE; SECURITY DEFINER trigger function; Actor/ClientMembership/ApiToken/Connection row fence and
  statement TRUNCATE triggers; Workspace init/delete/identity/TRUNCATE guards; fence self-guard) and
  202610091100_stage3_action_requests (ActionRequest/Approval/Attempt/Verification/MockTicket with scoped FKs, CHECKs,
  history/lifecycle triggers, ENABLE+FORCE RLS; ApiToken (workspace, actor, id) unique key for signed token FKs).
  prisma/actions.prisma plus back-relations on Workspace, ApiToken and Connection.
- Provisioning: prisma/roles.sql adds the NOLOGIN fence definer (fifth distinct role incl. owner), its exact column
  grants and role-specific policy, function ownership/ACL, and the owner/definer global completeness count; runtime gets
  SELECT on action tables, INSERT on ActionRequest only and UPDATE(workspaceId) on the fence.
- Readiness: packages/graph/fence-role.ts facts joined to the runtime self-check and re-run by every fenced admission;
  action tables join PROTECTED_TABLES.
- Adjacent paths: exact AT001 → ACTION_FENCE_NOT_READY mapping in bind, Stage 1 activation, M365 activation, m365-disable
  and the owner seed (packages/graph/fence-errors.ts); audit allowlist gains actionRequestId/actionType/requestState.
- Test helpers: four-role roles.sql renderer; byte-exact accepted Stage 2 roles.sql fixture for upgrade tests.
- Routing: packages/actions/AGENTS.md, docs/AI_CONTEXT_MAP.md, prisma/AGENTS.md, tests/pg/AGENTS.md; RUNBOOK §9.

RC2 repair (bounded F1–F4): the fence definer's routine privileges are exact (own trigger function plus an explicit list of
accepted Stage 1/2 invoker helpers through PUBLIC; any explicit grant, SECURITY DEFINER or unlisted routine fails readiness;
roles.sql removes grants it can revoke and otherwise refuses); the new history/lifecycle trigger functions hold no PUBLIC
EXECUTE; protected input opens non-blocking (a FIFO is refused at once); the ACTIVE-claim and approval-lifetime CHECKs require
every mandatory field non-null and never evaluate to SQL NULL; docs/ROADMAP.md restored byte-exact (Stage 2 normative file,
it carries no Stage 3 status — status lives here and in REVIEW_STATUS.md).

RC3 repair (F1-R1): every shared-helper allowance is the approved schema-qualified identity
`quote_ident(schema).quote_ident(name)(identity arguments)` — all 32 in `public` — in both the readiness check and roles.sql;
other application schemas are still scanned, so a routine with an allowed name/arguments in another schema is refused.

Implementation choices inside the approved contracts (accepted in RC2): ACTION_NOT_FOUND for an invisible/unknown request
ID; ACTION_STATE_CONFLICT for a derived-ID collision; validity hints CURRENT/NOT_PENDING/AUTHORITY_CHANGED/SIGNER_EXPIRED;
policy version atlas-action-policy/1 and port version atlas-synthetic-ticket-port/1; idempotency keys are lower-case UUIDs.

## S3-B integration delta (accepted in RC2)

- Code: packages/actions/guard.ts (lock order, DB clock after locks, shared stored signer/binding guard, committed terminal
  loss), approvals.ts (approve/reject/revoke/cancel), reservation.ts (atomic reservation, WeakMap single-use permit);
  contracts.ts gains the S3-B permission sets, TTL/start window and result types; authority.ts exports setLocal and
  requests.ts exports assertComposition (no behavior change). Audit allowlist gains actionApprovalId/actionAttemptId/approvalDecision.
- No migration: the installed S3-A schema (CHECKs, history/lifecycle triggers, scoped FKs) supports every S3-B write; all
  20 migrations and the lock are unchanged. Provisioning: roles.sql grants the runtime INSERT on ActionApproval/ActionAttempt
  and UPDATE of the request (state, safeErrorCode, updatedAt, terminalAt) and approval (decision, consumedAt, revokedAt,
  safeErrorCode) lifecycle columns only; readiness (fence-role.ts ACTION_RUNTIME_PRIVILEGES) is the same allowlist.
- Tests: action-approvals, action-guard, action-reserve, action-upgrade-s3b (support tests/support/action-approval.ts and
  the byte-exact accepted S3-A roles.sql fixture tests/support/roles-s3a.sql); the S3-A A4 test's final runtime-write loop
  now asserts the S3-B closed surface instead of "no write path".

Implementation choices inside the approved contracts (accepted in RC2): natural expiry stores and returns
APPROVAL_NOT_VALID; cancel by another actor and cancel of other terminal states return ACTION_STATE_CONFLICT; revoke by
another signer, reject of an APPROVED request and approve/reserve of a non-approvable state return APPROVAL_NOT_VALID;
the caller's own token expiring after admission is checked on the DB clock read after the command's LAST row lock,
before ANY outcome (stored terminal replay, approval replay, refusal audit, committed loss, decision or reservation), and
returns ACTION_AUTHENTICATION_FAILED with no mutation or audit (RC2 repair of RC1-F1); reject and revoke take the expected hash, cancel the request ID only; a repeated own cancel returns the stored
result like a repeated own revoke; reject/revoke/cancel also run the guard (a detected loss is committed instead).

RC2 repair (bounded RC1-F1/F2): F1 — every S3-B command takes all its row locks, then guard.ts lockedClock reads the DB clock
and refuses an expired caller before any outcome. F2 — authority.ts maps a deadlock/serialization abort of the client or
denial audit INSERT (40P01/40001, P2034) to ACTION_DB_CONFLICT instead of ACTION_AUDIT_FAILED; other audit failures keep
ACTION_AUDIT_FAILED. Both fixed codes only, no retry. Real PostgreSQL lock-wait and deadlock-at-audit regressions added.

## Accepted S3-A artifact

S3A-rc3: package `754eee15cf8e89cd7f61d8914f4796d3a5314f44e41169fac33145495134a51c`, 586 reviewed files;
manifest `verification/stage3/S3A_RC3_MANIFEST.json`, source ZIP `verification/stage3/S3A_RC3_PACKAGE.zip`
SHA-256 `9f54ac0667d2658e4bb8404009aab2e6b90617d0b9c7103d9de205aa4f56bcee`. Acceptance: [Astra RC3](reviews/ASTRA_S3A_RC3.md), fresh explicit gpt-6-astra/xhigh.

All ten checkpoint checks passed: **177/177 unit/PGlite and 341/341 PostgreSQL**, schema validation, generation, typecheck,
build, smoke, PostgreSQL17/schema drift and whitespace. Independent review: 12/12 unit, 24/24 action PostgreSQL, two schema/signature probes.
Native Opus5.5/high used one cohesive session with two bounded repair turns; original RC1/RC2 reports/evidence remain historical.
Strict routine identity includes schema/signature; future callable-routine changes require deliberate review. No approval/reservation
or execution service is accepted yet. S2-LIVE and real vendor writes remain deferred; pilot DB/configuration was untouched.

After acceptance only administrative status/record updates are allowed by this handoff; their exact hashes are in
`verification/stage3/S3A_APPROVED.json`. All reviewed source/tests/migrations retain accepted RC3 hashes.

## Accepted S3-B artifact

S3B-rc2 package `fd70db2d87c512a5d9c878d61cf77a71b3456d1000b06ced5a4ea2d4cf1c01ec`; [Astra acceptance](reviews/ASTRA_S3B_RC2.md), seal `verification/stage3/S3B_APPROVED.json`. Fresh explicit gpt-6-astra/xhigh reviewed RC1; its bounded RC2 re-review retained effective xhigh. RC1-F1/F2 are closed; no required findings remain.

All ten checkpoint checks passed: 177 unit/PGlite and 370 PostgreSQL; independent 56 PostgreSQL checks plus the original terminal-replay and audit-deadlock probes passed. RC1 and RC2 snapshots, failures, fixes and check logs are preserved. After acceptance only the administrative status deltas recorded in the seal changed; source/tests/migrations still match RC2. At that S3-B acceptance, S3-C was the next unstarted checkpoint; S3-C is now accepted above. LIVE remains DEFERRED_BY_OWNER; no pilot operation or vendor call.
