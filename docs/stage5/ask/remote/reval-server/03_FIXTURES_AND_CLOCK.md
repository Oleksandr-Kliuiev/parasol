# Isolated fixture DB and synthetic evidence time

## One scope, eleven alternative source states

The frozen offline RC3 file `../eval/data/fixtures.json` defines exactly FX01..FX11 in workspace
`syn-ws-reval`, client `syn-client-reval`. Those IDs, the 200 question bytes/order, expected facts and
hand-declared projections remain unchanged. The fixtures are mutually exclusive alternatives, not eleven
clients, a union of rows, or parallel inference servers. Exactly one fixture is installed at a time.
The dedicated project, admission row, ledger/counters, designated actor and client identity persist across
ALL cases, days and fixture switches. Never clone/rotate the finance database to reset spend.

Provision only an explicitly registered disposable synthetic PostgreSQL17 database on an isolated instance,
with no customer data, vendor worker, sync scheduler or unrelated application. Before any destructive step,
the owner verifies instance identity, explicit database allowlist, scoped synthetic inventory, relevant role
surface and absent external integrations. A name prefix, env var, empty-looking query or registration row
alone is insufficient. A second independent connection must confirm the intended physical DB registration.

One writer owns the sandbox. The maintenance tool refuses an unregistered DB, extra workspace/client/source
rows, unknown FK dependencies, live egress mode, unpaused policy, incomplete drain or another writer. It never
TRUNCATEs, drops a database, disables constraints/triggers/RLS, uses legacyClosure, edits old migrations, or
performs cleanup outside the exact registered synthetic source scope. These are design requirements, not
permission to run provisioning now.

## Materialization contract

Build a deterministic seed plan from the exact frozen fixture bytes and accepted expansion rules, never from
an observed provider answer or a production compiler's output. Its inputs are only the frozen manifest and
fixtureId. Refuse arbitrary JSON/SQL/row overrides. A reviewed seed mapping manifest pins all unprojected
schema-required literals and deterministic row IDs; its own hash joins the implementation package.

Source DML allowlist (all exact workspace/client scope): Connection, RawEvent, Observation, Entity, Person,
Device, ExternalEntity, EntityLink, SyncState, ResourceSnapshot. No event workers/DecisionRuns are invoked.
Parent Workspace/Client and designated Actor/membership/token are provisioned separately once under owner
control, never deleted/recreated to switch fixtures. RemoteAskPolicy/ClientAdmission/PeriodCounter/Attempt,
ActionAuthorityFence, AuditEvent, SecurityAuditEvent, ToolExecution and unrelated domain/history rows are
never deleted/reset/rewritten by fixture replacement. Fence changes occur only through accepted mechanisms.
Any FK dependency outside the source allowlist makes replacement refuse rather than cascading through it.

Required source representations:

- Expand pageSeries exactly; materialize original observation/event fields, fixed timestamps, severity,
  priority, status, reason codes, summary and entity linkage from `originalRow`/frozen declarations.
- Preserve exact source connection IDs/types and connection order. Materialize each listed expected type;
  MISSING is represented by the appropriate absent/PENDING state, never an invented successful empty read.
- OK/STALE declared snapshots use literal asOf/lastSuccessAt and truncated. Snapshot items may be the reviewed
  synthetic empty array because these fixtures declare no item facts; itemCount=0 and validators still run.
  ERROR with no snapshot retains literal lastSuccessAt; absent types retain true MISSING behavior.
- Materialize each typed entity and confirmed/candidate link with deterministic IDs preserving the declared
  first-confirmed-link ordering. Candidate-only/readerExcludedLinks remain excluded by the normal reader.
- FOUND off-page/resolved focus rows exist exactly as declared. MISSING IDs are actually absent. hasFocus
  derives from actual source availability and may differ from a non-null requestedFocus (FX10); do not
  turn the request's observationId into evidence that a focus exists.
- For a declared full truncated page (FX08), install exactly one reviewed lower-priority overflow sentinel
  beyond the 100 selected rows so the actual LIMIT101 reader proves truncation. Its deterministic synthetic
  ID/time/source are in the seed mapping manifest; it must sort after every declared page row, cannot be the
  requested focus, and must not enter any expected fact/bank. A marker flag alone does not prove truncation.

The seeder may not alter a visible fixture timestamp/text/ID or expected projection to make a failed check
pass. Required schema literals must satisfy existing constraints; an unrepresentable fixture returns to
architecture/dataset review, never weakening SQL or replacing DB source reads with fixture DTO injection.

## Transaction and switch procedure

At run opening, freeze a seed mapping and independently verify all eleven fixtures offline against PG17.
During a future admitted run follow frozen randomized case order; do not reorder cases to reduce switches.
A repeated fixture can remain installed if its identity/generation and proof still match.

For each needed switch:

1. Finish the preceding case's liability/handoff accounting. The owner confirms the strict closure pause in
   02 and QUIESCENT drain. Any unknown commit/owner/hidden activity blocks replacement and continuation.
2. In an isolated maintenance transaction, lock the existing workspace authority fence FIRST FOR UPDATE,
   then policy FOR UPDATE and fixture binding FOR UPDATE. Verify PAUSED and expected generation/admission.
   Acquire source row locks in a fixed table/key order, delete only the previous allowlisted source state,
   insert the new materialization and increment the binding generation once. Retain installedAt as real DB
   time. Existing Connection fence triggers retain their normal increments; no source change bypasses them.
3. Commit source and binding atomically. No partial fixture is visible. Ledger/counters and historical audit
   remain byte/logically unchanged. Do not hold a financial lock or run provider/network work in this transaction.
4. Run the read-only fixture proof below, still paused. Record the safe fixture/generation/check receipt.
   Manually refresh browser context/queue and clear its old selection, then obtain separate
   manual owner resume through existing policy administration if the original admission still permits it.
   Resume is outside this tool; it advances policy/fence, cannot extend expiry/caps, and requires fresh
   capability and per-question checkbox. No automatic owner activation API is introduced.
5. Re-pair with current process/fixture/policy generation. In the dedicated synthetic pane in04 manually
   enter the exact question, select its fixed requestedFocus (including FX10 MISSING), then give fresh consent.
   Then obtain instrument GO/arm and manually submit. Runtime phase1/egress/phase2 reject drift; no fixture
   generation can be supplied by the request. Normal queue selection cannot emit FX10 and is not a fallback.

Source changes while ACTIVE are rejected by the maintenance tool. The registered sandbox admits no second
source writer. OS/DB connection census and the actual authority fence protect this operational assumption;
if another writer cannot be excluded, DB=fixture proof is stale and the run cannot proceed.

## Explicit source-only freshness exception

Literal seeding is insufficient today: `packages/ask/read.ts` computes OK/STALE against the phase1 DB clock,
and the frozen asOf values are October10. Existing accepted OFF/MOCK/ordinary remote behavior is unchanged.
For THIS registered synthetic evaluation only, pass the pinned reference
`2026-10-10T07:30:00.000Z` to the existing resource-age projection. The live DB rows and ordinary accepted
validators/selector/compiler still execute; no precomputed bank or answer is substituted.

This is an explicit, narrow supersession of R-EVAL RC6 `S5ASKREMOTE_REVAL_PLAN.md:53–54`, which asserted
that expectations remain time-invariant and that production-code time is never replaced. Those sentences
cannot hold for these frozen source dates under the real clock. ONLY the registered synthetic sandbox's
resource-age projection receives this exception; ordinary production time and every real clock listed below
remain unchanged. The orchestrator must record this exact delta in the next separately reviewed R-EVAL plan
revision/manifest; never edit the accepted RC6 bytes or imply the frozen fixtures already met its assertion.

This reference is a compiled/manifest-pinned property of this fixture package, read through the trusted
registration/binding. It is not an environment/user/model override or a mutable `now` parameter on an API.
Every unrelated DB and ordinary remote/OFF/MOCK path continues to use the real DB clock. Missing/mismatched
registration, manifest, fixture generation or measured build refuses the synthetic projection path.

The frozen source reference affects ONLY resource freshness classification. It MUST NOT enter:
credential/actor validity, policy/price/admission expiry, authority decisions, finance day/month allocation,
reserve/settlement createdAt, real audit/publication timestamps, monotonic Ask/provider/DB/cleanup deadlines,
latency, pacing, owner evidence freshness, handoff expiry or closure. Test those clock domains independently.
The UI's synthetic evaluation disclosure and fixture proof identify this reference. Do not label its OK
cards evidence of current real-world freshness or use the result to validate production time aging.

Qualification: FX08 includes an OK alert at07:20 and other OK snapshots at07:58, with a15-minute alert age
window. No single reference at/after every snapshot reproduces all its declared OK states. The chosen07:30
reference reproduces the accepted predicate (which has no lower-bound rejection for a snapshot later than
its comparison time). These are artificial fixture semantics. Future-relative-to-reference timestamps do
not imply live vendor evidence. This exception must be explicitly approved; rejection blocks fixture-live
readiness and requires a separately reviewed corpus revision, never a silent timestamp shift or relabel.

## DB equals fixture proof

`fixture-check` uses a separate bounded local verifier process under the ordinary confined runtime DB role,
WITHOUT any browser/operator bearer, token, credential digest or private browser-auth handle. The owner
invokes the exact registered actor/workspace/client binding; within the read-only transaction the verifier
checks that DB actor/membership remains ACTIVE with all-of context:read+ask:remote, using the existing scoped
runtime DB data-access boundary. Trusted owner registration authorizes this fixed administrative source read;
it does not impersonate an authenticated HTTP caller. No arbitrary actor/scope can be supplied.
It permits only the registered PAUSED synthetic binding and fixed requestedFocus from the pinned fixture.
It performs the same source SQL/validators/projection as phase1 in a read-only scoped transaction; it cannot
invoke remote orchestration, reserve/dispatch, publish an Ask answer or write a completion audit. This
owner-only local check is an explicit administrative source-read exception, never a public route.
The evidence-reader DB role itself has no source SELECT grant.

Independently compare the ACTUAL DB read with frozen raw declarations and `expected-facts.ts`, not with a
second copy of production output: selected page/order/truncation, focus/extra/missing, every displayed fact
field, links/entity resolution, complete bank urgency/coverage and every five-intent expected projection.
All eleven fixtures x all five intents require PG17 proof before admission. Separately, RS-C must prove
all200 frozen case metadata paths executable through the manual pane, including all15 FX10 cases with the
EXACT absent ID and unchanged focus predicate. DB proof alone does not prove browser executability. Probe ordinary real source clock
as a separate negative: show why it no longer equals the frozen OK declarations; do not conceal that mismatch.

Exact FIXTURE_CHECK payload:
`{fixtureId,fixtureGeneration,datasetManifestSha256,seedMappingSha256,
syntheticFreshnessAt,sourceMode:'db',rowIdentity:true|false,sourceProjection:true|false,
expectedFacts:true|false,allFiveIntents:true|false,financeUnchanged:true|false,
realTimeFreshnessClaim:false}`.
Raw DB facts, questions, bank/answer/intent values and source hashes are transient inside the verifier only.
Persist only the booleans/allowed identities and fixed failure code. The dataset digest refers to the frozen
artifact, not a new hash of a runtime question/answer. A failure or stale generation blocks submission.
