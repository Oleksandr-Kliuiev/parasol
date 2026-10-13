# ASK-A implementation report — Ask Atlas OFF/MOCK backend

Code acceptance: **PENDING** fresh explicit `gpt-6-astra` / xhigh. Not self-accepted. No commit, PR, deployment or ASK-B work.

## Identity

| Item | Value |
|---|---|
| Implementer | native Claude Code, `claude-opus-5-5`, effort high as launched by the coordinator (preflight `verification/stage5/S5ASKA_PREFLIGHT.json`) |
| HEAD / branch | `916a4d69853ff6da636e8609a2e0bd33aa787f66` / `planning/stage2-m365` (dirty accepted baseline) |
| Brief | `docs/stage5/ask/S5ASKA_IMPLEMENTATION_BRIEF.md` `150ce9ba…7872` (verified before writing) |
| Baseline | `verification/stage5/S5ASKA_IMPLEMENTATION_BASELINE.json` `b474dbfc…aa94`: 1065/1065 files, 197/197 built verified before writing |
| Design | RC3 package `a9e43a42…ab13a`; seal `90b5ad7c…2c15`; closure `5654883d…5d5e` (hashes verified) |

## Changed paths

Modified (permitted composition/docs only): `apps/api/src/main.ts` (both branches `bodyParser:false`, `ATLAS_ASK_MODE`
parse before startup, `installApiParsers` after the Host gate, one fixed MOCK startup line), `apps/api/src/atlas.module.ts`
(`AtlasFixtureModule.withAsk`), `apps/api/src/db/app.module.ts` (`forDatabase(db, ask, planner?)`), `docs/AI_CONTEXT_MAP.md`,
`docs/RUNBOOK.md` (§12), `tests/pg/AGENTS.md` (routing line). Every other baseline file is byte-identical.

New: `packages/ask/{AGENTS.md,contracts,config,input,budget,credential,service,authority,read,source,fixture,projection,planner,
compiler,audit}.ts`; `apps/api/src/{ask-http,ask-fixture}.ts`, `apps/api/src/db/ask.ts`;
`tests/ask-{input,budget,compiler,service,parsers,settlement}.test.ts`, `tests/pg/ask-{http,source,authority,budget}.pg.test.ts`,
`tests/support/ask-{pg,source}.ts`; this report. Largest active file 309 lines (`tests/pg/ask-authority.pg.test.ts`).
No schema/migration/role/grant/audit-allowlist/dependency/lockfile/provider/registry/operator/browser change.

## Behavior

- OFF (unset/`off`) composes no Ask controller, ingress or classification; generic parsers apply to every request as before.
  Any other value refuses startup with a fixed message. MOCK adds exactly GET `/ask/capabilities`, POST `/clients/:id/ask`.
- Ingress (`ask-http.ts`): HEAD/OPTIONS on an Ask path → synchronous ordinary 404. Intercepted shapes reserve one global
  owner synchronously (429 before any body/auth work), start the original 8 s monotonic deadline and a public deadline
  timer, reject query/undecodable path/type/charset/encoding/declared or counted (chunked) >16 KiB, decode UTF-8 fatally,
  parse once into a private symbol property; never `@Body()`. Classification is a proven superset of Express routing
  (case, trailing slash, percent variants, absolute-form). Nest's unchanged `express.json()`/`urlencoded({extended:true})`
  (from `@nestjs/platform-express`'s express) run only for non-intercepted requests. Every Ask reply: JSON, `no-store`,
  `X-Atlas-Correlation-Id`; errors exactly `AskErrorV1`, no echo; 401 included (no shared guard on Ask).
- Flow (`service.ts`): private authentication 401 → exact body 400 → bind the same owner to `(workspaceId, actorId)` (rate
  check) 429 → phase1 → projection → planner (≤2 s, abort ignored-safe, held) → whole-plan validation/compile/pre-serialization
  (≤256 KiB) → phase2 → publish. Deadline/terminal checked before and after every step; terminal runs start nothing new.
- DB port (`authority.ts`): every phase one transaction with pool `maxWait ≤ min(500 ms, remaining)`, transaction timeout and
  transaction-local `statement_timeout ≤ min(2 s, remaining)`; the owner holds both the transaction promise and its callback.
  Private auth: cleared settings, digest-only `currentToken`, ACTIVE actor status only. Phases: cleared settings → hint →
  `app.workspace_id` → `ActionAuthorityFence FOR SHARE` (first lock) → readiness → after lock DB-clock token with the SAME
  captured workspace+actor → ACTIVE actor → one membership with `context:read` → else one `ask.scope_denied` with post-INSERT
  expiry/deadline checks. Phase1 charges the rolling admission only here, then reads. Phase2 compares the epoch as exact DB
  text within the captured workspace (409, no audit), writes `ask.completed`/`ask.failed`, re-checks DB-clock expiry and the
  original deadline after the INSERT before returning (rollback). Fixed failure mapping, no exception details.
- Source (`read.ts`, `source.ts`): explicit SQL projections in the admitted transaction; active page 101 sentinel; focus as one
  exact scoped row (all statuses; NUL/lone-surrogate IDs never queried); graph/links/connections cap+1; snapshot arrays sized in
  SQL before materialization; every original row/item validated before projection (no mapper repair); caps 413, malformed 503.
- Bank/planner/compiler: as 02 — E-refs, server-only focus refs, enum-only descriptors, exact phrases, SUMMARY first 8, exact
  matrix with predicates re-checked on fact data, independent `urgentRefs`, evidence/coverage for every status.
- Fixture port: accepted equality token and demo memberships (synthetic authority), demo context validated whole, memory audits.

## Checks (final run, logs `/tmp/atlas-stage5/s5aska-impl/checks/`)

| # | Command | Result |
|---|---|---|
| 1 | `npm test` (incl. context budget) | pass 313/313 |
| 2–8 | `schema:validate`, `db:generate`, `typecheck`, `ui:typecheck`, `ui:build`, `api:build`, `api:smoke` | all exit 0; 32 operator assets, manifest `d8329d97…` |
| 9 | `pgenv.sh npm run test:pg` (PG17) | pass 602/602 (153 s) |
| 10–11 | `pgenv.sh npm run db:check:pg17`, `db:check:drift` | pass |
| 12 | `pgenv.sh npm run test:ui` | 50 passed (unchanged browser suite) |
| 13–14 | `git diff --check`; untracked-text trailing-whitespace scan | clean |

New Ask tests: unit 33 (`ask-input` 6, `ask-budget` 8, `ask-compiler` 8, `ask-service` 7, `ask-parsers` 2, `ask-settlement` 2);
PG 33 (`ask-http` 8 actual processes fixture+DB OFF/MOCK, `ask-source` 9, `ask-authority` 10, `ask-budget` 6).

## Meaningful PG17 barriers (confined runtime role, real transactions)

Credential/scope matrix with exactly one workspace denial and table checks; phase1 waiting on an owner-held fence FOR UPDATE
while revoke/expire/permission loss commits; planner-wait revoke/expire (401), permission loss (403 + 1 denial), loss+restore
(409, no audit); token DELETE+INSERT of the same digest to another actor and to another workspace whose epoch was driven to
coincide (401, no audit), ordinary UPDATE move refused AT002; post-INSERT expiry while the final audit INSERT waits on an
owner-held FK lock (401, rolled back) and original-deadline crossing there (504, rolled back); denial-INSERT expiry (401, no
denial); refused audit INSERT and deferred commit-time failure (503 ASK_AUDIT_FAILED, no row, recovery); two phase1 readers
holding FOR SHARE together while an authority UPDATE and a runtime Stage 3 FOR UPDATE queue (only RowShare on the fence and
its pkey above AccessShare, no advisory lock); missing Client row via superuser replica mode (404). HTTP/budget: `LOCK TABLE
ApiToken` with 4 mixed GET/POST valid/invalid owners blocked in private authentication and further GET/POST 429 at ingress;
two client disconnects keep their owners until the transactions settle, then exactly 4 releases, no phase1/audit; four
ignored-abort planners: 504 + `ask.failed` at ~2 s, capacity held until the gate opens, 6 exact releases, recovery; never-settling
planner keeps its slot; slow body consumes the original budget (504 at ~8 s, no final transaction); rolling 10/60 s timing.

## Negative controls (restored bytes, script `/tmp/atlas-stage5/s5aska-impl/negative/controls.py`)

Caught (suite failed, bytes restored and SHA-256-verified, dist rebuilt): global cap, planner hold, transaction-settlement hold
(by `ask-settlement`), actor binding, fence FOR SHARE, workspace hint before fence, re-authentication after lock, captured
identity (both comparisons), phase2 epoch, scope membership, post-INSERT expiry/deadline, rolling charge, WHY_URGENT focus
predicate, plan ref membership, focus resource tuple, entity confirmed-kind, urgency notice, source summary repair, generic
parser exclusion (via parser seam), HEAD/OPTIONS rejection. Preserved failures and repairs:
- `owner-tx-settlement-hold` was NOT caught by `ask-budget.pg` (the flow's own hold covers the real-PG case); added
  `tests/ask-settlement.test.ts` simulating a P2028 wrapper rejection before the callback settles → caught.
- `captured-identity-binding` (pre-lock hint only) NOT caught: the post-lock comparison independently yields the same 401;
  the combined control is caught. The pre-lock check is fail-fast only.
- `generic-parser-exclusion` NOT caught initially: body-parser 2 skips finished streams itself. Added the non-behavioral
  `installApiParsers(…, parsers = nestDefaultParsers())` seam; a spy test now proves no generic invocation → caught. The first
  run's detail log was overwritten by the rerun's same filename; its outcome line remains in `run-3.log`.
- Run 1 aborted when the workspace-hint control made a gated test wait forever (`run-1-aborted.log`); tests now race gate
  waits against completion. Run 2 aborted on a non-compiling mutation (`run-2-aborted.log`), re-expressed and caught.

## Production proof (`/tmp/atlas-stage5/s5aska-impl/prod-proof-2.log`, script `prod-scripts/prod-proof.sh`)

Fresh copy of 1096 tracked+untracked files → `npm ci --prefer-offline` → `db:generate` → `api:build` → `npm prune --omit=dev`
(pglite/Playwright/@types absent; typescript/prisma kept as `@prisma/client` peers, pre-existing as in S5A/S5B) → served
from a foreign cwd. OFF: `/clients` 200, Ask 404, `tools/execute` 201. MOCK+console: capability 200 with correlation/CSP/
no-store, question 200 (`AskAnswerV1`, cited), wrong Host 421, 32/32 operator assets byte-identical (manifest equals repo
build), Gateway 201. The first attempt failed only on an over-strict prune assertion (`prod-proof-1-failed.log`).

## Development failures and repairs

Test-harness defects found and fixed (no product change): request/expected-count mistakes, missing owner `finish()` in unit
helpers, rolling-limit exhaustion by one PG actor (rotated synthetic actors), a snapshot restore violating a CHECK, an assertion
that moved a token to its own actor, expired-token creation against the expiry CHECK, ANSI codes in log normalization, and a
test-only lock-ordering wait cycle (PostgreSQL granted the queued Stage 3 lock first; the hung run was unblocked so its
disposable DB was dropped). One orphaned negative-control run was killed and its disposable DB/roles dropped manually.

## Residuals for review

1. Prisma engine connection hygiene after an engine-side timeout is not claimed; capacity is held until the transaction promise
   and callback settle, and each in-flight statement is bounded by `statement_timeout`.
2. An undecodable client segment (`/clients/%E0%A4%A/ask`) cannot be routed by Express; it is a pre-auth raw 400
   `ASK_REQUEST_INVALID`, not an authenticated 403. Decodable malformed IDs are authenticated 403 with one denial.
3. A compiled answer over 256 KiB → 413 after phase2 with `ask.failed` (`ASK_TOO_LARGE`); the matrix is silent, chosen to record
   the admitted read. `ASK_CONTEXT_UNAVAILABLE` is reachable only with broken FKs (tested) and is unreachable in fixture.
4. Display marker: 3999 code points + `…`, so a capped string stays ≤4000. Resource freshness uses the phase1 DB clock.
   ENTITY descriptors carry the focus observation's source/type (descriptors require them; entities have none).
5. Ask FOR SHARE delays workspace authority mutations ≤2 s per phase (approved). Budgets are per process, not distributed;
   the fixture's single synthetic actor is limited to 10 questions per 60 s per process.
6. Nest's pre-existing ExceptionsHandler stack logging of generic-parser errors on non-Ask routes is unchanged (identical OFF/MOCK
   header lines; frames now include the classification wrapper). Ask traffic logs nothing except fixed unexpected-error codes.

Write ownership returned to the coordinator.
