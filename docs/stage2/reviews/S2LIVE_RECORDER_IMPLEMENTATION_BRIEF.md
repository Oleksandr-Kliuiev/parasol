# S2-LIVE recorder implementation handoff

This is a bounded implementation task inside the operational plan, not authorization to run the live pilot.
Codex hands checkout write ownership to ONE fresh native Claude Code Opus 5.5 (`claude-opus-5-5`) / high session only after
both required reviewers approve the exact current S2LIVE-plan-rc5. Keep that single session for related fixes. Codex and
reviewers remain read only until the writer exits or is confirmed stopped.

## Identity and smallest context

Root `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`, HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`,
branch `planning/stage2-m365`; preserve all dirty work. Accepted baseline: S2-C-rc2 307 files,
`e43cc1858e7271577714e2b46e5c8d10956dd4e625cad779964a3a3ac6cbe3c0`; normative11
`1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`. Verify hashes before editing.
Operational brief `docs/stage2/reviews/S2LIVE_OPERATIONAL_BRIEF_RC5.md`,
SHA `494c614b795101d68bcfeef16936c8f45313a15ed042c01f82d1c3b17a79a2f5`;
plan package `7cfdc792c9702f6d283f2e8452823cd2c38d95d8eb1aeab4241b8a4c3ac5f2e3`.
Read root AGENTS, context map, delivery workflow, this brief and RC5. No historical collections.
Entry files: `packages/ops/commands.ts`, `packages/ops/m365.ts`, `packages/ops/live-read.ts`,
`packages/m365/io.ts`, `connectors/http.ts`, `connectors/microsoft365/{http,auth,contract}.ts`,
Atera/Huntress connector and contract path definitions, `packages/auth/prisma-auth.ts` and token helper.
Read only the relevant DTO/command result shapes for safe projections; do not load unrelated provider behavior.

## Outcome and allowed writes

Build a small standalone pilot entry point which invokes the accepted commands with authenticated current authority and
real production fetch behind a fail-closed metadata recorder. Every vendor/Graph/token dispatch is classified and recorded
without payloads. No current live credentials/target are available, so all verification is synthetic/local/disposable.
The finished driver must be accepted by fresh Astra xhigh before any future live dispatch.

Allowed paths: new `scripts/stage2-live-pilot.ts`, focused new `packages/ops/pilot/` modules and nested AGENTS;
new `tests/pilot-*.test.ts`, focused `tests/support/pilot-*` support, new `tests/pg/pilot-*.pg.test.ts` if meaningful;
new `docs/stage2/reviews/S2LIVE_RECORDER_RC1_IMPLEMENTER.md` and `verification/stage2/S2LIVE_RECORDER_*` evidence;
small routing addition in `docs/AI_CONTEXT_MAP.md` pointing to the driver, modules and operational brief.
Do not modify accepted core runtime/services, schemas/migrations, existing tests, package/dependency versions/lockfiles,
`.env`, frozen normative files, prior acceptance or status reports. Files near500, hard700; thin orchestration.
No operator bootstrap/provisioning helper in this task: target/setup choice and explicit owner grant instruction are pending.
No new onboarding/proposal/Observation creation. L3 remains blocked. No live, persistent DB, account, vendor writes,
credentials inspection, deployment, schedules, commits/PRs, worker/provider calls or fallback billing.

## Driver contract

Use an explicit private local configuration file containing the command/flags, approved pilot client/connection scope and
metadata output destination; secrets come only from already configured environment references. Document an example with
placeholders and a direct node invocation. Do not put tenant/application identifiers, token values or private file paths
in public output. The config names scope but never supplies the Actor or mints permissions: actual authentication comes
from the confined runtime DB/token, fresh before each admitted operation.

Allow only m365-probe, m365-sync, m365-status, m365-directory, correlation, live-read, mapping and confirm-link as needed
by RC5. Refuse all other commands BEFORE runOperatorCommand or any networking; bind stays the separate private accepted
CLI path. No implicit continuation/retry/reset/requeue/disable/rebind or worker pass. Reuse parseInvocation and services;
retain their exact interval/cursor/authority/tenant/budget/status semantics. A sync pass may return RETRY/partial despite
CLI-level ok; the driver must not turn ok into L1-L4/PASS. It reports factual operation outcomes only.

Check malformed config/unsupported commands and injected NODE_OPTIONS/external --import/--require/loader preloads before
DB or upstream I/O. Use production Graph/authority origins; no configurable origin, fixture resolver or mocked live mode.
The stock demo namespace/FIXTURE connections and FIXTURE-method links are not admitted live sources; follow RC5's genuine
namespace prerequisite and fail closed if the selected scope has known fixture provenance. External approval/provenance
remains an owner prerequisite, not inferred from row existence or a config flag. Never run current `.env` against app data:
its runtime admission already failed with 10 M365 tables missing; inspect no current credentials/source rows.

Open runtime DB using accepted factory, assertRuntimeRole BEFORE authentication/application reads, authenticate current
operator and require the correct same-client membership. Compose runOperatorCommand with recorded Stage1 HttpTransport,
recorded GraphTransport and recorded AuthTransport in ClientCredentialsTokenProvider; real EnvSecretResolver, accepted
cursor key. Supply config/runtime callbacks which always refuse. The imported dormant provider definitions are allowed;
provider instantiation/invocation and invocable command paths to them are prohibited.

Capture native fetch privately before installing a fail-closed global fetch guard. Only internal admitted recorder wrappers
call the captured function; do not export it. Any unwrapped global fetch attempt marks the run incomplete and refuses I/O.
Restore globals/close resources in finally; an attempted bypass never becomes a successful report. Inspect the invocation
closure so no other HTTP/provider path is callable. No SDKs/dependencies added.

Classify each requested destination/method in memory BEFORE dispatch, matching fixed accepted origins/path classes. Reject
userinfo, nonstandard port, fragment, unknown endpoint/method and any unsupported target. Preserve accepted Graph URL and
nextLink/tenant checks. For Stage1, use native fetch with accepted GET init plus explicit redirect:error; never delegate to
the automatically-following production Stage1 fetchTransport. Graph/auth retain redirect:error. All vendor/Graph resources
GET; token authority POST only. Class names are fixed safe vocabulary, not strings extracted from upstream paths/queries.

Before every dispatch persist/fsync an explicit allowlisted receipt (sequence, endpoint class, GET/POST, start time).
Failure to record means ZERO dispatch. Record completion with observable HTTP status (null for thrown fetch), duration and
fixed safe outcome; no raw exceptions/cause/URL/headers/Location/body/nextLink. Preserve Response bodies for accepted services,
never consume them to count items. Completion sink failure makes the whole run incomplete/FAILED and prevents further calls.
Reject existing output-file collisions rather than overwrite reports. Keep public receipt shape immutable/allowlisted;
item/page counts come from accepted service output/status, dispatch counts from recorder. Do not infer license cause from403.

Public operation summary uses a focused allowlist: safe statuses/codes/counts/time bounds and opaque aliases for local IDs,
relation/proof labels/presence. No raw DTOs, names/UPNs/vendor/source IDs/tenant IDs, cursor values, URLs, arbitrary strings,
configuration, raw JSON/stdout/error dumps or content hashes of secret/personal values. Mapping and correlation results
may contain personal data; project in memory. Authorized humans can inspect real data separately through private local
read commands that make no upstream calls; do not log those results in this driver. Resume IDs/cursors, if needed, remain
private operational inputs, not public receipts. Public output never says LIVE PASS or ACCEPTED; human/reviewer gates apply.

## Required meaningful verification

Split recorder, command/admission and privacy tests by behavior, with small reusable support.
Test unknown destination/method refusal before dispatch; failures before/pre/post recording; thrown fetch/timeouts; global
bypass guard; unallowed worker/shadow/decisions commands and config/runtime refusal; preservation of production method,
headers/body/signal and fixed Graph/auth composition; accepted Response body remains untouched; no automatic retry.
Native fetch against local same-origin and cross-origin redirect servers must yield exactly1 source call and0 target calls.
Loopback servers/injected dependencies are synthetic test mechanisms only, not a configurable live origin.

Canary token/tenant/UPN/name/URL/nextLink/error-body values must not appear in any stored receipt, public stdout/error or
summary, including directory/correlation/mapping outputs and thrown failures. Cover completion failure after an actual call
as incomplete, even when the command result otherwise looks successful. Counts/status/proof labels must remain truthful.
Use scoped disposable PG integration where necessary to prove runtime-role refusal/authority and service composition;
subprocess tests should prove preloads/unsupported operations refuse before DB/upstream and emit only safe errors. No test
may use the current persistent DB or real secrets. Evidence explicitly identifies mocks/local servers/disposable DBs.

After focused checks, run the mandatory checkpoint suite in disposable test DBs: schema validate/generate, typecheck,
unit/PGlite, API build/smoke, PostgreSQL suite, PG17 checks, zero schema drift, git diff --check. Capture actual exit codes
and concise safe command receipts/log hashes. Do not fix unrelated baseline code or weaken tests on failure; diagnose and
report. If two ineffective repairs or a critical invariant failure occur, stop for diagnosis/escalation.

Before handing back, save changed paths/stat, implementation decisions, actual focused/full test counts, safe failures and
residual risks in the new implementer report. Keep private raw CLI stream outside repo. State effective model/effort and
write handoff explicitly. Codex rechecks accepted hashes/delta, freezes exact recorder candidate and required evidence;
fresh Astra xhigh accepts that candidate independently. That gate is RECORDER preparation acceptance, not live acceptance.
