# ASK-A rc2 repair report — Astra S5ASKA-rc1 findings R1–R4

Code acceptance: **PENDING** fresh explicit `gpt-6-astra` / xhigh. Not self-accepted. No commit, PR, deployment, ASK-B or remote.
Same native session `60e70e73-4279-474b-a915-b95e4abfb6d9`, `claude-opus-5-5`, effort high as pinned by the launcher.

## Identity

HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`. Repair brief `S5ASKA_RC2_REPAIR_BRIEF.md`
`e4856d29…a4cd`; review `docs/stage5/reviews/ASTRA_S5ASKA_RC1.md` `f9c34895…e03f`; write baseline
`verification/stage5/S5ASKA_REPAIR1_BASELINE.json` `95713a2d…7d7` — verified before writing: 1106/1106 files, 214/214 built.
Contracts unchanged (six RC3 norms); `S5ASKA_IMPLEMENTATION_REPORT.md`, reviews, seals, baselines and old evidence untouched.
All new logs/scripts/copies: `/tmp/atlas-stage5/s5aska-repair1-work/` (rc1 evidence and Astra probes only read).

## Changed paths (vs repair baseline)

Source: new `packages/ask/phase.ts`; `packages/ask/{authority,read,input}.ts`, `apps/api/src/{ask-http,ask-fixture}.ts`,
`apps/api/src/db/ask.ts`. Tests: new `tests/ask-phase.test.ts`, `tests/pg/ask-physical.pg.test.ts`; `tests/ask-input.test.ts`,
`tests/ask-settlement.test.ts`, `tests/pg/ask-{http,source}.pg.test.ts`. Routing docs: `packages/ask/AGENTS.md`,
`docs/AI_CONTEXT_MAP.md`, `docs/RUNBOOK.md` §12, `tests/pg/AGENTS.md`. No main.ts/module/schema/role/dependency/operator change.
Built: only the six corresponding Ask JS files changed plus new `phase.js`; all 33 operator built files byte-identical.

## Closure

**R1 — absolute DB phase bound.** `phase.ts`: each private phase gets ONE end, min(2 s, remaining original), fixed at phase
start. `phaseSql` is the only statement path: before each statement it re-bounds transaction-local `statement_timeout` to the
time LEFT in the phase (never the full 2 s again). `authority.ts boundedTx` adds a caller-visible phase timer racing the
transaction: at the end the caller gets the fixed `ASK_DEADLINE` and the phase is stopped (no further statement); the owner
still holds the transaction promise AND its callback until both settle. Stage mapping unchanged (auth/phase1 not-ready,
phase2 audit-failed, timeouts deadline). Real PG17 (`ask-physical`): two sequential lock waits in one phase (ApiToken→Actor;
fence→Observation; fence→final-audit FK) — caller failure at 2002–2003 ms in all three (rc1: 3.2 s); owner sampled held
until no runtime backend remained active/in-transaction, released at 2007–2017 ms exactly once, then recovery.
Astra's original probe (path-adjusted copy, original unchanged): `two-auth-waits` 2002 ms, `remainingPg:0`.

**R2 — per-await terminal/deadline checks.** Every statement of private authentication, both fenced phases, the source reader
(page, focus, entities, links, connections, states, items) and finalization runs through `phaseSql`, which checks the run
(terminal → `AskStopped`; original deadline) and the phase before and after each await; the charge is preceded by the same
check. HTTP+PG barriers: Observation blocked + Entity separately blocked → disconnect → owner still held → Observation released
→ no Entity statement within 700 ms, no extra charge (admissions 1), no audit, drain, exactly one release; same for
ApiToken→Actor (authentication) and phase2 fence wait → no final AuditEvent INSERT. Astra probe `read-after-disconnect`:
`newEntityRead:false`.

**R3 — every original snapshot validated/accounted before projection.** `read.ts readResources`: any existing snapshot of a
selected tuple is checked (array type, ≤1000 items, cumulative bytes ≤4 MiB, asOf, truncated) and its items materialized and
validated BEFORE the PENDING/UNAVAILABLE→MISSING projection. Valid output unchanged. PG: PENDING and UNAVAILABLE each with a
valid snapshot (200, card MISSING/asOf null/truncated false, no item leakage, coverage unchanged), malformed item and wrong
source item (503 `ASK_SOURCE_INVALID`), 4.5 MB title (413 `ASK_TOO_LARGE`), no planner/completion audit; restore → OK.

**R4 — undecodable client segments inside the Ask boundary.** `input.ts` returns the Ask-owned client ID (Express-equivalent
decoding, else the raw segment text, which contains `%` and can never satisfy `SCOPE_ID_PATTERN`) and, only for undecodable
segments, a re-encoded routing path; the ingress sets it after raw parsing so Express delivers the request to the Ask
controller instead of its parameter error. Controllers no longer read `@Param`; `serveAsk` passes the private client ID and
checks the shape. Fixture+DB processes, four spellings (`%E0%A4%A`, `%ZZ`, `/CLIENTS/%/ASK/`, `%C3%28`): malformed JSON 400
and declared 16385 bytes 413 before authentication; no/unknown credential 401; semantic 400; valid → 403 with exactly one
`ask.scope_denied` (requested text = raw segment, SCOPE_DENIED, `{}`), zero denials before; HEAD/OPTIONS synchronous 404.

## Checks (final, `/tmp/atlas-stage5/s5aska-repair1-work/checks/`)

`npm test` 317/317 (incl. context budget); `schema:validate`, `db:generate`, `typecheck`, `ui:typecheck`, `ui:build`,
`api:build`, `api:smoke` exit 0; `test:pg` 610/610 (155 s); `db:check:pg17`, `db:check:drift` pass; `test:ui` 50 passed;
`git diff --check` and untracked trailing-whitespace scan clean. Ask tests now: unit 36, PG 41 (http 9, source 10,
authority 10, budget 6, physical 6). Astra's five hostile assertions: 5/5 pass (`hostile/run-2.log`).

## Negative controls (`negative/controls.py`, per-run log names, bytes restored + SHA-256 verified, dist rebuilt)

Caught with assertion failures: per-statement budget reset (physical: "released at 3211 ms"); caller-visible phase timer
removed (hung-driver unit test); per-await terminal check removed (physical: new Entity statement); UNAVAILABLE/PENDING before
snapshot validation (source: 200 instead of 503); snapshot items not materialized for PENDING/UNAVAILABLE; undecodable path
not routed to Ask (Express "Failed to decode param" 400); early 400 before auth; authority from a rewritten path (200 answer
instead of 403). The first R3-ordering mutation did not compile (TypeScript narrowing, `run-1.log`); re-expressed and caught
(`run-2.log`).

## Production proof (`prod-proof.log`)

Fresh copy (1110 files) → `npm ci --prefer-offline` → generate → build → `npm prune --omit=dev` (typescript/prisma kept as
`@prisma/client` peers, pre-existing) → foreign cwd. OFF: clients 200, Gateway 201, Ask 404. MOCK+console: capability 200
(correlation, CSP, no-store), question 200 cited `AskAnswerV1`, Gateway 201, wrong Host 421, 32/32 assets byte-identical,
manifest `d8329d97…` equals the repository build.

## Failed attempts (preserved)

`focused/unit-1.log` (rc1 classification expectation encoded R4 defect, updated); `focused/pg-http-1.log` (test variable
shadowing); `focused/pg-physical-1.log` (my phase2-disconnect test took the fence before phase1); `hostile/run-1.log`
(package resolution from /tmp; symlinked node_modules in scratch); controls `run-1.log` (non-compiling mutation).

## Remaining uncertainty and qualifications

- Physical settlement is proven for real lock waits (statement cancelled by the remaining-budget `statement_timeout`, rollback
  observed before release) and, for driver orderings PostgreSQL cannot provoke (wrapper rejected before callback; a driver that
  never rejects), by stand-in unit tests. Engine/pool connection hygiene beyond promise settlement is not claimed; capacity is
  retained while any phase promise is unsettled, never released by the timer race.
- The accepted shared `currentToken` helper is called as one statement unit; its internal `set_config` statements (no locks)
  are not individually checked. Its one blocking SELECT is bounded by the remaining phase budget.
- rc1 qualifications kept as recorded: post-compilation 413 with `ask.failed/ASK_TOO_LARGE` (matrix silent); display marker;
  phase1 freshness clock; ENTITY descriptor source/type; per-process budgets; shared-fence contention; generic-parser logging.
- Re-encoded routing applies only to undecodable segments; authority uses the private raw ID, never the rewritten parameter.

Write ownership returned to the coordinator; no background jobs or disposable databases remain.
