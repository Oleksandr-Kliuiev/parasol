# S4-C implementation brief

Authorized continuation 2026-10-10. Native Claude Code **claude-opus-5-5/high**, fresh cohesive session;
Codex coordinates/integrates, fresh explicit GPT-6 Astra/xhigh accepts actual code and evidence. Stop at S4-C.
This implements the unchanged dual-approved Stage4 architecture, not a new architecture. LIVE remains DEFERRED_BY_OWNER.

## Exact baseline and ownership

S4B-rc2 ACCEPTED package 309b6aff8b430f1b28887331db25e4886328ba6faa7afe1d781942772d12dd14;
manifest verification/stage4/S4B_RC2_MANIFEST.json SHA 303212b7d28d9d4c1d712101b85e81fe61b37dc7a059b481b4725540811eb924.
Seal verification/stage4/S4B_APPROVED.json; exact HEAD/branch/dirty inventory and seal hashes in S4C_BASELINE.json.
Codex verified the accepted full inventory plus declared status deltas and inspected two additional administrative deltas:
owner-approved orchestrator context practices in docs/DEVELOPMENT_WORKFLOW.md and one AI_CONTEXT_MAP routing row.
Architecture eight-file package d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec stays byte-exact.
Preflight S4C_PREFLIGHT.json verifies firstParty/claude.ai Max, extra usage disabled, no inherited provider overrides.
Codex transfers SOLE checkout write ownership at launch; returns only on process exit/confirmed stop. No other writers.
Use one implementation session for this cohesive checkpoint and related repairs; no subagents.

## Scope, entry files and allowed changes

Implement C1-C4 and relevant R1/R2: dedicated status/summary reads, actual HTTP private bearer dispatch, strict operator
CLI poweroffice-status/summary/sync/recover/cleanup, fresh maintenance admission plus paired confined runner and original
whole-transaction 10-second wrapper, full privacy/expiry/concurrency/error journeys. No Gateway financial tools.
Start with root AGENTS.md, docs/AI_CONTEXT_MAP.md, packages/poweroffice/AGENTS.md, docs/stage4/01_SPEC.md,
02_CONTRACTS.md, 03_DATA_AND_CONCURRENCY.md (read locks, roles/maintenance), 04_PORT_AND_SYNC.md (read precedence),
06_ACCEPTANCE.md, and IMPLEMENTATION_HANDOFF.md. Read adjacent dependencies narrowly, not historical directories.
Key existing modules: poweroffice authority/binding/locks/rows/composition/sync/recovery/contracts/audit;
apps/api/src/db/app.module.ts, clients.ts, auth.ts; scripts/ops.ts and packages/ops/actions.ts (private branch pattern);
packages/m365/maintenance.ts (paired runtime URL identity), packages/graph/poweroffice-role.ts (accepted readiness);
tests/support/poweroffice-fixtures.ts and sync.ts; tests/pg/AGENTS.md (test routing); prisma cleanup routine.
Create focused modules/tests/support. Allowed: packages/poweroffice/**, packages/ops/poweroffice*.ts,
apps/api/src/db/poweroffice*.ts and minimal app wiring, scripts/ops.ts minimal dedicated dispatch,
new tests/poweroffice-*.test.ts and tests/pg/poweroffice-*.pg.test.ts, small tests/support/poweroffice-*.ts,
.env.example, docs/RUNBOOK.md, relevant context-map/local AGENTS routing, S4C implementation report only.
Existing accepted helpers may be narrowly extended if essential, explicitly report deltas and regressions. No shared
contracts, ApiToken policy, legacy dispatch/ledger/name grammar, installed migrations/roles or role checks relaxation.
If architecture/schema changes prove necessary, stop that change and report the contradiction for renewed dual review.
Preserve all accepted norms, history, seals, archives, fixture files and existing unrelated dirty work. Files near500/hard700.

## Binding contracts and acceptance

- Status/summary use private bearer capability, explicit client/connection, context:read + poweroffice:read on ONE current
  membership. Fence FOR SHARE -> plain scoped Connection -> State FOR SHARE -> plain Attempt/Snapshot. No State init.
  Recheck token/expiry/ACTIVE actor/permissions and DB clock AFTER ALL locks. Scope denial exactly one workspace audit;
  no earlier client writes/ledger. Fresh auth and atomically successful client read audit before any data return.
  Audit failure fixed safe code, NO financial payload. No broad error.details/causes/raw SQL or credential logging.
- Implement first-match precedence in04 exactly: unavailable/binding/lifecycle mismatch -> UNAVAILABLE/null;
  prior success missing or expired -> EXPIRED/null regardless of later failure/ACTIVE;
  never success+FAILED/ABANDONED -> ERROR/null even ACTIVE; never success/no completion -> MISSING/null;
  unexpired snapshot+FAILED/ABANDONED -> STALE/retained warning even ACTIVE; age>15m -> STALE/SNAPSHOT_STALE;
  age<=15m -> FRESH. Current DB time, >= expiry hides summary before cleanup. Complete empty known-zero remains distinct.
  Preserve lastCompleted across ACTIVE; successful publication clears failure, ABANDONED persists until next success.
  No financial read before valid binding; coherent old/new snapshot under concurrent publication; no source on reads.
- Strict summary DTO exact02 fields, no private IDs/binding/token/ref/nonce/cursor/raw text; status omits summary/amounts
  (local attempt/sequence/timestamps permitted). Runtime whitelist/validation for input and output; all envelopes synthetic:true.
  Error codes full spelling, no private diagnostic field. Audit metadata SIX exact keys only; outcome operational enum,
  sequence local ordinal; no financial/deletion counts, source dates/IDs/hashes. Shared sanitize allowlists never widen it.
- HTTP GET /clients/:clientId/poweroffice/:connectionId/status|summary uses route-specific private bearer dispatch.
  Missing/malformed/expired bearer401 synthetic:true, scope/permission403, invisible/unknown/non-PO404 synthetic:true,
  busy/conflict409, mode/readiness503 synthetic error. Binding/lifecycle read failure HTTP503 with strict UNAVAILABLE
  read DTO/null summary; other authorized precedence rows200. Every path Cache-Control:no-store. Real HTTP every row.
  Do not enter legacy Actor-only Gateway/readers or ToolExecution ledger. Service solely owns auth/audits.
  Actual /tools/execute and discovery have NO PowerOffice tool; preserve all grammar/policy/legacy ledger behavior.
- CLI strict allowlists, required --client/--connection; token from ATLAS_OPERATOR_TOKEN protected env NEVER argv.
  No source/file/url/tenant/currency/clock/raw/body callback options. Dedicated dispatch before legacy Actor authentication.
  Sync/recover use accepted current sync authority; no activation/binding/new source. Exit0 successful operations/reads,
  1 operation failure,2 usage/config. Every output/error synthetic:true, safe fixed codes; no URLs/password/raw exception.
- Cleanup first fresh maintain admission (context:read+poweroffice:read+poweroffice:maintain) under runtime fence.
  Private admitted capability only; caller cannot forge DB/scope/actor. Same immutable synthetic binding permits DISABLED
  or lifecycle drift; no reactivation. Admitted cleanup may finish after later revocation by accepted contract.
  Pair runtime Prisma and its actual URL privately; separate runner URL env reference, full same-target comparison
  including protocol/host/effective port/path/ALL query options, use runtime target with runner credentials only.
  Verify actual confined execute-only runner and DB pairing WITHOUT logging URLs. No runtime/definer/auth authority
  added. Runner GUCs singleton workspace/client/actor/connection before routine; accepted function scope/binding checks.
- One original monotonic 10s WHOLE RUNNER TRANSACTION budget includes pool acquisition, begin/setup/readiness/lock/function/
  pre-COMMIT waits; lock_timeout1000ms, statement_timeout<=remaining original deadline. Never reset window/timer after await.
  No work or commit after cancellation; rollback every effect on timeout; fixed CLEANUP_TIMEOUT, other CLEANUP_FAILED,
  conflict mapping per approved contracts. No retry/loop. Cleanup refuses any ACTIVE even expired; recover first.
  Missing State no-op, sequence neverreset. SQL purge expired snapshots with pointer clear + safe audit atomic, preserve
  lastSuccessAt and lastCompleted; then old>30day unreferenced terminal attempts, combined1000/maxmorePending.
  No financial output/audit counts. Actual DB audit failure, pool/lock>1s and original10s rollback/cancellation evidence.
- Carry IMPLEMENTATION_HANDOFF applicable obligations1-8: restrictive definer same-client connection isolation;
  purged state pointer implication with retained lastSuccessAt (publish->purge->EXPIRED and SUCCEEDED completion);
  deferred invoker commit guards preserved; FK/deadlock residual with real Connection UPDATE against cleanup, both
  Stage4 transaction and Connection mutator victim and zero partial effects;503 binding mapping; no seed CLI (trusted
  fixtures ONLY); audit outcome distinction; replay contract unchanged. Tests may reuse accepted coverage explicitly.
- Actual CLI journey seed synthetic(test only)->sync->summary->failureSTALE->recovery->expiry/purge; actual API and legacy
  Gateway exclusion. Capture audit/log/stdout/stderr/telemetry/Decisions privacy, zero vendor HTTP calls/network trap
  with safe local positive self-control. No forbidden external IDs/names/credentials or financial payload in audits.
  Healthy/corrupt fence regressions, accepted Stage1/2/3 paths, unknown/wrongclient/non-PO/noexistence probe, split rights,
  inactive/revoked/last-lock expired token, empty/foreign GUCs and paired runner misconfiguration all fail closed.
- Tests actual PG17 for locks/deadlines/rollback; no synthetic throw alone as timing proof, no caller DB clock override.
  Pure fixtures may arrange historical rows using trusted existing fixture patterns, no runtime bypass.
  Document cleanup fence may block reads/actions/auth up to10s, read audit write per success,1000attempt retention cap.

## Checks, billing, evidence, stop

Disposable PG17 DBs/unique roles ONLY via silent /tmp/atlas-stage3/claude-tools/pgenv.sh. Do not read wrapper/.env/private
pilot/config credentials or print URLs/tokens. Shared/global/builtin ACL tamper uncommitted with guaranteed rollback and
independent observer; DB-local synthetic fixtures may commit with finally cleanup. No persistent/account/vendor work.
Native subscription normal speed only; no API keys/provider overrides/credits/fast/fallback. Check actual response model.
Preserve failed checks/negative controls. After two ineffective repairs diagnose/re-plan; critical invariant breach escalates.
Run focused tests then ALL11 required checks using /tmp/atlas-stage4/s4c-tools/checks.sh rc1-final;
logs /tmp/atlas-stage4/s4c-checks/rc1-final. Required npm test, schema:validate, db:generate, typecheck, api:build,
api:smoke, test:pg, db:check:pg17, db:check:drift, git diff --check and untracked-whitespace. Do not replace requirements.
Write docs/stage4/S4C_IMPLEMENTATION_REPORT.md: bounded changed files/behavior, checks/counts/logs, failed runs/repairs,
C1-C4 cases and qualifications, residual risks, explicit PENDING independent acceptance and LIVE DEFERRED_BY_OWNER.
Do not edit IMPLEMENTATION_STATUS/REVIEW_STATUS/seals or self-accept. Codex freezes manifest/evidence after exit.
Return concise report with paths and command counts, session/provider identity separately captured by launcher.
