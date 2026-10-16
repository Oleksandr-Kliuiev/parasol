# ASK-REMOTE R-A implementation brief

Owner authorized R-A through a FRESH native claude-opus-5-5/high session, then fresh gpt-6-astra/xhigh acceptance.
Required repairs use the SAME implementation session. No paid calls, provider HTTP, API billing, credits or fallback.
Repo /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1; HEAD916a4d69853ff6da636e8609a2e0bd33aa787f66,
branch planning/stage2-m365. Accepted dirty/untracked work is essential: HEAD alone is not the baseline.
Exact pre-write baseline: verification/stage5/S5ASKREMOTE_RA_IMPLEMENTATION_BASELINE.json, excluding itself.
Verify EVERY baseline source/admin hash and built hash before first write; retain a proof in assigned scratch.
Native session UUID and billing preflight are pinned in that baseline and S5ASKREMOTE_RA_PREFLIGHT.json.
Sole writer after handoff is Opus; no parallel implementation/build/formatter writer. Stop at R-A and return ownership.

## Approved basis and minimal context

Root AGENTS.md; docs/AI_CONTEXT_MAP.md; docs/DEVELOPMENT_WORKFLOW.md roles/gates, task handoff, identity/budget;
prisma/AGENTS.md; packages/ask/AGENTS.md; tests/pg/AGENTS.md; remote AGENTS.md and README.md.
Ten immutable remote RC2 norms: 01_SCOPE,02_CONTRACTS,03_DATA_AND_PROVIDER,04_AUTHORITY_AND_BILLING,
05_ACCEPTANCE,06_PROVIDER_DECISION,README,AGENTS,intent-prompt.json,intent-schema.json.
Package9c92327f6a3d693031c30cc907091f6dd61f4e0747491e10f00a784f877719d3;
seal verification/stage5/S5ASKREMOTE_DESIGN_APPROVED.json SHA2561f32029c4fbfc16dc5efb57545132d344dea590b003266c34c79209465a91590;
closure SHA256840772510385d7aae0391c4edb982e6ad52151a56928e02890b294b5a363cec8.
Both fresh Astra/xhigh and actual native Fable5.1/high approved this SAME package; design gate is complete.
Parent six Ask/eight console norms and all past evidence remain frozen. Do not load historical reports wholesale.
The approved nested amendment and explicit owner request supersede parent OFF/MOCK-only prohibitions ONLY for R-A.

Relevant entry files: prisma/{schema,m365,actions,poweroffice}.prisma and roles.sql (targeted relevant sections);
packages/graph/{runtime-role,fence-role,poweroffice-role,scope,auth}.ts; permission validation routing from context map;
tests/support/{pg-harness,roles-sql,action-fixtures}.ts and named existing privilege/upgrade tests.
Query the current permission CHECK and Stage3 fence migration narrowly; never load all migrations or edit old ones.
Keep active source/test/E2E/style files near500 and below700 lines; extract a coherent boundary before oversized growth.

## R-A deliverable and invariants

Implement ONLY permission migration, inactive durable policies/client admissions, scoped financial ledger/counters,
confined routines/role/readiness, pure integer budget transition module and their tests/runbook. NO provider adapter,
network capability, remote HTTP/capability/UI wiring, mode-config expansion, active seed/admission, key or account setup.
Existing ATLAS_ASK_MODE remains off|mock; no remote activation path is shipped at this checkpoint.

Follow04 exactly: one persistent policy row/workspace and immutable unique project/admission; strict independently
monotonic bigint policyVersion for ALL material policy/allowlist/pause/revoke/reactivate mutations; immutable history,
DELETE/recreate blocked; terminal inactive max-bigint tombstone; no auto ask:remote grants. Same-workspace composite FKs
for client/actor/attempt/policy and workspace FORCE RLS. No question/body/hash/length/provider IDs/URL in storage or logs.
Only explicit synthetic numeric metadata; validated token counts are permitted accounting and a coarse length proxy.
Retain fixed300000 microUSD reserve, conservative275/825 settlement rates, original UTC periods and project counters
across policy revisions/restarts. Caps may be LOWERED by later owner admission, never used to reset existing liabilities.
Atomic MONTH→DAY→attempt operations; safe missing-counter creation; integer ceil/range checks; exactly-once settlement;
unknown outcome retains reserve; no TTL/refund/replay/automatic reconciliation. Proven no-dispatch settlement0 must
stay within the explicitly authorized in-process case; no restart inference. No provider dispatch can occur in R-A.

New NOLOGIN/NOBYPASSRLS/NOINHERIT remote function owner has exact remote-column privileges plus scoped
SELECT(workspaceId,version),UPDATE(version) on ActionAuthorityFence. Existing fence owner/function/two policies unchanged.
Trusted revision/allowlist routines fence FIRST FOR UPDATE then policy; runtime can only reserve/settle/pause, never
activate, provision, revise or directly mutate any of the four tables. Re-evaluate admission predicates at the confined
reserve routine boundary (active/expiry/version/client/profile/price/caps) as required by the admitted transaction.
Owner provisioning calls trusted routines, not direct table DML. All new routines/trigger guards revoke PUBLIC EXECUTE.
roles.sql revokes new-table runtime DML AND forbidden column grants AFTER generic/default grants; adds eighth distinct
role and complete effective privilege/schema/routine/ownership/membership validation. Existing confined roles gain
nothing; schema CREATE/GRANT options/inherited memberships/login/BYPASS/extra ownership remain prohibited.
Add four tables to PROTECTED_TABLES and focused remote readiness, including exact RLS/FKs/ACLs/owner grants/fence columns.
Shared readiness must still pass OFF/MOCK; reprovisioning must not reopen DML or leak PUBLIC routine execution.

R-A establishes transaction/routine building blocks and pure checks. Original8s request,4500ms egress floor,2s DB/provider/
independent settlement and500ms publication contracts stay authoritative for R-B; do not wire a partial remote request
path here. R-A can expose testable finite DB helpers/pure eligibility functions needed by the later composition.
Do not silently adopt Fable's optional benign-usage relaxations, reordered settlement or new dispatch protocol.
Implement exactly the approved contracts; architecture contradictions require a concrete report before out-of-scope edit.
Record bounded shared-fence contention with Stage3 in runbook/report; unknown commits and external invoice limits remain.

## Allowed changes and frozen boundaries

Add focused prisma remote schema and NEW migrations; narrow additive relations in existing schema files as needed.
Extend the current permission vocabulary via new migration without modifying accepted migrations or granting permissions.
Change prisma/roles.sql for the exact reviewed role/routine/default-ACL deltas; extract a cohesive concern if needed to
stay under700, preserving production provisioning/rendering/transaction behavior and testing it. Add focused
packages/graph remote readiness and integrate it in shared runtime readiness; existing fence confinement stays unchanged.
New pure financial/domain modules under packages/ask/remote/, with a focused AGENTS.md routing their R-A boundary.
Narrow test support changes for new role names/provisioning and additive populated-upgrade/runtime-readiness assertions.
Focused unit/PG tests and small support modules; no weakening/removal of old assertions. Preserve accepted358 unit/PGlite,
616PG,73browser behaviors. No dependency/lockfile/build/tsconfig changes expected; report concrete need BEFORE extra scope.
Update prisma/AGENTS.md, packages/ask/AGENTS.md, tests/pg/AGENTS.md, docs/AI_CONTEXT_MAP.md and docs/RUNBOOK.md for routing only.
Report every changed existing file and why. All app/API/operator/service/compiler/planner/source/public DTO code frozen;
all old migrations, past reports/reviews/seals/manifests/archives and ten remote norms frozen. Root AGENTS/workflow/status/
brief/baseline/preflight belong to Codex. No commits/PR/deployment/LIVE/vendor calls/account or key provisioning.

## Verification and evidence

Focused pure tests plus REAL disposable PG17 with actual nonsuperuser runtime/definer/owner. Required R-A cases:
permission CHECK preserves vocabulary/no grant; populated upgrade from exact accepted baseline; FORCE RLS and scoped
FK negatives; foreign workspace/client/actor/admission/attempt/project; policy identity/no-op/material-change/version
revoke/reactivate/allowlist/max-bigint semantics; stale consent tuple rejected before reserve despite new fence epoch;
actual two-session/process last-dollar/day/month and absent-counter races; rollback/duplicate settlement/no negative
spend/original UTC period late settlement/session TimeZone independence; unknown/crash/restart no reset or replay;
lower cap below spend pauses admission. No actual provider/model call is needed or permitted. Synthetic disposable-DB tests may explicitly activate fixture
policies through trusted routines to exercise accounting; no active shipped seed or real admission is authorized.
Confinement negatives: stray PUBLIC routine (including invoker/trigger), missing/extra fence/remote-owner privileges,
direct runtime table AND column DML, role inheritance/membership/ownership, missing protected-table registration,
default-grant replay and reprovisioning. Existing fence/runtime readiness OFF/MOCK must continue passing.
Independent mutation probes must demonstrate meaningful assertions; isolate/restore each and retain original failures.

Then final ALL14 established checks: npm test, schema:validate, db:generate, typecheck, ui:typecheck, ui:build,
api:build, api:smoke, test:pg, db:check:pg17, db:check:drift, test:ui, git diff --check, untracked whitespace.
Also sealed-source clean install/generate/build and production dev-prune/foreigncwd smoke as05 requires; preserve full
logs in scratch, summarize exact commands/counts. Dist must reproduce current source; operator outputs unchanged.
Run commands that mutate builds/lockfiles only as sole writer or isolated sealed test copies, never concurrent root builds.
PG ONLY through silent /tmp/atlas-stage3/claude-tools/pgenv.sh with ONE absolute scratch runner and explicit child cwd/argv.
NEVER read/print wrapper, env, URLs, credentials or secret values. No real tenant DB or data; disposable synthetic only.
Disable product inference/auto-activation and use existing safe test harnesses. No HAR/traces/video/raw question/exception
logging; no API keys or plan credit enablement. No screenshots needed for unchanged browser.

All scratch/logs/probes/prodcopies/failures under /tmp/atlas-stage5/askremote/ra/impl/. Preserve every failed attempt.
After two ineffective repairs diagnose/re-plan; isolation/atomicity contradiction escalates immediately.
Write docs/stage5/ask/remote/S5ASKREMOTE_RA_IMPLEMENTATION_REPORT.md with exact deltas, invariants, tests/counts,
mutation/production evidence paths, failures, residuals, native model/effort/session and acceptance PENDING Astra.
Write a compact machine-readable evidence index in assigned scratch; never claim design approval is code acceptance.
Stop at completed R-A; return write ownership on CLI exit. Required fixes remain in this SAME fresh Opus session.
