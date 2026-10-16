# Authority, durable spend and crash semantics

## Policy and permission

Retain accepted private ingress/authentication, scope fencing, source validation and final publication. Remote uses
same-membership all-of context:read+ask:remote in phase1, egress admission and phase2; no auto-grant. Add new migration
extending the latest ClientMembership permission CHECK, preserving all existing vocabulary and accepted triggers.
Add focused prisma remote schema, new migration(s), scoped readiness checks and role grants; never edit old migrations.

New RemoteAskPolicy is exactly ONE persistent row per workspace and dedicated project, defaults inactive. Its
workspaceId, projectIdentity and admissionId are immutable; admissionId is assigned once at creation. Revisions update
that row in place, never create a second policy row. DELETE/recreate and project reassignment are forbidden. It binds an exact positive bigint
policyVersion, exact profile/prompt/schema/package identities, endpoint EU, dataClass SYNTHETIC, owner approval evidence
reference, verified dedicated-project and secret references (not the key), retention-control attestation, price revision,
approved UTC expiry (≤7 days), reserve/day/month limits and active/paused state. RemoteAskClientAdmission binds exact
(workspaceId,clientId,admissionId) with composite same-workspace FK to Client and policy. No wildcard allowlist.
ProjectIdentity is UNIQUE across workspace policy rows, not across historical captured attempt metadata. Attempts have
a same-workspace/admissionId FK to this stable row; captured policyVersion is immutable metadata, not an FK to a row
which gets replaced. Historical attempts keep their captured price/profile/periods; revisions cannot rewrite them.
No runtime self-provisioning or automatic permission change.
Trusted owner provisioning activates only after R-A/B/C acceptance and explicit paid/data admission. Policy update,
client allowlist change, pause and revoke take the existing workspace authority fence FIRST FOR UPDATE. They advance
BOTH separate versions transactionally: fence.version by existing +1 semantics and policy.policyVersion by exactly+1
per material mutation (multiple row mutations may advance it more than once in a transaction). Never reset/decrement/
reuse policyVersion, including revoke/reactivate, client allowlist edits and changes of provider/profile/prompt/schema,
secret binding, account retention/data/region, owner approval, price/caps/expiry or active/paused state. AdmissionId never
changes. No-op mutations may leave versions unchanged but must not change any material field. At max bigint the policy
is a terminal inactive tombstone: reaching max must deactivate atomically, egress refuses max, reactivation/overflow/
further material mutation rejects. Delete/recreate cannot restore an old tuple or reset the counter.
Runtime may pause via a narrow routine; never activate.
A workspace delete must not cascade away financial history/counters; restrict until separately governed archive.

Policy/ledger tables use workspace RLS FORCE ROW LEVEL SECURITY and composite scoped keys/FKs. Runtime cannot
INSERT/UPDATE policy, client admissions, counters or attempts directly. New dedicated NOLOGIN NOBYPASSRLS function
owner receives only required table privileges; narrow SECURITY DEFINER reserve/settle/pause routines use fixed qualified
objects/search_path, current scoped settings, validated args and no dynamic SQL. EVERY new routine, including invoker
guards and trigger functions, revokes PUBLIC EXECUTE in its migration. Only reserve/settle/pause are executable by
runtime; trusted policy/allowlist revision routines are executable only by the provisioning owner, never runtime.
Existing cleanup/Stage3 definer roles gain no new privilege. R-A must test role membership,
direct-DML denial, function ACLs, foreign scope/attempt and populated upgrade under actual nonsuperuser PG.

Concrete fence mechanism: the NEW remote definer gets only SELECT(workspaceId,version), UPDATE(version) on
ActionAuthorityFence in addition to its exact remote-table column allowlist. It obeys the existing public workspace
scope policy with captured app.workspace_id set; no new fence policy, ownership, INSERT/DELETE, bypass role or grant to
runtime. Its revision/pause routines lock the fence FIRST, then mutate policy/client rows. Focused definer-owned guards
validate immutable identities and +1 policy transitions; client-admission changes bump policyVersion and fence in the
same transaction. No direct owner DML is part of provisioning: owner calls the fence-first revision routines. Do not
modify the hard-coded Stage3 trigger function or give the existing fence definer another routine/table privilege.
The two existing fence policies, existing fence-definer routine ownership and its complete confinement stay unchanged.

prisma/roles.sql must explicitly REVOKE INSERT,UPDATE,DELETE on ALL four remote tables from runtime AFTER its generic
table/default grants, revoke forbidden column grants too, and add the eighth remote role to the distinct-role setup/
validation loops. Section5 validates its complete effective table/column/routine/schema/membership capability surface,
including these exact fence-column grants; no inherited role, PUBLIC routine escape, relation/schema/type ownership,
CREATE/GRANT option, login or bypass. New role owns only the named remote routines/guards. Add the four remote tables
to PROTECTED_TABLES and a focused remote privilege/readiness query for exact RLS/FKs/routine ACLs/owner grants/runtime
DML denial. Run shared fence/runtime readiness in OFF/MOCK after provisioning: a stray new PUBLIC function must fail
the negative check, not silently break the whole accepted Ask surface. New migrations never replace existing-owned
fence functions. Explicitly verify default-privilege regrant/reprovisioning does not reopen remote DML.

## Egress is a separate current authority boundary

After phase1/source read and bounded upstream payload preparation, before any network work, execute a short egress
transaction: clear local settings → captured workspace hint → fence FIRST FOR SHARE → current private bearer/ACTIVE
actor/same client all-of permissions → captured workspace/actor/epoch equality → active unexpired policy/client admission
and exact acknowledgement/profile/price revision → month counter lock → day counter lock → insert one attempt and
reserve both limits. Recheck credential expiry/policy expiry and original deadline after INSERT, immediately before
return. Enforce the same≤2s phase/pool/statement bounds and cleanup behavior as accepted Ask.

Minimum remaining ORIGINAL budget is4500ms: full2000ms provider +full2000ms settlement +500ms publication floor.
Check it before the egress attempt INSERT and again immediately before transaction return; below it throw504 and
roll back the entire transaction, with NO attempt/reservation/network. Final commit latency can reduce remaining time;
check4500ms again before capability consumption/dispatch. If below, no provider call and proven no-dispatch settle0
is permitted. This floor avoids deliberately admitting a predictably truncated provider phase;500ms publication is
a minimum opportunity, not a guarantee that phase2/commit finishes. Unknown egress commit still retains any reservation.

Commit an EGRESS_COMMITTED attempt BEFORE dispatch. Successful confirmed commit mints one private in-memory dispatch
capability, consumable once only in that task; the provider adapter cannot be called without it. Recheck local terminal/
deadline state immediately before consuming. No locks or DB transaction cross HTTP. If no remaining provider/publish
budget, do not dispatch. If terminal occurs after commit, leave its reservation (or safe known-no-dispatch settlement
below); do not start a provider call. Unknown commit outcome never dispatches and never retries/reuses requestId.

Egress admission linearizes at this commit. A concurrent revocation/pause before it blocks the call; one after it can
prevent final answer but cannot retract an already admitted dispatch/question/cost. The commit-to-wire interval is not
an atomic network send. Final phase2 repeats current all-of permission, policy/ack admission and captured fence epoch;
revocation/expiry/version change discards the answer with existing401/403/409 or fixed remote policy error. A valid
answer/failure audit must still commit before HTTP; costs can remain without a delivered answer or completion audit.
Remote final audit uses existing keys provider='openai',ruleVersion='ask-remote-intent-v1',itemCount,outcome,safeErrorCode;
no new audit metadata keys, request body, question length/hash, model output or usage there. Ledger carries numeric usage.

## Durable model of money (USD micro-units, integer arithmetic)

Proposed default caps per dedicated project/workspace: **US$0.30 reservation/attempt, US$2 per UTC day, US$10 per UTC
calendar month**. These are proposed architecture limits, NOT owner authorization to incur charges. Future paid
admission may lower DAY/MONTH caps only. This profile fixes reserve300000 and settlement rate constants275/825;
a different reserve/rate/profile requires a reviewed amendment and updated DTO/prompt/profile/evidence, never mutable
pricing that disagrees with the public literal. Increasing limits requires renewed review and owner budget approval.
The ledger bounds this service's admitted token charges under the pinned price contract; it cannot cap provider taxes,
other project usage, a compromised key or a vendor price/behavior change. Provider-side project controls are additional
defense, not assumed hard limits. Dedicated key/project is mandatory and cannot be used outside this service.

The conservative reservation deliberately avoids an unproven byte→token/framing estimate. Full model input window
1,050,000 × worst long-context/cache-write/EU rate US$0.275/MTok plus512 × worst output EU rate US$0.825/MTok
= US$0.2891724, round UP to300000 microUSD. This over-reserves even though actual payload≤16KiB and cache writes are
disabled. No discount assumption. Prices/model-window bounds must be reverified before owner admission; an expired or
unverified price revision disables egress. A provider charging outside this admitted contract is an explicit residual,
not proof that an application counter guarantees an invoice. No billed provider calls during design or offline tests.

RemoteAskPeriodCounter unique key (workspaceId,projectIdentity,kind DAY|MONTH,periodStart UTC), chargedMicroUsd≥0.
Project identity is immutable across policy revisions; admissionId is metadata, never a new budget partition.
RemoteAskAttempt has server attemptId UUID (separate from untrusted requestId), workspace/client/actor scoped keys,
admissionId/policyVersion/profile/priceRevision, server correlation UUID, createdAt, immutable day/month period keys,
reservedMicroUsd=300000, accountedMicroUsd0..reserved, state EGRESS_COMMITTED|SETTLED|UNKNOWN,
nullable validated prompt/completion token counts, and fixed outcome enum. No question/requestId/provider body/ID/URL.
Immutable identities cannot be reassigned; state/amount transitions enforced by SQL checks/routines/triggers. Attempt
record is accounting, never an execution queue, idempotency grant, answer cache or resumable job.

Reserve routine locks MONTH then DAY, checks both `charged +300000≤approvedCap`, inserts attempt and increments both
atomically. Missing counters are created with unique-key-safe insertion inside the transaction before fixed-order locks;
all routines use this order. A rollback charges neither; concurrent processes share the same durable counters. No cap
refund on manual retry, restart, elapsed TTL, timeout/disconnect, policy replacement or midnight boundary alone.
New admission revisions share the existing project's monthly/day spend totals; admissionId is NOT a fresh budget.
Pin project identity in attempts and policy. Project replacement during an open budget period is forbidden; migration
to another project requires a separately reviewed carry-forward design. Do not rotate project to reset spend within an approved budget period.

After settled HTTP, a separate bounded≤2s financial-only transaction settles the attempt exactly once. For validated
model/tier/usage, retain ceil((promptTokens×275+completionTokens×825)/1000) microUSD and atomically subtract the unused
reservation from its ORIGINAL day/month counters, with integer range checks. This is a conservative token cost, not
an invoice reading. Settlement first reads immutable period keys without locking, then locks MONTH→DAY→attempt FOR UPDATE, verifies
captured identity/state and updates attempt + both counters atomically. It never acquires an authority fence while
holding these locks. Duplicated/late settlement cannot refund twice or another attempt. Missing/invalid usage, uncertain
delivery, transport error, timeout, malformed identity/tier or crash leaves300000 charged (UNKNOWN optional transition).
A proven in-process no-dispatch terminal before capability consumption may settle0; no crash/restart inference can.
Malformed content/refusal with otherwise verified usage can settle known cost but never return an answer.

Normal order is provider validation → financial settlement attempt → phase2 authority/audit → HTTP. Settlement has
its OWN absolute≤2s phase clock independent of AskRun.terminal, with bounded pool/statement/cleanup; before publication
it is additionally bounded by original time remaining minus the500ms publication floor. A known settlement failure
does not by itself reject an otherwise valid answer; retain conservative accounting and continue phase2 if budget/
authority allow. Unknown underlying DB cleanup retains the owner even if the answer is published. No automatic retry.
Only usage fully validated before provider-phase/public terminal may reduce the reservation; late transport success
after timeout is discarded, never parsed into a new refund/answer. Financial-only drain may settle ALREADY captured
valid usage or proven no-dispatch state after public terminal. It cannot consume new provider content after timeout.

Financial settlement is allowed during drain after public terminal or authority revocation: it is scoped bookkeeping
for the captured immutable attempt, not new data access or authorization. It never publishes/starts a source read/
completion audit or changes policy except narrow pause. A failed/unknown settlement commit is NOT retried and never
assumed refunded; DB amount may be settled or reserved. Conservatively reserve unchanged local state and rely on DB
truth for future admissions. No background retry/reconciliation worker or automatic restart resubmission. Unknowns can
consume budget until a later separately authorized metadata-only finance reconciliation; never refund based on time.
Public response need not wait after its deadline, but underlying owner remains until transport + settlement cleanup.

Counters retain prior periods/unknown reservations; UTC day key is(now() AT TIME ZONE 'UTC')::date, UTC month key is
date_trunc('month',now() AT TIME ZONE 'UTC')::date, independent of session TimeZone. Late settlement adjusts original
periods. New period does not erase old liability. Retain financial metadata90 days minimum and counters at least until
all related liabilities/archive requirements are resolved; no cleanup task in this checkpoint. No question retention.
Downward cap change below current accounted spend pauses new admission; never rewrites history or grants extra funds.

Pause runs in a separate bounded transaction with fence FIRST FOR UPDATE→policy; never from a transaction holding
financial locks or a shared fence. A detected model/tier/usage mismatch immediately closes the local circuit, then
attempts durable pause before releasing that owner. Other processes can have already admitted calls until pause commits;
those calls keep reservations and final publication still rechecks policy. No claim of atomic vendor-fault notification.
Pause also advances policyVersion and the shared workspace fence, so unrelated in-flight Ask/Stage3 work can observe
an epoch change and fail its existing final admission; this conservative workspace-wide invalidation is intentional.
