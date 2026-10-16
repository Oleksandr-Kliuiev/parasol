# Atomic ledger evidence and fence-first closure

## Snapshot is a complete accounting observation

A metadata read performs no reservation, settlement, pause, activation or source read. Use a single bounded
READ ONLY REPEATABLE READ transaction, real DB clock, explicit
allowlisted projections, and fixed parameterized SQL through the registered evidence definer. No financial
FOR UPDATE locks and no fence lock are needed for a read. Policy, fence, counters and attempts must all come
from that SAME snapshot. The caller must establish this isolation/read-only mode BEFORE the first query;
the routine verifies it and rejects READ COMMITTED. A VOLATILE definer under READ COMMITTED is insufficient.
Independent queries in separate transactions are not one reconciled observation.

The routine exports ALL retained attempts of the registered project, not only the requested correlation,
plus every original DAY/MONTH counter referenced by those attempts and the current DAY/MONTH. It verifies
counter = SUM(accountedMicroUsd) for each period and the immutable project/admission binding. A missing
current-period row means zero only when the same snapshot proves no period attempt; it is never inserted
by the reader. Missing counter for an existing attempt is an integrity failure, not zero.

Maximum 1000 attempts and 2000 period rows per snapshot, total encoded frame <=256 KiB, wall-clock/DB phase
<=2s. The first exceeded bound governs; row maxima are ceilings, not a promise all maxima fit the byte cap.
Include the whole transport envelope in that byte cap. Return `CENSUS_LIMIT_EXCEEDED` or `CENSUS_UNAVAILABLE`, not a truncated success, sample,
partial page or empty result. No archive/deletion may run during evaluation. A larger project needs a
separately reviewed bounded export, not silently reduced coverage.

Exact SNAPSHOT payload:
```
{snapshotId,dbObservedAt,admissionId,policyVersion,fenceEpoch,policyState,
 reserveMicroUsd,dayCapMicroUsd,monthCapMicroUsd,expiresAt,
 currentDay,currentMonth,fixtureGeneration,fixtureId,
 projectAttemptCount,foreignScopeAttemptCount,periods,attempts,consistent}
```
UUID/time/decimal/scalar bounds are in 01. `policyState` is INACTIVE|ACTIVE|PAUSED|REVOKED|TOMBSTONE;
`consistent` is boolean. A non-ACTIVE snapshot may be exported for closure/accounting, never used to GO.
An inconsistent snapshot contains no spend headroom usable by the instrument and stops the run.
`foreignScopeAttemptCount` covers project attempts outside the registered client/designated actor. Their
content/IDs are not exposed. Any nonzero count blocks evaluation and requires owner investigation.
The projectAttemptCount includes them; the response may not claim complete per-attempt attribution.

`periods[]` exact `{kind:'DAY'|'MONTH',periodStart,chargedMicroUsd,attemptCount}` in MONTH then DAY/date order.
`attempts[]` for the registered client/actor, ordered createdAt then attemptId, exact:
```
{attemptId,correlationId,admissionId,policyVersion,createdAt,dayStart,monthStart,
 reservedMicroUsd,accountedMicroUsd,state,outcome,settledAt}
```
State is EGRESS_COMMITTED|SETTLED|UNKNOWN. Outcome is null|USAGE_VERIFIED|NO_DISPATCH|DELIVERY_UNKNOWN|
USAGE_INVALID|MODEL_MISMATCH|UPSTREAM_REJECTED, with the accepted SQL state/amount/time relationships.
The fixed profile/price identity must match the registration's approved policy; a mismatch is failure, not
an arbitrary string in output. No requestId, question/hash/length, raw answer, observed intent, provider ID,
request body, token/key, source fact or provider error appears in these exports.

SnapshotId is random, not a content hash. The authenticated outer frame and live challenge establish its
transport provenance; a saved ID/JSON object alone cannot prove freshness. Save only this closed metadata
projection, its registered source/process binding and numeric comparison results under the receipt allowlist.

## Correlation, census and zero attempts

The API creates correlation IDs; it never accepts one as caller authority. The DB unique constraint binds
at most one attempt to `(workspaceId,correlationId)`. Public response correlation is independently checked
against the transient server slot in 04. Reusing a correlation/request/handoff nonce never grants dispatch.

For every case, compare a fresh PRE snapshot and a POST snapshot from the same measured server/registration,
with the same immutable project and current admission. Capture original period keys at reservation, never
infer them from the response's date. Show the whole census delta and count changes, not only net money.

- Expected one admitted attempt: exactly one new attempt, at the authenticated reply correlation, same
  actor/client/admission/policy generation, reserve300000, correct original day/month. Every unrelated row
  and period must be unchanged. PRE charged + this final accounted amount = POST charged in BOTH original
  buckets. A reserve and refund can net to zero; row/count census still detects it.
- Expected no admitted attempt: PRE/POST complete censuses unchanged AND the same uninterrupted measured
  server task attests a confirmed pre-reservation failure/rollback with no commit uncertainty or dispatch.
  The transient guard must be settled before POST. Absence of a row alone never proves rollback/no dispatch.
- Any additional/foreign/hidden attempt, unexplained settlement, census gap or unrelated counter movement
  is `CENSUS_CHANGED_UNEXPECTEDLY`; stop. Report actual liability/counts, do not subtract the other activity
  to make a case look reconciled. A concurrent intrusion is not attributed to this case without proof.
- A pre-parser/auth/pool failure may have no scoped attempt and no admissible task correlation. Record
  `UNATTRIBUTED_PRE_RESERVE_FAILURE`; keep the case consumed when a submission occurred. Do not invent a
  per-correlation ledger row, claim a refund, or count an unobserved category as verified zero.

Use the process/platform census in 05 as well as the DB census. The database does not record every ingress,
rejected request, pending commit or physical dispatch. A paused-but-still-running transaction can commit
later; a lone immediate zero-row read does not close that uncertainty. Zero requires both settled task
ownership and the bounded complete DB observation, or remains UNKNOWN.

A success/ASK_REMOTE_INVALID/ASK_REMOTE_MODEL_MISMATCH/ASK_REMOTE_USAGE_INVALID proves the upstream path
was involved only when it is the authenticated server publication. It requires exactly one admitted
attempt and compatible dispatch/settlement evidence. Answer + zero attempts or NO_DISPATCH is a
contradiction, even if the displayed facts are valid. Model/usage mismatch retains full300000. Independently authenticated detected faults in06 remain
TERMINAL_FAILED even if settlement never records an outcome or the public response/handoff fails; the
financial observation may still be UNKNOWN. A ledger outcome alone is not the fault-observation channel.

## Private dispatch proof and financial semantics

Database EGRESS_COMMITTED means committed reservation, not observed wire transmission. The existing
private non-reconstructible in-process capability remains the ONLY permission to dispatch and the ONLY
source of a no-dispatch settlement proof. Neither export reader, server handoff, operator, DB outcome,
correlation, signature nor a restarted process can mint/reconstruct it or call settle0.

A separate memory-only guard census records monotonic numeric counters at ingress/task creation,
reservation confirmation/uncertainty, capability consumption, transport entry and physical owner release.
Metadata capture observes existing operations; it is not an execution queue or new dispatch capability.
"Transport entered" does not prove the provider received/billed it. Unknown outcomes retain full reserve.
A DB NO_DISPATCH record can be reported as a stored accounting fact, but current no-dispatch proof requires
the same original task/boot's private proof observation; absent continuity cannot establish it retrospectively.

Settlement stays exactly as accepted: immutable original MONTH -> original DAY -> attempt FOR UPDATE;
never acquire the authority fence while holding those locks. Verified usage updates both original counters
and attempt atomically once. Late settlement never moves spend into today's/month's bucket. Unknown egress
or settlement commit is never retried, assumed refunded, reconstructed after restart, or healed into a case
pass by a later read. Already captured valid usage may financially drain under the accepted bounded rule.
No new finance reconciliation worker or retry is introduced.

The instrument retains its conservative local liability floors: MONTH cannot decrease in the admitted month;
DAY resets only when the actual UTC day advances; old bucket liability remains reported. A DB snapshot that
is lower than a retained floor does not automatically release that floor. An unexpected late settlement or
other change ends the run for explicit reconciliation outside this amendment; the DB's factual amount and
local conservative reserve are shown distinctly rather than overwritten.

Unknown-liability answers receive no case-pass or validated-provider credit. Safe original-task terminal
observations in06 distinguish a detected fixed safety/configuration fault from actual HTTP completion and
survive raw-slot revocation; missing/lost settlement cannot suppress such a known fault. Truth/safety failure remains
TERMINAL_FAILED even under unknown liability; a semantic failure that makes a threshold unreachable also
remains TERMINAL_FAILED. Otherwise an unestablished liability ends TERMINAL_INCOMPLETE. The unknown state
cannot hide a stronger failure, and a later metadata export cannot revive that run. Paid/unknown/timeout
cases remain consumed and in the denominator.

## Owner fence-first pause and exact closure

`pause-export` requires explicit owner command authentication; the instrument can request that the owner
close but cannot perform owner activation/revision itself. The short-lived owner executor in01, never the
resident controller DB connection, runs the command in a fresh bounded transaction
holding no prior financial lock/shared fence: fence FOR UPDATE first -> policy FOR UPDATE. It checks exact
registration/admission and expected current version, then calls the accepted owner-only
`atlas_ask_remote_policy_revise(...,'PAUSED',...)` with every other field read from the locked row unchanged.
The trusted command never accepts secret, cap, expiry, price, project, approval or profile edits as arguments.
It does not misuse the runtime configuration-fault pause reason for an owner operation.

After confirmed commit only, export an atomic reread of the same admission's PAUSED policy and shared fence.
If it changed or became active before reread, refuse. The local connection/challenge binds the export to
this invocation; retain that provenance separately from the payload. A lost/unknown commit acknowledgement
exports no confirmed closure. The owner may subsequently read factual policy state, but cannot label the
failed invocation a confirmed fresh closure or retry it automatically.

The closure payload has EXACTLY four keys:
```
{admissionId:<UUID>,paused:true,policyVersion:<positive Dec64>,fenceEpoch:<positive Dec64>}
```
`paused` is a JSON boolean, never a string, truthy value or inferred default. The current local instrument's
TTY adapter accepts the exact text `true`; a future reviewed bridge may convert the validated JSON boolean
to that adapter representation, never loosen the four-key check or mutate the current accepted artifact.
No timestamp, signature, note, drain field, extra key or raw policy row goes inside this closure object.

One run-wide floor covers voluntary, DAY and terminal closures. On accepting closure, policyVersion must be
strictly greater than EVERY previously observed policyVersion, and fenceEpoch strictly greater than EVERY
previously confirmed fence (including opening). Parse canonical signed-64 decimals with BigInt. Floors never
reset on interval/fixture/day changes. A late/stale/foreign/equal/overflow/replayed receipt yields absorbing
CONTAINMENT_UNCONFIRMED; no resume or acceptance. The existing SQL fence uses a narrower integer range;
overflow or version exhaustion must roll back/fail closed, never wrap or imply a successful pause.

Already-PAUSED owner revision is a no-op. Its tuple may be exported only if it independently exceeds both
floors (e.g. an unobserved genuine circuit pause); otherwise the strict closure cannot be satisfied. Do not
activate/revoke/recreate or edit an unrelated field merely to manufacture a newer receipt. TOMBSTONE or
REVOKED can prove non-active state in metadata but does not fabricate this PAUSED receipt. A required
closure that cannot be confirmed remains CONTAINMENT_UNCONFIRMED and needs explicit external containment.

## Pause is not drain

Pause commit prevents subsequent egress admissions and invalidates later current-authority publication.
It cannot retract already committed dispatch capability, bytes, charges or a task whose cleanup is pending.
The closure receipt certifies this policy/fence fact only; it never erases ledger history/liability.

Separate DRAIN payload exact:
`{snapshotId,policyVersion,fenceEpoch,registeredProcessCount,reachableProcessCount,pendingTaskCount,
pendingCommitCount,physicalOwnerCount,unmappedAttemptCount,continuity:'INTACT'|'LOST',
state:'QUIESCENT'|'PENDING'|'UNKNOWN'}`.
Counts are checked Dec64. C composes this evidence, never asks S to self-certify independent DB/platform
coverage. Within the same2s bound, obtain authenticated PROCESS_CENSUS, the atomic DB snapshot and a second
PROCESS_CENSUS; require identical epoch/event counters, complete interval coverage and zero current task/
pending-commit gauges for QUIESCENT. pendingTaskCount/physicalOwnerCount come from activeTaskCount;
pendingCommitCount comes from its namesake server gauge. Any concurrent change yields PENDING/UNKNOWN,
not a claim that unrelated instants were one observation. QUIESCENT requires all registered process incarnations reachable, no outstanding
capabilities/DB commits/physical owners, all committed attempts in the census, no unexplained census delta
and intact launch continuity. It does not require all reserves refunded or UNKNOWN liabilities settled.
A dead/unreachable process, unacknowledged commit or incomplete process inventory is UNKNOWN, never zero.

Read drain on explicit operator request; no infinite poll/background worker. No lock crosses the transport.
If drain remains pending/unknown, fixture replacement and next interval stay blocked. External network/process
containment can stop future bytes but does not erase possible cost or fabricate per-attempt proof. A later
owner recovery needs separate evidence/review; this protocol does not resume an interrupted/unknown run.
