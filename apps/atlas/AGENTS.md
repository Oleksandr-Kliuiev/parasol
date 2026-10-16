# Atlas implementation instructions

## Current delivery roles — owner policy 2026-10-11

Read `docs/DEVELOPMENT_WORKFLOW.md` before planning, delegation or review. For ALL future work,
this section and the workflow's current role policy override older model/effort/gate assignments in
this file, nested `AGENTS.md`, stage documents and historical workflow sections. Preserve accepted
scope, contracts, seals and historical acceptance evidence; never relabel old reviews as new approvals.

| Concern | Required model and effort | Responsibility |
|---|---|---|
| Orchestration | GPT-6.1 Sol (`gpt-6.1-sol`) / `medium` | User communication, task briefs, coordination, integration and accurate status/evidence |
| Architecture development and agreement | GPT-6 Astra (`gpt-6-astra`) + native Claude Fable5.1 (`claude-fable-5-1`), BOTH / `xhigh` | Develop/resolve architecture; obtain both independent approvals of the SAME current frozen architecture artifact before implementation |
| Implementation and related fixes | Native Claude Opus5.5 (`claude-opus-5-5`) / `medium` | Claude Code CLI implements the approved scope, with one checkout writer |
| Independent checkpoint acceptance | GPT-6.1 Sol (`gpt-6.1-sol`) + native Claude Opus5.5 (`claude-opus-5-5`), BOTH / `xhigh` | Two independent NEW CLEAN initial review sessions inspect the SAME actual changes/artifact and verification evidence; both must approve |

Architecture agreement and checkpoint acceptance are separate gates. A new/material architecture
requires Astra/Fable development and independent agreement. A plan, preparation/evaluation checkpoint
or implementation inside already approved architecture uses Sol/Opus acceptance; it does not reopen
Astra/Fable merely because it has a new checkpoint name. If its substance changes architecture,
return to Astra/Fable first. In particular, ASK-REMOTE R-EVAL preparation uses Sol6.1/Opus5.5 at xhigh;
Astra's additional historical review and Fable availability are not its required acceptance gate.

Clean initial reviewers receive requirements, exact artifact/hash and checks, without author/implementer
conversation history or the other reviewer's verdict. Neither orchestration nor implementation sessions
count as independent acceptance; Opus acceptance is a separate session from Opus implementation.
A bounded repair re-review may continue that reviewer's own independent session at `xhigh` with the
exact delta/new identity and updated checks. New scope or critical invariant changes require fresh reviews.
Pin every launch explicitly; native Codex reviewers use `fork_turns: "none"` plus explicit model/effort.
Anthropic roles use native Claude Code authentication and exact model/effort. No inherited identity,
silent substitution, effort downgrade, API/credits or paid fallback. Unavailable REQUIRED role/settings/
billing keeps that specific gate pending; never invent an unrelated role as a blocker.
Record launch/effective model evidence, effort, artifact/hash, findings, checks and residuals. Data/budget,
paid inference, accounts, LIVE and deployment admissions remain separate explicit owner decisions.

## Project routing and historical status

Delivery details and handoffs: `docs/DEVELOPMENT_WORKFLOW.md`. Older assignments below are historical;
apply the current role policy above to the next affected task without modifying accepted history.

Post-Stage 1 routing: `docs/ROADMAP.md` and `docs/stage2/README.md`; Stage 3 (MOCK governed actions): `docs/stage3/AGENTS.md` and `docs/stage3/IMPLEMENTATION_STATUS.md`. Checkpoint C is accepted in its recorded/mock scope (`REVIEW_REPORT.md`); live gate remains open. Stage 2 RC5 architecture is accepted and the owner has requested implementation through its checkpoint gates. Do not restart completed Stage 1 tasks. Its review scope and gates live in `docs/stage2/AGENTS.md` and `REVIEW_STATUS.md`.

The user has authorized preparing and implementing Atlas Foundation according to this pack. Do the useful authorized work without repeatedly asking whether to continue. Deployment, account modifications and outbound messages are outside this Stage 1 request.

Read START_HERE_RU.md, docs/01_STAGE_1_SPEC.md and docs/05_IMPLEMENTATION_PLAN.md first. Read detailed documents only when the current task needs them. Do not load every file into each prompt.

- Treat this package as a reference and plan, not a production completion report.
- If an existing repo is present, inspect its AGENTS.md and current architecture, create a branch, and map the pack to it. Preserve existing features and data.
- Do not add UI, Agents/Responses orchestration, automatic remediation, write-actions, vector databases or a graph database to Stage 1.
- Enforce workspace/client/connection scope before all reads and calls. The model cannot supply actor authority, credentials, risk or client permissions.
- Keep confirmed links separate from candidates. Similar names or hostnames alone never prove identity.
- Route errors/refusals/uncertainty to visible review. Source HIGH/CRITICAL stays urgent regardless of AI output.
- Do not send raw records, free-text tickets, credentials, names or emails to Decisions in this first slice. Expand its evidence contract only with a reviewed redaction design.
- Keep dependency versions pinned. Prisma schema here intentionally uses 6.19 syntax. Do not silently migrate to the current major version.
- Synthetic normalizer inputs are Atlas DTOs, not verified vendor webhook contracts.
- In production, persist event deduplication and observation/audit transactions; the in-memory map is only a test reference.
- Run relevant tests, typecheck, migration validation and API build. Test PostgreSQL before claiming the DB-backed stage complete.
- Record blockers, remaining tasks and verification honestly in CHECKPOINT_REPORT.md. Never describe mock transport as live API verification.
- Keep secrets out of git and artifacts. Use secret references in the DB.
- v1.1 contracts are the baseline: Actor with per-client memberships, `ClientContextV1` with resource statuses, `reasonCodes[]`, `priority`, `resourceType` in event identity and links, `AtlasError{code, kind}`. Do not reintroduce flat permissions, a single `reasonCode`, or a context whose missing resource looks like an empty list.
- A stored event is never lost to an exception: CONFLICT → visible HUMAN_REVIEW with source severity, TRANSIENT → bounded RETRY, PERMANENT/unknown → DEAD_LETTER with audit. Provider failure is a FAILED DecisionRun plus rules fallback, never a dropped event.
- Client audit records are built from an explicit allowlist; never spread an event or any payload into an audit row. Scope denials go to the workspace SecurityAuditEvent with the requested client ID as text, never into a client's audit.
- Run client data access through `withScope` (set_config … true inside the transaction) as the confined runtime role from `prisma/roles.sql`. Never connect the API or worker as the table owner; `assertRuntimeRole` must fail in that case. Migrations and the synthetic seed are the only owner operations.
- Model name and allowed response models come from configuration; a mismatch is `MODEL_MISMATCH` in DecisionRun, not a generic failure. Shadow AI runs are stored with `applied = false`; the observation references the applied run only.
- Source severity comes from the source's documented mapping; disk or other thresholds are Atlas configuration, not normalizer logic.
- Decide once, commit atomically: DecisionRuns are written as `applied = false`; the applied flag, the observation, the audit row and the inbox completion change in one final transaction. A retry of that transaction reuses the stored decision and never calls the provider again. Shadow never blocks the baseline. In advisory mode a provider failure is HUMAN_REVIEW, not a silent rules route; a sustained outage is handled by switching the mode to `rules`.
- Same source ID/revision with different content is a separate evidence row linked by `conflictOfEventKey`, routed to urgent review with its own severity; the canonical row is never overwritten.
- Add schema changes as new migrations. `202610070001_foundation`, `202610071200_v1_1_contracts` (revised once in 1.1.1 before any known deployment) and `202610071500_v1_1_2_conflict_scope_and_legacy_guard` are frozen — a database that applied the 1.1.0 text uses `prisma/upgrades/v1_1_0_to_v1_1_1.sql` and then `db:deploy`. Unknown status values in a populated database stop the migration on purpose.
- Every cross-row link carries the scope: a foreign key on a global key alone (eventKey, id) is a defect even when RLS hides the parent. Migration-only markers (`legacyClosure`) are protected by triggers, not comments.

For authorized Stage 1 work, proceed through tasks 1.1–1.10 and stop at explicit checkpoints for a reviewable report. For later stages, follow the current roadmap and stage gate; do not restart completed Stage 1 work.

Stage 4 PowerOffice MOCK architecture RC2 is dual-approved: read `docs/stage4/AGENTS.md`, `docs/stage4/REVIEW_STATUS.md` and `docs/stage4/IMPLEMENTATION_STATUS.md`. S4-A is ACCEPTED on S4A-rc5; S4-B synthetic sync/publication/recovery is ACCEPTED on S4B-rc2 by fresh explicit Astra/xhigh. S4-C dedicated reads/API/CLI and maintenance is ACCEPTED on S4C-rc5 by explicitly assigned Astra/xhigh. Stage4 MOCK checkpoints A–C are complete; no further implementation is authorized by this acceptance. Stage1/2/3 accepted history stays frozen, LIVE remains deferred.

Stage5: owner selected local operator console first, then Ask Atlas. Read `docs/stage5/AGENTS.md`, `README.md`, `REVIEW_STATUS.md` and `IMPLEMENTATION_STATUS.md`. Architecture RC3 is dual-approved on package b2fc0f89605cc27039044ff6f934cb06ee3180f23f8372ab2f427388ce4e72a7 (seal verification/stage5/S5_DESIGN_APPROVED.json). S5-A serving/credential/client boundary is ACCEPTED on S5A-rc2 by explicit Astra/xhigh; seal verification/stage5/S5A_APPROVED.json. Native actual Opus5.5/high implemented and repaired in one session; both required RC1 findings are closed. S5-B context/queue/detail/stored evidence and UX is ACCEPTED S5B-rc1 by fresh explicit Astra/xhigh with no required findings; seal verification/stage5/S5B_APPROVED.json. Native actual Opus5.5/high implemented the approved concrete brief RC2 (verification/stage5/S5B_BRIEF_APPROVED.json). Verify accepted source/build identity and closure receipt before dependent work. Ask Atlas OFF/MOCK architecture RC3 is dual-approved (verification/stage5/S5ASK_DESIGN_APPROVED.json): read docs/stage5/ask/AGENTS.md and DESIGN_STATUS.md. ASK-A ACCEPTED S5ASKA-rc3 by fresh explicit Astra/xhigh; native actual Opus5.5/high implemented and repaired in the same session. R1/R2a/R2b/R3/R4 closed; verification/stage5/S5ASKA_APPROVED.json. ASK-B depends on accepted ASK-A. OFF/MOCK only, external inference is a later separate amendment. LIVE/pilot/deployment stays deferred.


ASK-A current acceptance: **ACCEPTED S5ASKA-rc3**; [Astra/xhigh report](docs/stage5/reviews/ASTRA_S5ASKA_RC3.md).
Native actual Opus5.5/high session60e70e73-4279-474b-a915-b95e4abfb6d9; two repair rounds in the same session.
Fresh explicit Astra/xhigh closed R1/R2a/R2b/R3/R4 on package213eec92b91a907514161c485258304e197babb42fd5c63da66e3849112f5362.
All14checks passed:326unit/PGlite,616PG17,50browser. OFF/MOCK backend only; ASK-B and ASK-REMOTE NOT_STARTED.
Seal verification/stage5/S5ASKA_APPROVED.json; exact source/build and administrative closure verification/stage5/S5ASKA_CLOSURE_VERIFICATION.json.
Six approved norms/shared auth/schema/dependencies/operator unchanged. Physical cleanup and injected-seam qualifications remain in the report.

Current ASK-B gate: ACCEPTED S5ASKB-rc2 by fresh explicit Astra/xhigh; R1/R2/R3 closed.
ASK-A accepted source/build identity verified before work; browser OFF/MOCK only, same six-file architecture RC3.
Brief docs/stage5/ask/S5ASKB_IMPLEMENTATION_BRIEF.md; no ASK-REMOTE/deployment admission. Required fixes stay in the SAME ASK-B Opus session.

Historical ASK-B RC1 package0b4ab289f229e8f01f3e7584d0fd7ffc478547905da42cecde38ad6cdd9f8f30: R1 insufficient-text honesty, R2 manual-focus isolation, R3 active-page coverage consistency.
Historical RC1 review and RC2 repair brief remain preserved; current acceptance S5ASKB-rc2 below.

ASK-B current acceptance: **ACCEPTED S5ASKB-rc2**; [Astra/xhigh report](docs/stage5/reviews/ASTRA_S5ASKB_RC2.md).
Package ea8620f374420c7fef3c6261ef3a37d9417add2a0bd3d664eef907a6875d41ad; native actual Opus5.5/high session de9faf68-215d-4742-8d88-503f198c1f3e, related repairs in the SAME session.
All 14 checks passed: 358 unit/PGlite, 616 PG17, 73 browser. Required R1/R2/R3 closed; read-only browser OFF/MOCK only.
Seal verification/stage5/S5ASKB_APPROVED.json; exact closure verification/stage5/S5ASKB_CLOSURE_VERIFICATION.json.
ASK-A backend/dependencies and six Ask/eight console norms preserved. ASK-REMOTE NOT_STARTED; external provider/data/billing amendment and LIVE/deployment remain separate gates.

Current ASK-REMOTE gate: DESIGN RC2 DUAL_APPROVED by fresh Astra/xhigh and native actual Fable5.1/high on the same package.
Routing docs/stage5/ask/remote/AGENTS.md and DESIGN_STATUS.md. Current candidate GPT-6 Luna; question-only intent, local evidence/compiler.
Engineering architecture accepted; R-A accepted; R-B/R-C implementation NOT_STARTED. No data/budget admission, paid inference, real customer use or deployment. ASK-B S5ASKB-rc2 remains accepted.

Architecture package 9c92327f6a3d693031c30cc907091f6dd61f4e0747491e10f00a784f877719d3; seal verification/stage5/S5ASKREMOTE_DESIGN_APPROVED.json.
Independent reports: [Astra/xhigh](docs/stage5/reviews/ASTRA_S5ASKREMOTE_DESIGN_RC2.md), [Fable5.1/high](docs/stage5/reviews/FABLE_S5ASKREMOTE_DESIGN_RC2.md). R-A execution/acceptance is recorded below; R-EVAL requires separate owner admission.

Current ASK-REMOTE R-A: **S5ASKREMOTE-RA-rc2 ACCEPTED** by fresh independent Astra/xhigh. Required R1–R5 closed in the SAME native Opus5.5/high session.
Brief docs/stage5/ask/remote/S5ASKREMOTE_RA_IMPLEMENTATION_BRIEF.md; exact baseline verification/stage5/S5ASKREMOTE_RA_IMPLEMENTATION_BASELINE.json.
R-A only: inactive policy/permission/scoped financial routines/roles/readiness; no provider adapter or paid calls. R-B/R-C NOT_STARTED.
Acceptance report docs/stage5/reviews/ASTRA_S5ASKREMOTE_RA_RC2.md; current implementation report docs/stage5/ask/remote/S5ASKREMOTE_RA_RC2_REPAIR_REPORT.md supersedes the historical RC1 claims.
All14 checks passed:368 unit/PGlite,651 PG17,73 browser; clean production copy reproduces228 outputs, operator unchanged. RC2 mutations11/12 detected; N05 redundant layer/N12 combined protection qualified in evidence.
Seal verification/stage5/S5ASKREMOTE_RA_APPROVED.json; closure verification/stage5/S5ASKREMOTE_RA_CLOSURE_VERIFICATION.json; package 1b6ff0b80b1bfcb68c82be4064aa7c909623769c03261bde9e9d87869df7556d.
SQL trusts NO_DISPATCH; private non-reconstructible in-process dispatch/refund proof remains mandatory R-B acceptance work. Data/budget/R-EVAL/LIVE/deployment NOT_ADMITTED; paid product calls0.

Current ASK-REMOTE R-B: **S5ASKREMOTE-RB-rc2 ACCEPTED** by fresh independent Astra/xhigh; mandatory findings0. Native Opus5.5/high implementation and required repairs use session d7982c45-9ae5-4da2-9568-3c31a1d6c269.
Accepted R-A S5ASKREMOTE-RA-rc2 identity verified before work; R-B uses the same dual-approved remote DESIGN RC2.
Brief docs/stage5/ask/remote/S5ASKREMOTE_RB_IMPLEMENTATION_BRIEF.md; exact implementation baseline verification/stage5/S5ASKREMOTE_RB_IMPLEMENTATION_BASELINE.json.
R-B accepted server/adapter and synthetic offline seams only. Evidence: verification/stage5/S5ASKREMOTE_RB_APPROVED.json, S5ASKREMOTE_RB_CLOSURE_VERIFICATION.json; review docs/stage5/reviews/ASTRA_S5ASKREMOTE_RB_RC2.md. R-C/R-EVAL NOT_STARTED; data/budget NOT_ADMITTED; paid provider calls0; no customer use/account/key/deployment admission.


Current ASK-REMOTE R-C: **S5ASKREMOTE-RC-rc1 ACCEPTED** by fresh independent Astra/xhigh; required findings0. Native Opus5.5/high and related repairs use session 52b493a5-deaf-4f34-8374-c9b253f641bd.
Owner authorized R-C on 2026-10-11; accepted R-B S5ASKREMOTE-RB-rc2 source/build identity verified before preparation.
Brief docs/stage5/ask/remote/S5ASKREMOTE_RC_IMPLEMENTATION_BRIEF.md; preflight verification/stage5/S5ASKREMOTE_RC_PREFLIGHT.json; exact baseline verification/stage5/S5ASKREMOTE_RC_IMPLEMENTATION_BASELINE.json.
Scope: browser V2, disclosure/per-question consent, policy generations and offline E2E/runbook under dual-approved remote DESIGN RC2.
Acceptance: docs/stage5/reviews/ASTRA_S5ASKREMOTE_RC_RC1.md; seal verification/stage5/S5ASKREMOTE_RC_APPROVED.json; closure verification/stage5/S5ASKREMOTE_RC_CLOSURE_VERIFICATION.json.
Included subscription only; no API/credits/fallback or paid product calls. Data/budget/R-EVAL/customer use/deployment NOT_ADMITTED.
