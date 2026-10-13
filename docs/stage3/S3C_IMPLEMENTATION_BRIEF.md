# S3-C implementation brief — approved RC4 scope

This is routing and a bounded handoff, not an architecture amendment. Read the current repository/area AGENTS and
DEVELOPMENT_WORKFLOW, then normative docs/stage3/01_SPEC, 02_CONTRACTS, 03_DATA_AND_CONCURRENCY §§Models/Locking,
04_EXECUTION_AND_PORT and 06_ACCEPTANCE C1–C8/R1/R2. Do not load historical reports wholesale.

## Authority and artifact

Stage3 RC4 eight-document architecture already dual-approved by independent Astra/xhigh and native Fable5.1/high on package
`e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c`.
S3-A accepted RC3; S3-B accepted RC2 on `fd70db2d87c512a5d9c878d61cf77a71b3456d1000b06ced5a4ea2d4cf1c01ec`.
Codex verified the complete S3-B inventory plus its six exact administrative deltas, manifest/archive/report hashes.
The user requested continuation. Implement S3-C only, stopping for actual independent fresh GPT-6 Astra/xhigh acceptance.
Native Claude Opus5.5/high is the sole checkout writer during implementation; Codex coordinates and integrates.
Use native firstParty Anthropic subscription, exact model/effort, no fallback/API/credits. New cohesive implementation session.

Preserve existing dirty work; the exact handoff baseline is S3C_HANDOFF.json and the private baseline it names. No reset,
checkout replacement or commit. Freeze all 20 existing migrations plus lock, Stage1 REVIEW_REPORT, all prior acceptance seals,
reports/manifests/execution/evidence and historical ZIPs. The 11 Stage2 normative files (including ROADMAP) and eight Stage3
normative files remain byte-exact. Necessary additive SQL uses a NEW migration only; never edit installed SQL.

## Cohesive concern and entry files

Implement focused modules under packages/actions (mock-port, execution, publication, verification, recovery and small
support modules only where cohesive), focused action CLI module under packages/ops, thin scripts/ops.ts routing; necessary
contracts/audit/roles/readiness changes; focused tests/support and test files; concise RUNBOOK and context/status routing.
Start from accepted reservation.ts/guard.ts/authority.ts and prisma/actions.prisma. Query named SQL constraints/triggers in
202610091100 only as needed. Keep files near500/hard700; split independent workflows before extending oversized files.
Read existing CLI parse/auth boundary narrowly: actions use opaque action credential from bearer, not caller Actor DTO;
accepted Stage1/2 CLI/read Gateway stays unchanged in behavior. No HTTP actions or executable Gateway action tools.

## Execution and private ownership

Only trusted built-in MOCK composition and scoped atera FIXTURE binding, default DISABLED. Reject LIVE/origins/custom
scripts/ports/provider callbacks; no credentials or native HTTP/network. Fault injection remains private test-only.
Built-in ActionMockTicket store has independent scoped commits, immutable S3_SYNTHETIC rows and no marker deduplication;
never baseline evidence. Port create receives immutable normalized customer/marked title/body/create nonce, bounded ID only;
read receives exact connection+bounded ID and returns whitelisted ID/customer/full marked title/body/synthetic:true.

Reuse atomic reserve; exactly one lifetime create invocation, consume its private permit once before invocation, within
original five-second/approval deadline. No DB transaction spans a port call. Commit is authorization linearization:
later actor/token/epoch changes cannot retroactively block that approved bounded create. Current binding does gate NEW reads.
Known local pre-call refusal => NOT_DISPATCHED/zero calls, unique attempt stays consumed. Any possible call followed by timeout,
exception/429/5xx/malformed ID/crash/persistence uncertainty => OUTCOME_UNKNOWN, never retry create. Create AbortSignal15s;
late observed results use only owned private continuation, cannot invoke a new create/read. Restarted RESERVED recoverable
only at reservedAt+35s ->UNKNOWN, never redispatch. Do not downgrade already established outcomes.
Valid create ID => CREATED_UNVERIFIED, not success. Initial distinct read is separately freshly authorized and uses ordinal1.
If fresh authority/binding fails, retain observed create outcome and perform zero read.

## Verification, recovery and publication

Fresh context/read/execute same-membership ACTIVE authority under fence for each NEW verification/recovery. Recheck exact
stored binding/lifecycle, but original signer revocation/epoch drift alone after reserve does not bar fresh read investigation.
Candidate ID only protected reconciliation file exact whitelist kind ACTION_RECONCILIATION_CANDIDATE,dto action-candidate/1,
requestId,candidateTicketId; one immutable candidate perordinal. Known original ID wins; candidate cannot replace it.
Exact ID/customer/marker/complete normalized title/body required for VERIFIED; no search/list/inferred IDs or user assertions.
Candidate mismatch preserves UNKNOWN (or later CREATED_UNVERIFIED); original mismatch yields VERIFICATION_MISMATCH with
remaining read budget. UNKNOWN cannot be resolved without matching evidence; matching proves identity, not uniqueness.

Admission/recovery lock fence→request→approval→attempt→ordinal; clock after LAST lock/current bearer expiry as accepted S3-B.
Claim one unused ordinal1..3 with immutable nonce/target/hash/createNonce/times; count and seq advance atomically with
active claim fields and audit. One ACTIVE via DBunique. Claim deadline35s, read deadline15s from startedAt, no renewal.
No read before claim commit. ACTIVE remains BUSY even after expiry; only explicit recover after deadline ABANDONED+clear,
no refund. Count includes initial,failed,crashed reads. Three spent =>BUDGET. VERIFIED replay safe summary, zero read.

ALL owned fact publication locks request→attempt→ordinal, NEVER fence/approval/auth/Connection. Exact private capability,
stored token/ordinal/candidate/hash/createNonce and ACTIVE/DBclock<deadline required for verification results; late/abandoned
results stale even with no replacement. Failure completesFAILED+clear without losing established outcome. Result/state/audit
atomic; no partial verified success on audit failure. Private result ID immutable once. Publication knownrollback40P01/40001
only permits max3 attempts with SAME observed fact/token, zero port calls/new ordinal/deadline extension. Identical committed
publication no-op/no duplicate audit. Exhaustion =>ACTION_PUBLICATION_CONFLICT and recovery-safe prior state.

Late original ID publishable only by original private token/nonce, immutable once. Different VERIFIED candidate preserved
with safe conflict audit; sameID may attach provenance without downgrade. First late original different from activecandidate
atomicallyABANDONED/clear/no refund thenattach original/CREATED_UNVERIFIED; candidate completion stale. SameID keepsclaim.
Both ordering directions, recovery vs publication and concurrent verify must serialize without lock inversion or replay.

## CLI/privacy and privilege boundary

Expose all approved action-* commands, protected input/preview/reconciliation files, strict flags and safe fixed outputs
with synthetic:true. Candidate/ticket/customer/token IDs, title/body, secret refs/digests, private paths and raw errors NEVER
stdout/stderr/audit/telemetry. No private IDs in argv; safe get/list remain body-free. Reuse protected descriptor reader/writer
(fifo nonblocking, nofollow,fstat0600/owner/link1/boundedsize; outputnewabsoluteoutsideGit). Do not broaden ApiToken surface.
Keep DISABLED default and no network port selection. No background worker/schedule, new repair bypass or retention runner.
Extend roles.sql and exact readiness ONLY for required mutable request/attempt/verification fields and mock INSERT; identity,
intent,token,hash,epoch,binding,nonce immutable; noDELETE/TRUNCATE or cleanup/definer widening. Preserve S3-B grant-upgrade
fixture byteexact; add accepted S3-B roles fixture for S3-C upgrade if needed. All adjacent accepted-source changes reviewed.

## Acceptance and handback

Implement C1–C8/R1/R2 from frozen matrix with real PG concurrency/rollback/readiness tests and actual CLI-process journey.
Meaningful fault cases: pre-call refusal, possible-effect crash/timeout/latecreate, audit rollback, initialread authority loss,
failed/crashed/expired ACTIVE claims and3-budget, stale publication w/o replacement, lateoriginal/candidate bothorders,
same-fact conflict retries w/zero port retries, direct SQL immutability/scope, defaultdisabled/LIVE rejection and networktrap.
Avoid tests merely mirroring implementation. Deliberate deadline waits must be bounded and justified; do not invent caller
clock control or production callbacks for convenient tests. Non-superuser action observations use explicitly scopedruntime.
Focusedchecks duringwork, then tenrequired: npmtest,schema:validate,db:generate,typecheck,api:build,api:smoke,test:pg,
db:check:pg17,db:check:drift,gitdiff--check (+untracked whitespace). Tests create/drop OWN disposableDBs/roles only.
No .env/URLs/tokens/protectedcontent printed. Pilot/current/persistent DBs and account/config/network actions forbidden.

Keep prior evidence untouched. Write verification/stage3/S3C_IMPLEMENTATION_EVIDENCE.json: exact changed/new hashes,
commands/exits/counts and safe log locations, failed attempts/fixes, frozen preservation, actual model/session/effort,
elapsed/rework, residual risks/implementation choices. Update concise status as IMPLEMENTED/PENDING Astra acceptance,
S3-LIVE NOT_STARTED/LIVE DEFERRED_BY_OWNER; no self-acceptance or reviewer report/seal. Critical invariant contradiction
means stop/report, not contract amendment. Two ineffective repairs =>diagnose/replan. Finish S3-C and explicitly return sole
write ownership to Codex. Implementer report is NOT acceptance; fresh Astra/xhigh gate follows on exact packaged artifact.
