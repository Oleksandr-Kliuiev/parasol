# ASK-A — backend implementation brief

Owner authorized this checkpoint on2026-10-10: fresh native `claude-opus-5-5` / high, then fresh independent
`gpt-6-astra` / xhigh. Required repairs remain in the SAME Opus session. Stop before ASK-B or ASK-REMOTE.
This is implementation inside the approved RC3 architecture, not a new architecture amendment.

## Controlling identity and instructions

Six-file contract: `S5ASK-DESIGN-rc3`, package
`a9e43a42655ddfea64577d9640fa5778bbf9acf2bd979abdb55e53459a4ab13a`.
Seal `verification/stage5/S5ASK_DESIGN_APPROVED.json` SHA256
`90b5ad7c598f5b89a193bfd7035efe1539bc13feaf0d9338d7fc7b49425e2c15`;
closure `S5ASK_DESIGN_CLOSURE_VERIFICATION.json` SHA256
`5654883d224a945b2bdb8687b33194ae117e7d65b0238fae240c37c3d9800d5e`.
HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`; heavy accepted dirty work is the baseline.
Use `verification/stage5/S5ASKA_IMPLEMENTATION_BASELINE.json` for exact pre-write hashes, including untracked files,
and `S5ASKA_PREFLIGHT.json` for native provider/billing admission. Do not use a checkout of HEAD alone.

Read root AGENTS, relevant delivery workflow, context map, this area's AGENTS/README, and the six approved norms.
They control all exact DTOs, predicates, limits, ordering and audit outcomes; keep them immutable. Read the eleven
non-blocking Fable RC3 notes narrowly in `../reviews/FABLE_S5ASK_DESIGN_RC3.md`; decisions below preserve current contracts.

## Deliverable and permitted writes

Implement backend OFF/MOCK config, route-local HTTP boundary, private authentication/current scoped authority,
bounded stored-context reader/projection, deterministic planner, compiled cited claims, safe audits and physical-work
budgets. Both fixture and actual confined-PG HTTP paths must work. Default OFF adds no Ask routes or browser behavior.
No external inference, SDK/egress/provider adapter, model calls, action/tool/DecisionRun, M365/finance/vendor/sync access,
new credential/permission, schema/migration/role/ACL/audit-allowlist/dependency/lockfile changes, live activation or deployment.

Permitted source: cohesive `packages/ask/*` with nearest AGENTS; focused API Ask modules/middleware under `apps/api/src/`
and `apps/api/src/db/`; narrow composition in `main.ts`, `atlas.module.ts`, `db/app.module.ts` to wire this concern only.
Use existing fixture demo state/audit and accepted shared primitives; no duplicated unrelated fixture universe.
Permitted tests: new focused `tests/ask-*.test.ts`, `tests/pg/ask-*.pg.test.ts`, small Ask support modules;
narrow relevant existing HTTP/process test support and regression assertions when necessary, preserving accepted behavior.
Permitted docs: context map, relevant RUNBOOK section, new `S5ASKA_IMPLEMENTATION_REPORT.md` here, focused source/test routing.
All operator source/styles/HTML and browser tests remain unchanged. Existing auth/domain/source modules, fixtures,
build scripts/tsconfigs, norms, baseline, old reports/evidence/seals and coordinator status/workflow files stay immutable.
If approved scope cannot be implemented without another shared-source change, report the exact need before editing it.
Keep orchestration thin, active files near500/hard700; no broad barrels or mixed-concern utility modules.

## Critical implementation boundaries

- BOTH routes acquire one synchronous provisional global owner before raw-body/auth awaits; original8s starts at ingress.
  Private bounded digest/ACTIVE-actor authentication, not the unbudgeted shared ApiTokenGuard/authenticateToken call.
  Same owner binds exact workspace/actor after semantic validation; no release/reacquire gap. Capability never charges
  rolling questions. Physical owners survive public timeout/disconnect until underlying planner/DB cleanup is confirmed.
- Parser classification must cover every spelling reaching an Ask controller, independently of scope-ID validity:
  one nonempty client path segment, Express case/trailing aliases and percent variants. No malformed-ID fallback into
  generic parsers. HEAD/OPTIONS cannot reach implicit GET/controller/auth. Accepted Host gate stays ahead of parsing.
  Both bootstrap branches use bodyParser:false; non-Ask express.json()/urlencoded defaults restored without changes.
  Ask private parsed-body property, no @Body()/second parser; raw16KiB/fatalUTF8/type/encoding errors never echo input.
- Reuse currentToken, runtime/RLS/readiness and existing fence semantics. Set workspace hint BEFORE FIRST FOR SHARE lock;
  both fenced phases recheck current token/ACTIVE actor/membership/context:read, exact captured workspace/actor/client.
  Post-audit INSERT expiry/deadline checks roll back before transaction return. No lock across planner, no source snapshot
  claim or retry of unknown commit. Follow the normative terminal-outcome/audit matrix and fixed AskErrorV1.
- Whole ORIGINAL selected-source validation precedes mapper repair/truncation and bank reduction. Preserve all approved
  limits, explicit projections, source-page/focus counts, omissions and independent times. Optional source minimization
  is NOT permission to skip item validation or weaken current whole-read contract. Cap overflow413; malformed source503.
- Server-derived focusRef/focusResourceRef/focusEntityRef only; compiler independently validates exact predicates.
  SUMMARY first8 observations, else first8 resources; other intents use exact eligible ref/null. Matrix/cardinalities,
  unsupported/insufficient and all-status evidence/urgent notices stay exact. No free planner prose rendered or persisted.
- Audits use existing allowlist only; raw question/plan/answer/source display text never in logs, diagnostics or audit.
  Existing business tables, ToolExecution and DecisionRun must not mutate. No claim of forced memory erasure/cancellation.

Non-blocking precision: use the existing response DTO field types, UTC ISO generatedAt, exact nullable focus echo and
supported intent on INSUFFICIENT. RequestId is validated lowercase UUIDv4 echo. Do not add an observationId charset
restriction beyond the approved nonempty≤256 string contract. Mock matches use the approved trimmed case-insensitive
literal phrases/optional final '?' only, no invented NFC/whitespace language understanding. Rate check can reject at actor
binding and recheck at charge; charge ONLY after positive phase1 authority, never refund. Failure codes remain the
approved stage-specific runtime/audit mappings, with no exception details. Do not weaken cleanup guarantees on the
assumption that a timeout wrapper cancelled Prisma: evidence must cover actual transaction/query settlement; document
what driver/pool cleanup is proven and retain capacity while uncertain. Escalate an unenforceable contract.

## Meaningful acceptance evidence

Implement applicable Q1–Q6/Q9 and backend portions of Q8 from04. Q7/new UI belongs to ASK-B; the unchanged50 browser
journeys remain a regression gate here. Backend must provide positive fixture+PG actual HTTP questions/cited answers.
Include multiple same-system connections, exact/missing focus resource eligibility, confirmed entity through another
source tuple, deterministic SUMMARY, LOW focus/HIGH other injection, empty/unsupported plans with independent urgency.

Real disposable-PG17 barriers: blocked private authentication before phase1, >4 mixed GET/POST valid/invalid credentials,
public timeout/disconnect and confirmed drain/recovery; fenced phase waits/revoke/expiry/permission restore/epoch change;
post-audit-wait expiry/deadline rollback; source/audit/commit failures; shared-lock contention. Token rebinding test uses
owner DELETE+INSERT of the same digest (ordinary UPDATE moves are forbidden), including coincident cross-workspace epochs.
Test actor1/global4/entries64/rolling10, four ignored-abort planners retaining owners, exactly-once release/never-settling
bounded work, original deadline never reset, no new phase/read/audit after terminal. Tests must observe underlying work.

HTTP goldens: raw/type/UTF8/chunked/aliases/HEAD/OPTIONS, strict error DTO/headers/noecho, authentication+semantic+scope
precedence, capability and POST explicit200, OFF404, invalid startup mode. Compare existing JSON/urlencoded100kb/strict/
syntax/type behavior in fixture+DB OFF/MOCK, particularly tools/execute201. No generic parser on Ask, no double read.
Privacy markers in question/excluded fields/exception must stay out of new persistence/logs/diagnostics; verify tables.
Restored-byte negative controls must catch missing owner/authority/fence/scope/ref/claim/urgency guards; preserve failures.

Focused checks during edits; final14 checks once ready: npm test (including context budget), schema:validate, db:generate,
typecheck, ui:typecheck, ui:build, api:build, api:smoke, test:pg, db:check:pg17, db:check:drift, test:ui, git diff --check,
untracked-text whitespace. Use silent `/tmp/atlas-stage3/claude-tools/pgenv.sh` for disposable PG commands; never read/print
that wrapper or environment values/URLs/credentials. Keep full logs in new `/tmp/atlas-stage5/s5aska-*` paths; concise outcomes.
Also fresh production copy→npm ci→generate/build→prune dev→serve from foreign cwd: default OFF, enabled MOCK capability/
question, no hidden dependency, unchanged32 operator assets/Host/CSP and existing Gateway201. No new UI visuals needed.

No real data/credentials, network vendor/model calls, trace/HAR/video or failure screenshots. Pinned installed tools only.
Preserve earlier logs; do not overwrite previous evidence. After two ineffective repairs diagnose/escalate; immediately
report an isolation/authorization breach or architecture contradiction rather than relaxing a check.

Write a concise report: exact changed paths, behavior, checks/counts/commands, failed runs and repairs, barriers/negative
controls, packaging, baseline preservation and residual risks. Code acceptance remains PENDING Astra; never self-accept.
Stop after ASK-A only; no commits, PR/deployment or dependent work. Return sole checkout write ownership on exit.
