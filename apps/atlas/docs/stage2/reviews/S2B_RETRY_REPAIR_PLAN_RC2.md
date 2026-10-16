# S2-B corrective policy RC2 — review artifact

2026-10-08. Proposed implementation detail of approved Stage 2 §6, not a change to the normative RC5 files.
Scope: directory admission/backoff/budget/reset, sign-in result preservation and sync denial audit. S2-C/LIVE excluded.
Baseline S2-B-rc2: a16bbcc1668a3bbb0603f44e705c46ad7c99f94b8d51bbfa708284df08a33144.
Codex retains write ownership while this plan is independently reviewed. No implementation of this policy yet.

## Directory retry chain

Persist a per-connection/resource retry-attempt budget in M365ResourceState through an additive migration, Prisma field,
runtime-only column grant and fail-closed grant self-check. Accepted migrations and cleanup privileges stay frozen.
Directory resources only; sign-in capability rows must carry zero directory attempts.
Migration backfills existing directory counters as min(8, latestStartedSeq - latestPublishedSeq), preserving current
retryAt, sequences, status/code and publication. This preserves charged failed/crashed claims even after history cleanup.
Add a populated upgrade test with remaining/exhausted chains and future Retry-After; no automatic fresh eight attempts.

One claim consumes one attempt before secrets/network, including an interrupted/crashed or superseded claim. Hard bound:
eight attempts since the latest successful publication or explicit permitted reset. Eight permits the existing 30-second
exponential base to reach its 15-minute cap; it does not change the separate five-attempt sign-in policy.
Budget survives process/client/cache restart. Publication by the latest valid claim atomically resets the directory budget
and clears retryAt. Failed/stale/expired claims cannot reset it or change the newest throttle/publication.

For the newest unexpired failed claim, persist retryAt for every TRANSIENT error: existing retryDelayMs with charged count
for 5xx/network/timeout, capped at 15 minutes; 429 uses exact bounded Retry-After or 60s plus bounded jitter. Persist the
delay even on the final attempt; exhaustion stops further claims independently of the last failure code. Preserve that
code in state/generation. Exhaustion is checked first at admission: M365_ATTEMPTS_EXHAUSTED/PERMANENT, details contain
attemptsUsed/maxAttempts and any retryAt; no write, sequence, generation, secret or I/O. Otherwise a future retryAt returns
M365_RETRY_NOT_DUE/TRANSIENT without writes. Directory result exposes charged attemptsUsed/maxAttempts; pure stored-state
status projection exposes exhaustion plus those counters (no S2-C query/API). A future retry time cannot be bypassed by reset.
Permanent failure remains visibly failed; a later intentional operator call may start another charged attempt, subject to
the same finite budget, until exhausted. No automatic worker/HTTP retry, sleep or scheduler is introduced.

## Atomic admission and explicit reset

Lock Connection first/current authority. INSERT initial state (sequence zero, PENDING, zero budget) ON CONFLICT DO NOTHING,
then SELECT state FOR UPDATE, read decision clock and check persisted retryAt/exhaustion. Only then increment sequence
and budget and create the generation in a separate visible statement. This closes missing-row admission races.

Provide a focused operator service for explicit directory retry reset, requiring ACTIVE pinned Connection and current
events:ingest + connections:manage. No CLI/API in S2-B. Under Connection → state lock: refuse if retryAt is future or the
latest generation has an unexpired STAGING claim; allow an exhausted/failed/expired chain only, with positive budget.
A missing latest generation with outstanding recorded-vs-started sequence is eligible only as cleanup-expired history;
cleanup deletes that history only after expiry. An initial zero-claim state and already-reset zero budget are ineligible.
Increment started sequence
and recorded sequence to a common new fence, set budget to zero, clear elapsed retryAt, retain last-good pointer/counts/
lastSuccess and any actual prior failure code/status, and append a safe client audit in the same transaction. If the
expired/crashed chain has no recorded failure (PENDING or OK), set ERROR/M365_CLAIM_EXPIRED while advancing recorded sequence;
this obeys the frozen pending/code checks and applies also after cleanup of a first-ever claim. Sequence invalidation
prevents a delayed old generation from becoming current after reset. Failed/noncurrent generation history stays intact.
SQL guards must constrain directory budget domain/transitions and retryAt reset without weakening existing publication,
ordering, retention, RLS, atomicity or accepted migration guards. Exact new budget guard transition classes:
- INSERT: zero directory budget; sign-in budget always zero.
- claim: started advances exactly one, budget advances exactly one from below eight; recorded/published sequences unchanged.
- successful publication: budget zero with pointer change and higher published sequence, newest recorded outcome.
- reset: positive old budget, started advances exactly one, recorded becomes started, budget zero and retryAt NULL;
  old budget exhausted, prior ERROR/MISSING, or outstanding unrecorded claim permits this transition. New status/code obey
  normalization above. A positive outstanding claim may be reset only after lease expiry, checked by service under locks.
- otherwise neither started nor budget changes; existing guards still enforce outcome/ordering/publication/cleanup.
Any other budget/started change is refused. CHECK 0..8, zero on sign-ins. RetryAt clearing on reset uses the already accepted
newest-recorded-sequence rule; do not weaken that guard. Do not put new now()-dependent throttle/lease comparisons in SQL:
service uses injected clock under locks. SQL cannot distinguish a mischarging claim from an eligible reset in all ERROR/
unrecorded cases; every claim charges and every reset is explicitly authorized/audited are service-plus-test invariants.
No capability widening for cleanup/definer.

## Sign-in repeat outcomes

Locked root projection includes stored safeErrorCode. COMPLETE returns DONE/null; FAILED returns FAILED/stored code.
Expose attemptsUsed/maxAttempts in the root result alongside the preserved safe code: FAILED with used == max identifies
an exhausted chain, distinct from a permanent failure below the bound. Preserve original vendor-safe failure code rather
than overwriting it. Terminal result check occurs before expired-attempt maintenance, so it alters no evidence/history.
HELD and NOT_DUE retain existing distinct outcomes. Repeat passes
do not allocate claims, use secrets/I/O, alter evidence or charge budgets.

## Workspace security denial

Use a focused common helper at public directory/sign-in sync boundaries, including pre-claim refusals and authority
withdrawal during I/O/publication/failure recording. SCOPE_DENIED/PERMISSION_DENIED append workspace SecurityAuditEvent
through the existing actor-bound PrismaSecurityAudit independently of any rejected client transaction. Audit uses actor's
workspace, requested client identifier, safe reason/event/correlation only; empty metadata, no vendor/connection IDs,
credentials, DTOs or upstream text. Do not swallow audit write failure or falsely claim it was recorded. Avoid duplicate
denials per boundary invocation. Never attempt inaccessible-client audit after authority withdrawal.

## Verification and stopping point

Synthetic PostgreSQL regressions: repeated 503/network/timeout increasing delay/cap, exact 429/fallback, fresh-context
no-early-I/O, finite exhaustion, crash/supersession accounting, reset throttle/held refusal and old-claim fencing, last-good
retention, runtime role populated upgrade/reprovision, first-ever crash reset before any publication and after cleanup with old-claim
fencing, controlled concurrent first-state ordering, all repeat sign-in outcomes and
pre-I/O/mid-stream/pre-publication denials with no client-audit leakage. Keep tests/modules cohesive below file ceiling.
Run affected tests then the ten required checkpoint commands. Freeze RC3 manifest/ZIP, record delta/model/effort/checks.
Fresh Astra xhigh reviews actual RC3 and evidence before any dependent checkpoint. No commit, deployment or live calls.
