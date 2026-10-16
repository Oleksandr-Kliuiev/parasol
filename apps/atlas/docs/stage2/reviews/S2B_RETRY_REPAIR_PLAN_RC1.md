# S2-B corrective policy RC1 — review artifact

2026-10-08. Proposed implementation detail of approved Stage 2 §6, not a change to the normative RC5 files.
Scope: directory admission/backoff/budget/reset, sign-in result preservation and sync denial audit. S2-C/LIVE excluded.
Baseline S2-B-rc2: a16bbcc1668a3bbb0603f44e705c46ad7c99f94b8d51bbfa708284df08a33144.
Codex retains write ownership while this plan is independently reviewed. No implementation of this policy yet.

## Directory retry chain

Persist a per-connection/resource retry-attempt budget in M365ResourceState through an additive migration, Prisma field,
runtime-only column grant and fail-closed grant self-check. Accepted migrations and cleanup privileges stay frozen.
Directory resources only; sign-in capability rows must carry zero directory attempts.

One claim consumes one attempt before secrets/network, including an interrupted/crashed or superseded claim. Hard bound:
eight attempts since the latest successful publication or explicit permitted reset. Eight permits the existing 30-second
exponential base to reach its 15-minute cap; it does not change the separate five-attempt sign-in policy.
Budget survives process/client/cache restart. Publication by the latest valid claim atomically resets the directory budget
and clears retryAt. Failed/stale/expired claims cannot reset it or change the newest throttle/publication.

For the newest unexpired failed claim, persist retryAt for every TRANSIENT error: existing retryDelayMs with charged count
for 5xx/network/timeout, capped at 15 minutes; 429 uses exact bounded Retry-After or 60s plus bounded jitter. Persist the
delay even on the final attempt; exhaustion stops further claims independently of the last failure code. Preserve that
code in state/generation. A future retry time cannot be bypassed by resetting the budget.
Permanent failure remains visibly failed; a later intentional operator call may start another charged attempt, subject to
the same finite budget, until exhausted. No automatic worker/HTTP retry, sleep or scheduler is introduced.

## Atomic admission and explicit reset

Lock Connection first/current authority. INSERT initial state (sequence zero, PENDING, zero budget) ON CONFLICT DO NOTHING,
then SELECT state FOR UPDATE, read decision clock and check persisted retryAt/exhaustion. Only then increment sequence
and budget and create the generation in a separate visible statement. This closes missing-row admission races.

Provide a focused operator service for explicit directory retry reset, requiring ACTIVE pinned Connection and current
events:ingest + connections:manage. No CLI/API in S2-B. Under Connection → state lock: refuse if retryAt is future or the
latest generation has an unexpired STAGING claim; allow an exhausted/failed/expired chain only. Increment started sequence
and recorded sequence to a common new fence, set budget to zero, clear elapsed retryAt, retain last-good pointer/counts/
lastSuccess and last failure code/status, and append a safe client audit in the same transaction. Sequence invalidation
prevents a delayed old generation from becoming current after reset. Failed/noncurrent generation history stays intact.
SQL guards must constrain directory budget domain/transitions and retryAt reset without weakening existing publication,
ordering, retention, RLS, atomicity or accepted migration guards. No capability widening for cleanup/definer.

## Sign-in repeat outcomes

Locked root projection includes stored safeErrorCode. COMPLETE returns DONE/null; FAILED returns FAILED/stored code.
Exhaustion and permanent codes remain distinguishable; HELD and NOT_DUE retain existing distinct outcomes. Repeat passes
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
retention, runtime role upgrade/reprovision, controlled concurrent first-state ordering, all repeat sign-in outcomes and
pre-I/O/mid-stream/pre-publication denials with no client-audit leakage. Keep tests/modules cohesive below file ceiling.
Run affected tests then the ten required checkpoint commands. Freeze RC3 manifest/ZIP, record delta/model/effort/checks.
Fresh Astra xhigh reviews actual RC3 and evidence before any dependent checkpoint. No commit, deployment or live calls.
