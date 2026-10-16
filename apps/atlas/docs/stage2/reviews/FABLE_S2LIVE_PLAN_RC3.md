# Native Fable 5.1 / high — S2-LIVE plan RC3

2026-10-08. Fresh native Anthropic firstParty/claude.ai subscription review; actual response model only
`claude-fable-5-1`. Exit0,622.4s,56turns,no permission denials; runtime usage events allowed, no overage.
Codex saved the returned read-only report. No DB/network/live calls or writes.

## Verdict: REQUEST_CHANGES (conditional plan approval withheld on one obligatory finding)

**Reviewed identity.** Plan manifest `verification/stage2/S2LIVE_PLAN_RC3_MANIFEST.json`, version `S2LIVE-plan-rc3`, declared package hash `be476624…3195`, four entries. Main artifact `docs/stage2/reviews/S2LIVE_OPERATIONAL_BRIEF_RC3.md`, declared SHA `203fd3d6…0f3f`. Pins: S2-C-rc2 (declared 307 files, `e43cc185…e3c0`), normative RC5 (11 paths, `1d3b1064…1efb`), preflight RC1. I read declared metadata only. I did not compute any hash and I ran no commands, tests, DB or network access. Byte verification rests on Codex and Astra as stated in the brief.

**Scope of this verdict.** Conditional operational-plan review only. It is not LIVE acceptance and does not accept any L-gate. Model: claude-fable-5-1, effort high, fresh context, no other reviewer verdict read.

### Obligatory finding

**F1 (P2, admission/feasibility): the brief requires an operator with `m365:read`, but names no admitted path that can provision such an actor on any pilot database.**

- The only code that creates a workspace, client, actor, membership or API token is the synthetic seed at `prisma/seed.ts:27-58`. There is no admin API, CLI command or service for this. RUNBOOK §1 and root AGENTS.md state that migrations and the synthetic seed are the only owner operations.
- The seeded operator in `fixtures/gasta.ts:13` holds `context:read, connections:manage, events:ingest, mapping:review, observations:triage` and no `m365:read`. No fixture or seed file mentions `m365:read` at all.
- The brief's DB setup sentence lists migrations, roles/GRANT and confinement checks and stops. Under that sequence the pilot run fails at `OPERATOR_TOKEN_INVALID` before L1. If the seed is used instead, L2 step 6 (`m365-directory`, `correlation` reads need `context:read` + `m365:read`) and every L3 confirmation (`mapping:review` + `m365:read` on one membership, `packages/graph/m365-mapping.ts:13`) are refused by the accepted services. The brief forbids direct SQL for L3 and never admits it elsewhere.
- Side effect if the seed is the bootstrap: the pilot client becomes `demo-gasta` with synthetic entities, two FIXTURE connections and two CONFIRMED links with `method: 'FIXTURE'`. The brief's "no inference from row presence" rule covers this only implicitly.

Required change: state the admitted provisioning path for the pilot operator, its memberships and the `m365:read` grant (owner-side setup step recorded in the private run record and in public evidence as grant names, or a separately reviewed provisioning command). State explicitly that seed-created clients, entities, FIXTURE connections and FIXTURE-method links are excluded from L3 admission and from any live claim. Until this is written, L2 step 6 and all L3 confirmation steps are infeasible as specified, not merely blocked by external inputs.

### Non-blocking clarifications, recommended in the same revision

- **Import-closure criterion is unsatisfiable as worded.** `packages/ops/commands.ts:12-15` statically imports `OpenAIDecisionProvider` and `callProvider`, and `decisionsSmoke` defaults to global `fetch`. "Closure contains no alternate networking/provider path" cannot be literally true. Restate as "no invocable path": allowlist refusal before `runOperatorCommand`, fail-closed `config()`/`runtime()`, and the global fetch guard. The brief's own sentence that imports are not dispatches already points there.
- **Refused redirect has no HTTP status to record.** With `redirect: 'error'` native fetch throws before any status is visible. Stage 1 `getJson` maps that throw to `UPSTREAM_UNAVAILABLE` (TRANSIENT) at `connectors/http.ts:49`. The failure stays visible, as the brief requires, but the "response HTTP status" metadata field will be absent and the Stage 1 code is not redirect-specific. Define a safe thrown-dispatch outcome class for the recorder.
- **Binding command is unnamed.** The accepted path is `bind --system microsoft365 --tenant <GUID> --secret-ref env://NAME`. `BINDABLE_SYSTEMS` includes microsoft365 and the GUID is enforced at `packages/connections/connections.ts:22,115`. The header of `scripts/ops.ts` still documents `atera|huntress` only. The brief should name the command and say it runs through accepted `scripts/ops.ts` in the private session, outside the recorded driver, since it makes zero upstream dispatch and argv capture would otherwise expose the tenant.

### Checks performed that support the rest of the brief

- Transports are injectable without core edits. `OperatorContext.io.transport` and `M365Io { graph, tokens, secrets }` accept wrapped functions. All Stage 1 vendor calls go through `getJson(deps.transport, …)`, all Graph calls through `graphGet(this.#io.graph, …)`, token POSTs through the injected `AuthTransport`. Production transports call global `fetch` at call time, so a fail-closed global guard catches any accidental use of them.
- Stage 1 `fetchTransport` passes no `redirect` option, so it follows redirects by default. The brief's claim is correct. Graph and auth already use `redirect: 'error'` and fixed origins.
- L3 blocking claims hold. `proposeLink` exists only in `packages/graph/mapping.ts`, not in any CLI, API or tool file. The hostname matcher refuses non-agent resources at `mapping.ts:150`. Directory publication writes ExternalEntity mirrors by raw SQL and creates no links. Observations are created only in `packages/events/worker.ts:162`. Canonical Entity/Device/Person rows are created only by the seed.
- Limits match `connectors/microsoft365/contract.ts:44-64`: directory 40 pages, 20,000 rows, 500 per page, 5 MB, 15 s, 10 min, 8 attempts; sign-ins 20 pages and 10,000 rows per leaf, 100,000 per root, 250,000 and 25 roots per request, 5 attempts, 5-minute lag, 7-day retention, 24h max request.
- Permission sets match `packages/ops/m365.ts:37-38` and `m365-mapping.ts:13`. Safe codes `CONNECTION_ALREADY_ACTIVE` before I/O, `M365_RETRY_NOT_DUE`, `M365_SIGNINS_NOT_AVAILABLE` on 403 and `RLS_NOT_ENABLED` exist where the brief says. The cursor key minimum of 32 UTF-8 bytes is enforced in `packages/correlation/cursor.ts:32`.
- Preflight is internally consistent: the 10 missing tables are exactly the 10 models in `prisma/m365.prisma`.
- Declared manifest metadata is consistent: S2-C manifest has 310 `path` keys, which is 307 payload files plus three nested approved-plan paths. RC5 manifest lists 11 paths. 05_ACCEPTANCE L1–L4 rows match the brief's gates.

Fixing F1 changes the artifact hash, so both reviewers must approve the replacement per the workflow. The L1/L2 partial path, the recorded-driver design and the L3 BLOCKED_EXTERNAL position are otherwise sound and feasible against the current code.
