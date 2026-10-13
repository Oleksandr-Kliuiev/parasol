# Atlas delivery workflow

Established 2026-10-08. This is an operating policy, outside the Stage 2 normative package.
It neither accepts an architecture nor authorizes implementation, live access or deployment.
The current stage's specification, implementation plan and acceptance criteria remain authoritative.

## Current role policy — owner update 2026-10-11

This is the ACTIVE project delivery policy, mirrored in root `AGENTS.md`. It overrides every older
model/effort/gate assignment below and in nested `AGENTS.md` or stage instructions for future work.
Preserve historical evidence and frozen normative packages byte-for-byte; do not retrofit old approvals.

| Role | Exact model / effort | Work and gate |
|---|---|---|
| Orchestrator | `gpt-6.1-sol` / `medium` | Communicate with the owner, prepare bounded briefs, coordinate, integrate and maintain evidence/status |
| Architecture development and agreement | `gpt-6-astra` + native `claude-fable-5-1`, BOTH / `xhigh` | Develop architecture and resolve architectural choices; both independently approve the SAME current frozen architecture artifact before implementation |
| Implementation and related fixes | Native `claude-opus-5-5` / `medium` | Claude Code CLI implements accepted scope; keep related fixes in the same cohesive implementation session |
| Independent checkpoint acceptance | `gpt-6.1-sol` + native `claude-opus-5-5`, BOTH / `xhigh` | Separate NEW CLEAN initial sessions review the SAME actual artifact/changes and verification evidence; both approvals required before dependent work |

### Classify the gate by substance

- Architecture development/agreement belongs to Astra/Fable. A new architecture or material changes to
  authority, isolation, data boundaries, durability, public contracts or critical invariants return to
  that architecture gate before implementation. Roadmap approval does not approve a future stage design.
- Independent acceptance belongs to Sol/Opus. Implementation, preparation/evaluation and evidence
  checkpoints within accepted architecture use this pair. A new checkpoint name alone is not a new
  architecture, and does not make Astra/Fable a prerequisite for accepting ordinary checkpoint work.
- ASK-REMOTE R-EVAL preparation is an accepted-architecture checkpoint: required Sol6.1/xhigh plus
  Opus5.5/xhigh. Additional historical Astra review is supplementary; Fable is not a blocker here.
  Actual architecture changes discovered during R-EVAL still return to Astra/Fable.
- Architecture approval is not code/evidence acceptance. Neither gate authorizes data transfer, paid
  inference, account changes, LIVE, deployment or background schedules; those need their own admission.

### Independent sessions and exact artifact identity

Initial architecture approvals and initial checkpoint acceptance use fresh independent review sessions.
Supply requirements, the exact frozen artifact/commit/dirty-file hashes and verification evidence,
without the author's or implementer's conversation history and without the other reviewer's verdict.
Architecture drafting sessions do not count as independent architecture approval. The orchestrator's
ongoing session and implementer's report/session do not count as independent checkpoint acceptance.
Opus acceptance must be separate from Opus implementation; Sol acceptance separate from Sol orchestration.
Reviewers are read-only and do not edit what they accept. Before advancing, match the current artifact
to BOTH approvals. A later affected change needs renewed review; do not reuse approval of another hash.

A bounded repair re-review may retain that reviewer's own independent session at `xhigh` using the
exact new identity, delta and updated checks. New scope or critical invariant changes require fresh
reviews. Keep `xhigh` for review repairs; do not downgrade or substitute. Administrative policy/status
updates do not relabel historical acceptance or authorize code changes; declare their exact deltas.

### Launch, billing and implementation discipline

Explicitly pin exact model and effort on EVERY invocation. Prefer native Codex review subagents with
`fork_turns: "none"`, explicit model and reasoning effort; never inherit a named-model gate from the parent.
Run Anthropic roles through Claude Code CLI with native authentication and exact model/effort. Keep
one checkout writer, explicitly transfer ownership for implementation, preserve unrelated dirty work.
Independent read-only checks/reviews may run in parallel without shared-resource/file mutations.
No silent model/effort substitution, API billing, usage credits, premium fast mode or paid fallback.
Verify provider routing, included billing and actual response-model evidence; requested names,
self-identification and accounting labels alone are insufficient. Record unavailable telemetry honestly.
If a REQUIRED role, effort, access or billing setting is unavailable, keep only that gate pending and
report it; do not invent an unrelated required reviewer or silently bypass the named role.
Record artifact identity, assignments/effective model/effort, findings/fixes, checks, elapsed/attributable
usage when available and residual risks. Subscription quota attribution stays unknown unless evidenced.

Current R-EVAL: [plan](stage5/ask/remote/S5ASKREMOTE_REVAL_PLAN.md),
[admissions](stage5/ask/remote/S5ASKREMOTE_REVAL_ADMISSION.md),
[preparation status](stage5/ask/remote/S5ASKREMOTE_REVAL_STATUS.md). Data/budget NOT_ADMITTED; paid calls0.

Current offline R-EVAL package: [procedure](stage5/ask/remote/eval/README.md),
[dataset](stage5/ask/remote/eval/data/DATASET_MANIFEST.json). Clean Sol6.1/xhigh and Opus5.5/xhigh
acceptance tracked in `verification/stage5/S5ASKREMOTE_REVAL_OFFLINE_STATUS.json`. Human attestors
will be assigned later by the owner; labels DRAFT_MODEL_ASSISTED, human attestation PENDING.
This offline package neither measures live model quality nor admits data/budget; paid product calls 0.

Current local R-EVAL execution instrument: [operator procedure](stage5/ask/remote/execution/README.md).
Implementation uses native Opus5.5/medium; independent Sol6.1/xhigh and Opus5.5/xhigh acceptance
is tracked in `verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_STATUS.json`. This local preparation
does not establish live readiness; human labels, data/budget, server/ledger/closure/handoff/egress/privacy
proofs remain pending. No paid product calls. Historical accepted offline RC3 remains unchanged.

## Historical roles and gates

**Historical reference only.** All role/effort/acceptance assignments from this heading onward,
including later sections titled initial allocation, experiments or current state, describe prior
policy/evidence. They are not execution instructions for new work; the ACTIVE policy above controls.
General context, safety and handoff practices below still apply where compatible with that policy.
Do not load this history wholesale merely to choose a model or gate.

| Role | Responsibility | Execution route |
|---|---|---|
| Codex orchestrator | Clarify scope with the owner; prepare architecture and task briefs; coordinate work, verification, integration and status | Current Codex project chat |
| GPT-6 Astra | Independent architecture review and implementation checkpoint acceptance | Explicit `gpt-6-astra` subagent, `xhigh` effort |
| Claude Fable 5.1 | Independent architecture review; exceptional unresolved reasoning problems | Claude Code, native Anthropic, explicit `claude-fable-5-1` |
| Claude implementer | Implement the approved concern, run relevant checks and report evidence | Claude Code with an explicit model and effort |
| DeepSeek V4.1 Flash | Optional additional search for contract inconsistencies, edge cases and missing tests | DeepSeek Harness `dsh`; explicit `deepseek-flash` provider model |

For a new stage or material architecture change:

1. Codex prepares a bounded specification, contracts, acceptance cases and checkpoint plan.
2. Astra and Fable review the same frozen package independently, without each other's initial verdicts.
3. Codex resolves findings, updates the package identity and obtains both approvals for the current version.
4. Within an implementation request, Codex delegates one coherent task or tightly coupled task group to Claude Code.
5. The implementer runs focused checks. At a checkpoint, Codex inspects the diff and required evidence, then Astra reviews independently.
6. Required findings return to the implementer. Astra verifies the fixes before dependent checkpoint work advances.

Ordinary changes inside approved architecture do not require another two-model architecture review.
A change to authority, data boundaries, durability, public contracts or accepted behavior does.
DeepSeek findings are evaluated on their evidence; its approval cannot replace Astra or Fable.
Initial architecture reviews and the first review of each checkpoint use fresh context, with no other reviewer verdict
in the initial brief. Astra is always explicitly gpt-6-astra with explicit effort; prefer a native subagent with
fork_turns="none", never parent-model inheritance. A bounded re-review can retain its own session only for closure and
nearby regressions with unchanged contracts/invariants and passed affected checks. New scope or critical invariant changes
require a fresh xhigh reviewer. A resumed session keeps its effective effort unless the runtime actually changes it.

Reviewers do not edit the implementation they are accepting. Acceptance is tied to exact content and scope,
not a majority vote or a model's self-assessment. Before advancing, verify the current artifact still matches the accepted
identity. Later changes need renewed review of the affected scope. Status-only administration needs no code re-review
unless it changes requirements, reviewed content or acceptance evidence. Live and production gates remain separate.

## Initial model policy

The owner's Anthropic plan is Max 5x. Evaluate the cost of reaching acceptance, including repairs and review.
This allocation is a starting hypothesis, not a measured comparison of these models on Atlas.

| Work | Model / effort | Reason for allocation |
|---|---|---|
| Bounded implementation with explicit contracts; DTOs; routine API wiring; straightforward tests | Sonnet 5.5 / medium | Main implementation path with restrained reasoning spend |
| Authorization, isolation, SQL constraints/migrations, atomic publication, concurrent workers, recovery, identity resolution | Opus 5.5 / high | Start with more reasoning where mistakes can invalidate the design |
| Difficult task whose implementation remains stuck after diagnosis | Opus 5.5 / high, then deeper effort only when justified | Escalate on evidence instead of repeating unsuccessful attempts |
| Independent architecture review | Fable 5.1 / high, plus GPT-6 Astra / xhigh | The owner's required reviewers |
| Independent checkpoint acceptance (S2-A, S2-B, S2-C) | GPT-6 Astra / xhigh | Verify the actual implementation and checkpoint evidence |
| Bounded re-review of identified fixes with unchanged contracts/invariants and passed affected checks | GPT-6 Astra / high | Only when reviewed architecture and surrounding invariants remain unchanged |
| Exceptional problem still unresolved by Opus | Fable 5.1 with a bounded brief and verified billing | A targeted escalation, not the routine code generator |

Pin full model IDs (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`) and effort on every launch.
For Astra, explicitly set `model: gpt-6-astra` and `reasoning_effort: xhigh` (or `high` for the bounded re-review above).
Use a fresh `xhigh` reviewer for new scope or changes to authorization, isolation, atomicity, concurrency, recovery,
public contracts or other critical invariants. Diff size does not determine effort. Reserve `max` for exceptional
unresolved problems; record the effective effort with the review evidence.
Record the selected effort in review evidence; do not infer it retrospectively for older reviews.
Do not rely on the CLI's personal default or a moving alias. Changing this policy does not silently change that default.
Use normal inference speed; premium fast modes, API billing and usage credits are outside included-limit work unless agreed.
Haiku is not the initial choice for Atlas implementation; saving tokens on the first attempt is not the acceptance metric.

### Stage 2 allocation, after its architecture gate

| Plan task | Initial implementation assignment |
|---|---|
| 2.1 focused contracts and DTO schemas | Sonnet / medium; escalate if the approved contract needs a design decision |
| 2.2 persistence/grants and 2.3 permission/compatibility boundary | Opus / high |
| 2.4 Graph adapter | Sonnet / medium for mechanical DTO/HTTP work; Opus / high for token/tenant, URL and redirect boundaries |
| 2.5 directory generations and 2.6 sign-in windows | Opus / high |
| 2.7 deterministic correlation and identity rules | Opus / high |
| 2.8 read API/tools/CLI | Sonnet / medium for transport wiring; Opus / high for any new authorization or redaction logic |
| 2.9 retention/maintenance behavior | Opus / high; Sonnet can update the operational instructions |
| 2.10 acceptance fixtures, evidence and handoff | Sonnet / medium; Astra independently accepts the checkpoint |

Implementation checkpoints remain S2-A, S2-B and S2-C as defined in
[the stage plan](stage2/04_IMPLEMENTATION_PLAN.md). S2-LIVE requires its separate prerequisites.
Choose one owner for each bounded task; split ownership only when the file/domain boundary is clear.

## Task and review handoff

Each task brief provides:

- Outcome, permitted scope, non-goals and smallest relevant entry files.
- Baseline commit plus dirty-file snapshot/hash when work is uncommitted; approved architecture package identity.
- Invariants and acceptance cases, required commands, model/effort and assigned checkpoint.
- Allowed tools, write scope and reporting destination; no credentials or real customer records in prompts or reports.

Use one owner of write access per checkout, including Codex, delegates, formatters, snapshot and lockfile updates.
Transfer ownership explicitly; Codex regains it only after the writer finishes or is confirmed stopped. Parallel reads
and checks are permitted only without modifying reviewed files or conflicting over resources. Parallel writers need
isolated worktrees, explicit ownership and an integration plan.
Include required uncommitted work explicitly in an isolated baseline; a worktree at HEAD alone will omit it.
Keep one implementation session per cohesive task and its related fixes; use a fresh session for independent tasks or
assessment, subject to the reviewer rules above. Keep reusable instructions, tools and approved reference material stable
where practical; append findings and deltas. Do not retain unrelated history just for cache hits. Use commands for routine
checks and delegate when independent analysis is needed.
If safe mode disables automatic instruction loading, include the instruction paths explicitly in the brief.
Give reviewers enough repository/tool access to substantiate findings without write access to the implementation.

At handoff record changed files, actual commands and outcomes, actionable failures and remaining risks.
Run focused checks during edits and the stage's full required checks at checkpoints; rerun affected checks after fixes.
Do not rerun unchanged broad suites just to generate another report. Do not equate mocks with live verification.
After two repair attempts without meaningful progress, diagnose the contract, implementation or environment and escalate.
Escalate immediately for an isolation/authorization breach, data-loss risk or architectural contradiction.
Do not respond to a failing test by removing its requirement or loosening assertions to fit the implementation.

## Provider identity and budget

- Claude Code uses native Anthropic authentication; DeepSeek uses its own Harness configuration and credentials.
- Before external reviews, check routing and authentication without exposing tokens. Save CLI version, requested model,
  effective endpoint/provider, actual response model(s), effort, artifact identity and fallback events where observable.
- Requested model names, text self-identification and client accounting labels alone are insufficient identity evidence.
  If the required identity cannot be verified or a fallback handles the review, keep that named-model gate pending.
- Max usage is shared with Claude chat. API price tables and CLI estimated dollars do not establish the remaining quota.
- Check Fable's plan-specific billing before unattended execution: Claude Code `-p` can bill usage credits without a prompt.
  Do not enable credits or switch to API billing to get around a limit. Use the owner's agreed budget if separate billing applies.
- Start with one Claude implementation process. Add concurrency only for isolated work when its latency benefit warrants the usage.

For the first checkpoint, record per task: assigned/observed model, effort, duration, repair rounds,
confirmed review defects, acceptance outcome and usage when attributable. Mark unavailable quota data as unknown.
Use cache statistics to diagnose repeated input processing separately from subscription usage; cache-hit percentages
and API dollar estimates do not establish quota savings.
After S2-A, adjust the Sonnet/Opus boundary using this evidence; continue evaluating over 5-10 representative tasks.
Do not run duplicate paid implementations merely to benchmark every change.

## Orchestrator context and token budget

Owner-approved plan, 2026-10-10. Apply the context practices below now; model/effort experiments remain proposals.
Required architecture reviewers, checkpoint acceptance, checks, artifact identity and billing boundaries stay in force.

1. Keep one compact working snapshot in the current stage's `IMPLEMENTATION_STATUS.md`: current checkpoint,
   approved decisions and artifact identity, check outcomes, blockers/open findings, residual risks and next action.
   Link to contracts, review status, seals and detailed evidence rather than copying them into another report.
   This workflow's current-state section remains a routing summary. Aim for about one page of working state;
   retain every material gate, invariant and unresolved finding even when that needs more space.
2. After acceptance, verify that current content matches the accepted artifact and persist the acceptance record:
   commit/package identity and relevant dirty-file hashes, reviewer/model/effective effort, findings and closure,
   check commands/results, residual risks, and attributable usage when available. Preserve original evidence in place.
   Update the compact snapshot, then close completed agent sessions when the runtime supports it.
   Read historical iterations only to resolve a named question; closing agents does not remove reports already in chat history.
3. Give each delegate only the task, permitted scope, necessary entry files, exact baseline, invariants, checks and
   stopping checkpoint. Use fresh context for independent tasks and initial independent reviews, without another
   reviewer's verdict. Retain the same implementation session for a cohesive task and its repairs; bounded reviewer
   continuation still follows the existing review rules. Prefer short outcomes with evidence links over full transcripts.
4. Codex checks scope, artifact identity, actual changes and verification evidence, then integrates accepted work.
   Do not repeat the implementer's and reviewer's complete analysis. Investigate contradictions, failed checks,
   unexplained evidence or changed requirements; keep independent acceptance and required checks intact.
5. Start with the context map and nearest instructions, then use narrow searches/line ranges, `git diff --stat`
   and scoped diffs. Limit tool output; keep full logs in evidence files and return concise diagnostics.
   Stop searching once the decision has sufficient support. Repeat or broaden checks only after relevant changes,
   failures or unresolved concerns. Preserve enough evidence to reproduce and assess every acceptance decision.
6. At a major stage boundary, prepare a compact handoff with the working snapshot and links to governing instructions,
   approved contracts, current identities, checks, open gates and next action. Recommend a fresh main chat rather than
   copying the full conversation; create one only when the owner explicitly requests it. Until then, use narrow reads.

### Separate experiments; not activated by this plan

- Evaluate orchestrator `high` for routine coordination; reserve `xhigh` for difficult architecture decisions or
  critical contradictions. Record requested and effective settings; this document does not change runtime settings.
- Evaluate on 3–5 representative checkpoints against available baseline evidence: attributable input/reasoning/output
  tokens, elapsed time and subscription usage where observable, missed requirements/material defects, repairs and
  acceptance outcomes. Mark unavailable metrics unknown; do not claim savings or equivalent quality without evidence.
  Pause the experiment and diagnose any missed critical invariant or regression in acceptance quality.
- Keep model/effort changes separate from context-practice evaluation so their effects can be assessed independently.
  GPT-6.1 Sol acceptance is a separate future proposal requiring explicit owner authorization to change the named-model
  gates; it is not a substitute for currently required Astra acceptance. Preserve native subscription billing.

## Current state and next action

On 2026-10-08, the local tools were Claude Code 2.1.293 and DeepSeek Harness 0.2.0-rc.2.
Anthropic authentication was reported as `claude.ai` / `firstParty`; no inherited DeepSeek overrides were present.
This configuration check does not prove successful inference or named-model access.

Stage 2 RC5 architecture is dual-approved. S2-A, S2-B and S2-C code are independently accepted by Astra/xhigh;
[Stage 2 status](stage2/IMPLEMENTATION_STATUS.md) records exact identities and scope. S2-LIVE is DEFERRED_BY_OWNER.

Stage 3 MOCK-only architecture RC4 is independently approved by explicit Astra/xhigh and native Fable5.1/high on the
same frozen eight-file artifact. S3-A was implemented by native Opus5.5/high in one cohesive session and is accepted
by fresh explicit Astra/xhigh on S3A-rc3; [acceptance](stage3/reviews/ASTRA_S3A_RC3.md).
[Stage 3 status](stage3/IMPLEMENTATION_STATUS.md) is current. S3-B (approval and reservation) is accepted on S3B-rc2
by explicit GPT-6 Astra/xhigh; the bounded RC2 re-review retained the first fresh reviewer's effective xhigh and closed both RC1 findings.
[Acceptance](stage3/reviews/ASTRA_S3B_RC2.md). Native Opus5.5/high implemented and repaired S3-B in the same cohesive session.
S3-C (mock execution, verification, recovery and operator CLI) is ACCEPTED on S3C-rc2: [Astra acceptance](stage3/reviews/ASTRA_S3C_RC2.md), seal verification/stage3/S3C_APPROVED.json. RC1 was CHANGES_REQUIRED by a fresh explicit Astra/xhigh reviewer; the bounded RC2 re-review retained effective xhigh and closed R1–R3. Native Opus5.5/high implemented and repaired it in the same session. Final181 unit/PGlite and401 PostgreSQL tests; independent35 tests and two probes passed. Stage3 MOCK engineering is complete; S3-LIVE NOT_STARTED and DEFERRED_BY_OWNER.
No LIVE or production readiness follows from these MOCK gates.

Stage4 PowerOffice MOCK architecture RC2 is dual-approved on the same frozen eight-file artifact by fresh explicit
Astra/xhigh and native actual Fable5.1/high. [Review status](stage4/REVIEW_STATUS.md), [Astra](stage4/reviews/ASTRA_DESIGN_RC2.md),
[Fable](stage4/reviews/FABLE_DESIGN_RC2.md); seal verification/stage4/S4_DESIGN_APPROVED.json. S4-A is ACCEPTED on S4A-rc5 by fresh explicit Astra/xhigh: [acceptance](stage4/reviews/ASTRA_S4A_RC5.md),
seal verification/stage4/S4A_APPROVED.json. Native actual Opus5.5/high implemented and repaired it in one session; final
196 unit/PGlite and475 PostgreSQL tests plus all required checks passed. RC1 and its four required findings are preserved;
RC5 corrects them and subsequent RC2/RC3/RC4 confinement findings within unchanged architecture, including exact binding proof,
foreign/TEMP/builtin/unlisted ACL checks and rollback-only shared-catalog tests. S4-B synthetic
sync/publication/recovery is ACCEPTED on S4B-rc2: [acceptance](stage4/reviews/ASTRA_S4B_RC2.md), seal
verification/stage4/S4B_APPROVED.json. Native actual Opus5.5/high implemented it in one cohesive session; final
208 unit/PGlite and510 PostgreSQL tests plus all11required checks passed.
S4-C dedicated reads/API/CLI and bounded maintenance is ACCEPTED on S4C-rc5 by explicitly assigned Astra/xhigh: [acceptance](stage4/reviews/ASTRA_S4C_RC5.md), seal verification/stage4/S4C_APPROVED.json. Final 223 unit/PGlite + 565 PG17 tests and all11 required checks passed; pinned pg runtime packaging independently assessed. One native Opus5.5/high session implemented and repaired S4-C. Stage4 MOCK A–C complete; LIVE remains deferred.
The first slice uses dedicated API/CLI; financial Gateway integration requires a future contract. LIVE/account/pilot remains deferred.

Stage5: owner selected operator console first, then Ask Atlas. [Routing](stage5/README.md), [review status](stage5/REVIEW_STATUS.md), [working snapshot](stage5/IMPLEMENTATION_STATUS.md). Local read-only console architecture RC3 is dual-approved by explicit Astra/xhigh and native actual Fable5.1/high on the same eight-file package; seal verification/stage5/S5_DESIGN_APPROVED.json. S5-A is ACCEPTED on S5A-rc2 by explicit Astra/xhigh: [acceptance](stage5/reviews/ASTRA_S5A_RC2.md), seal verification/stage5/S5A_APPROVED.json. Native actual Opus5.5/high implemented and repaired it in the same session. Fresh initial review required R1/R2; bounded re-review retained xhigh and closed both. Final257 unit/PGlite+569PG17+31browser and all14checks passed; independent34unit+4HTTP/PG+31browser plus62assertions. Original evidence/failed runs preserved. S5-B is ACCEPTED S5B-rc1 by fresh explicit Astra/xhigh, no required findings: [acceptance](stage5/reviews/ASTRA_S5B_RC1.md), seal verification/stage5/S5B_APPROVED.json. Native actual Opus5.5/high implemented approved brief RC2 in one fresh session. Final all14checks passed (280unit/PGlite,569PG17,50browser); independent57operator units+50browser+80probe scenarios/256assertions,4caught mutations and32byte-equal reproduced assets. Verify accepted identity/closure before dependent work. Ask Atlas separate OFF/MOCK architecture RC3 is dual-approved: [routing](stage5/ask/AGENTS.md), [status](stage5/ask/DESIGN_STATUS.md). Fresh explicit Astra/xhigh and native actual Fable5.1/high independently approved package a9e43a42655ddfea64577d9640fa5778bbf9acf2bd979abdb55e53459a4ab13a; seal verification/stage5/S5ASK_DESIGN_APPROVED.json. ASK-A ACCEPTED S5ASKA-rc3 by fresh explicit Astra/xhigh; native actual Opus5.5/high implemented and repaired in the same session. R1/R2a/R2b/R3/R4 closed; verification/stage5/S5ASKA_APPROVED.json. ASK-B depends on accepted ASK-A. External inference remains a later separate amendment. LIVE/pilot/deployment stays deferred.

## Source basis, checked 2026-10-08

- [Anthropic model selection](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model): capability, effort and cost tradeoffs require task-specific evaluation.
- [Claude Code models and effort](https://code.claude.com/docs/en/model-config): exact model selection, effort levels, fallback and Fable usage-credit behavior.
- [Sonnet 5.5 guidance](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5): medium as a starting point for well-specified agentic work.
- [Pro/Max usage](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan): subscription usage is shared across Claude and Claude Code.
- [OpenAI guidance on instructions](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra): keep instructions concise and load context according to the task.

ASK-A actual-code rc1 CHANGES_REQUIRED by fresh explicit Astra/xhigh (four findings); repair same native Opus5.5/high
session60e70e73-4279-474b-a915-b95e4abfb6d9, then fresh Astra/xhigh. See docs/stage5/reviews/ASTRA_S5ASKA_RC1.md.

Historical rc2 actual-code gate: S5ASKA-rc2 CHANGES_REQUIRED, R1/R3/R4 closed; R2a token-helper SQL and R2b fixture-audit await boundaries remain open.
Same native Opus5.5/high session repair2; fresh Astra/xhigh on rc3. See docs/stage5/reviews/ASTRA_S5ASKA_RC2.md.


ASK-A current acceptance: **ACCEPTED S5ASKA-rc3**; [Astra/xhigh report](stage5/reviews/ASTRA_S5ASKA_RC3.md).
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

ASK-B current acceptance: **ACCEPTED S5ASKB-rc2**; [Astra/xhigh report](stage5/reviews/ASTRA_S5ASKB_RC2.md).
Package ea8620f374420c7fef3c6261ef3a37d9417add2a0bd3d664eef907a6875d41ad; native actual Opus5.5/high session de9faf68-215d-4742-8d88-503f198c1f3e, related repairs in the SAME session.
All 14 checks passed: 358 unit/PGlite, 616 PG17, 73 browser. Required R1/R2/R3 closed; read-only browser OFF/MOCK only.
Seal verification/stage5/S5ASKB_APPROVED.json; exact closure verification/stage5/S5ASKB_CLOSURE_VERIFICATION.json.
ASK-A backend/dependencies and six Ask/eight console norms preserved. ASK-REMOTE NOT_STARTED; external provider/data/billing amendment and LIVE/deployment remain separate gates.

Current ASK-REMOTE gate: DESIGN RC2 DUAL_APPROVED by fresh Astra/xhigh and native actual Fable5.1/high on the same package.
Routing docs/stage5/ask/remote/AGENTS.md and DESIGN_STATUS.md. Current candidate GPT-6 Luna; question-only intent, local evidence/compiler.
Engineering architecture accepted; R-A accepted; R-B/R-C implementation NOT_STARTED. No data/budget admission, paid inference, real customer use or deployment. ASK-B S5ASKB-rc2 remains accepted.

Architecture package 9c92327f6a3d693031c30cc907091f6dd61f4e0747491e10f00a784f877719d3; seal verification/stage5/S5ASKREMOTE_DESIGN_APPROVED.json.
Independent reports: [Astra/xhigh](stage5/reviews/ASTRA_S5ASKREMOTE_DESIGN_RC2.md), [Fable5.1/high](stage5/reviews/FABLE_S5ASKREMOTE_DESIGN_RC2.md). R-A execution/acceptance is recorded below; R-EVAL requires separate owner admission.

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
