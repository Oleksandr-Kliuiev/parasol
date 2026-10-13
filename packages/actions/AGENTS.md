# Stage 3 governed actions — context routing

Design: docs/stage3/AGENTS.md, 01_SPEC.md, then only the relevant 02–06 section. Current checkpoint state:
docs/stage3/IMPLEMENTATION_STATUS.md. MOCK only; no vendor adapter, network transport or live write exists or may be added here.

S3-A (accepted in S3A-rc3) — entry files by concern:
- contracts.ts: versions, permissions, fixed error codes, preview whitelist, safe summary types.
- canonical.ts: raw-scalar Unicode validation → NFC/trim → limits; UUIDv8 request ID; marker; intent/canonical hashes.
- private-file.ts: protected 0600 preview output (outside any Git checkout) and protected JSON input reader.
- policy.ts: DISABLED-by-default composition (only exact MOCK); FIXTURE atera connection policy.
- authority.ts (current-token lookup and setLocal shared verbatim from ../auth/transaction-token.ts since S4-A): opaque bearer credential; fenced admission (auth → fence FOR UPDATE → readiness → re-auth after the lock →
  ACTIVE actor/membership → one workspace denial audit); validity hints; fixed failure mapping.
- requests.ts: preview, request (store or idempotent retrieval), get, stored-preview export, keyset list.
S3-B (accepted in S3B-rc2 by independent GPT-6 Astra/xhigh):
- guard.ts: lock order request → approval after the fence; lockedClock (DB clock after the LAST lock, caller's own token
  re-checked before any outcome); the shared stored guard (deployed
  versions, exact epoch, stored signers ACTIVE + rights via the confined actor context, exact binding, both expiry snapshots,
  approval expiry); a loss is committed (INVALIDATED/EXPIRED, approval REVOKED, audit) and refused after the commit.
- approvals.ts: approve (exact STORED preview file + hash, never self, same-signer replay without renewal; TTL 15 min capped
  by both snapshots), reject, revoke (original signer; repeat returns stored), cancel (original requester).
- reservation.ts: one transaction consumes the approval + unique attempt + DISPATCH_RESERVED + audit; only a committed
  reservation mints the WeakMap-bound single-use permit (start deadline min(5 s, approval expiry), monotonic, never renewed).
Database: prisma/actions.prisma, migrations 202610091000 (fence) and 202610091100 (action tables); prisma/roles.sql §4b;
readiness facts packages/graph/fence-role.ts; fence error mapping packages/graph/fence-errors.ts.
Tests: tests/action-canonical.test.ts and tests/pg/action-*.pg.test.ts (support: tests/support/action-fixtures.ts).

Tests: tests/pg/action-{approvals,guard,reserve,upgrade-s3b}.pg.test.ts (support: tests/support/action-approval.ts).

S3-C (accepted in S3C-rc2 by independent GPT-6 Astra/effective xhigh; RC1 R1–R3 closed) — MOCK execution, verification, recovery:
- mock-port.ts: the internal TicketPort and its only implementation, the built-in scoped ActionMockTicket store (independent
  commits, no deduplication, whitelisted read). No transport, URL, credential or callback; tests wrap it to inject faults.
- attempts.ts: shared request → attempt → ordinal locks, DB clock, recovery-due rules, safe execution summary.
- publication.ts: every post-dispatch fact (NOT_DISPATCHED/UNKNOWN/CREATED, late original vs candidate, read results)
  in one transaction per fact, never the fence/approval/auth/Connection; exact private capability; ≤3 same-fact runs on
  40P01/40001; identical facts are no-ops; stale claims change nothing.
- execution.ts: action-execute = accepted reservation → permit consumed once → one createOne (15 s AbortSignal) → publication
  → separately authorized initial read (ordinal 1); late results only through the owned continuation.
- verification.ts: fenced claim of the next ordinal (fresh execute authority, versions, exact binding), protected
  reconciliation file, bounded read, exact-match classification. recovery.ts: explicit action-recover after 35 s.
- ../ops/actions.ts: the action-* CLI commands (opaque bearer credential; routed by scripts/ops.ts before Stage 1/2).
RC1 CHANGES_REQUIRED (docs/stage3/reviews/ASTRA_S3C_RC1.md); RC2 repair: mock-port.ts binds DB work to the call's original
deadline (PortCall), publication.ts gives every fact audit a keyed deterministic ID (identical conflict/stale facts no-op).
Tests: tests/pg/action-{execute,verify,late,recovery,cli,upgrade-s3c,exec-nonsuper,port-cancel,replay}.pg.test.ts, tests/action-cli.test.ts
(support: tests/support/action-exec.ts, action-network-trap.ts, roles-s3b.sql = byte-exact accepted S3-B roles.sql).
Runtime grants stay exactly as prisma/roles.sql lists them; a new write path is a reviewed roles.sql + readiness change.
Never print or audit titles, descriptions, customer keys, token IDs/digests, secret references or preview file paths.
