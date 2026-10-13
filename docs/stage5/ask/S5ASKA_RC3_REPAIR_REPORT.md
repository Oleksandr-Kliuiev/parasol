# ASK-A rc3 repair report — Astra S5ASKA-rc2 findings R2a/R2b

Code acceptance: **PENDING** fresh explicit `gpt-6-astra` / xhigh. Not self-accepted. No commit, PR, deployment, ASK-B or remote.
Same native session `60e70e73-4279-474b-a915-b95e4abfb6d9`, `claude-opus-5-5`, effort high as pinned by the launcher.

## Identity

HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`. Brief `S5ASKA_RC3_REPAIR_BRIEF.md` `695ad411…91f6`;
review `docs/stage5/reviews/ASTRA_S5ASKA_RC2.md` `6fda86e7…b1e0` (R1/R3/R4 closed; R2a/R2b open); write baseline
`verification/stage5/S5ASKA_REPAIR2_BASELINE.json` `476db16b…5e04e` — verified before writing: 1119/1119 files, 215/215 built.
All new logs/scripts/copies: `/tmp/atlas-stage5/s5aska-repair2-work/`. Reviewer probes only read (hashes re-verified unchanged).

## Changed paths (vs repair2 baseline)

Source: `packages/ask/phase.ts`, `packages/ask/fixture.ts`. Tests: new `tests/ask-fixture-boundary.test.ts`,
`tests/pg/ask-helper-boundary.pg.test.ts`; `tests/ask-phase.test.ts`. Routing docs: `packages/ask/AGENTS.md`,
`docs/AI_CONTEXT_MAP.md`, `docs/RUNBOOK.md` §12 (test list), `tests/pg/AGENTS.md`. Built: only `fixture.js`, `phase.js`.
Byte-identical to the baseline: shared auth (`packages/auth/transaction-token.ts` incl. `currentToken`), all other Ask
modules, main/composition, schema/roles/migrations, dependencies/lockfile, operator source and 33/33 operator built files,
six norms, the rc1/rc2 reports and all prior evidence/baselines/reviews.

## Closure

**R2a — every actual statement of the reused helper passes the Ask boundary.** `phaseSql` now hands each step a guarded,
Ask-only view of the phase transaction (Proxy over `$executeRaw*`, `$queryRaw*` and model-delegate methods). Each ACTUAL call
— including each of `currentToken`'s three separately awaited statements and every `setLocal` — runs: run/phase check
(terminal → `AskStopped`; original deadline, phase end or stopped phase → `ASK_DEADLINE`) → `statement_timeout` re-bounded to
the time left in the phase → check → the statement → check after its await. `currentToken` is reused unmodified, so SQL text,
`ApiToken_lookup` RLS visibility, digest handling and the DB clock are unchanged. A stop at an internal await issues no further
statement; the transaction rolls back (which also discards transaction-local digest/scope settings) under the same owner.
Applies to private authentication, both fenced phases (hint, after-lock re-authentication, denial and final post-INSERT
re-checks) because every DB step goes through the runner.

Real PG17 (`ask-helper-boundary`): a seam executes the k-th digest-setting statement normally and holds only its await return.
Variants: authentication × terminal / original deadline / phase deadline (held 2.15 s: caller sees `ASK_DEADLINE` at the phase
end while the owner stays held); phase1 at the hint (terminal) and after-lock re-check (terminal, original deadline); denial
post-INSERT re-check (terminal); final audit post-INSERT re-check (terminal, original deadline). Every variant: **0 statements
started after the interrupt** (no token SELECT, actor, fence, charge, source, denial or audit), rolling charge 0 for phase1,
denial/audit rows rolled back, exactly one owner release after drain. Physical probe (ApiToken locked during the hold): no token
query reached PostgreSQL — applied where the transaction holds no ApiToken lock yet (authentication, phase1 hint); later holds
rely on the driver-level start record, because the Ask transaction's own AccessShare on ApiToken would make an exclusive probe
queue behind it. Nearby behavior through the guarded view: valid, revoked, DB-clock-expired, DELETE+INSERT rebound (401) and an
ordinary committed publish. Reviewer's token probe (copy): `tokenSelectAfterTerminal:0`, `physicallyBlockedAfterTerminal:false`.

**R2b — fixture post-await guards.** `fixture.ts`: denial and completion now retrieve the demo, then check terminal/original
deadline, then append; admission checks after the authorize await before charging and after the demo await before any source
work. `ask-fixture-boundary` (deferred demo injected, as in the review probe — not ordinary HTTP scheduling; the production demo
normally resolves before requests): denial/publish/admission × terminal/deadline → 0 appends, 0 source reads, only the admission
charge made before its source await, owner held during the pending await and released exactly once; uninterrupted positives still
record one denial / one completion / one source read. Reviewer's fixture probe (copy): 2/2, `auditWrites:0`, `denialWrites:0`.

## Checks (final, `/tmp/atlas-stage5/s5aska-repair2-work/checks/`)

`npm test` **326/326** (incl. context budget); `schema:validate`, `db:generate`, `typecheck`, `ui:typecheck`, `ui:build`,
`api:build`, `api:smoke` exit 0; `test:pg` **616/616**; `db:check:pg17`, `db:check:drift` pass; `test:ui` **50 passed**;
`git diff --check`, untracked whitespace clean. Accurate Ask counts: unit **46** (`tests/ask-*.test.ts`; the rc2 report's
"36" was stale — rc2 actually had 37), PG **47** (http 9, source 10, authority 10, budget 6, physical 6, helper-boundary 6).
Reviewer probes on the repaired code (path-adjusted copies, `hostile/`): token-boundary 1/1, fixture-boundary 2/2,
original hostile 5/5 (R1 2003 ms, R2 `newEntityRead:false`, R3 503/413, R4 401/403 + 1 denial).

## Negative controls (`negative/controls.py`, `run-1.log`; bytes restored and SHA-256-verified 18/18; dist rebuilt)

All caught with assertion failures: guarded view bypassed (driver-level starts after the interrupt 1–2, physical token waits
observed); per-actual-statement checks removed (2–4 starts after the interrupt); per-actual-statement `statement_timeout`
re-bound removed (R1 physical: owner not released within the phase budget); fixture denial post-demo check removed (denial
appended), publish post-demo check removed (completion appended, SUCCESS), admission post-demo check removed (source read).
Qualification: the boundary's pre-start and post-await checks are mutually redundant for the held-return scenario (either one
stops the next statement), so the control removes both; removing the check after `await authorize` alone is unobservable for
the synchronous synthetic membership rule and was not claimed as a control.

## Production and physical proof

`prod-proof.log`: fresh copy (1122 files) → `npm ci --prefer-offline` → generate → build → `npm prune --omit=dev`
(typescript/prisma kept as `@prisma/client` peers, pre-existing) → foreign cwd. OFF: clients 200, Gateway 201, Ask 404.
MOCK+console: capability 200 (correlation, CSP, no-store), question 200 cited `AskAnswerV1`, Gateway 201, wrong Host 421,
32/32 assets byte-identical, manifest `d8329d97…` equals the repository build. R1 physical tests (`ask-physical`) unchanged
and passing in the final suite; R3/R4 positives/negatives unchanged and passing.

## Failed attempts (preserved under `focused/`, `hostile/`)

`unit-1` initial phase unit test still called the old runner shape and a harness label used the setting name instead of its value
(test-only); `pg-helper-1.log`: my exclusive ApiToken probe for later-in-phase holds queued behind the Ask transaction's own
AccessShare, so the phase timer fired first (outcome mismatch; 0 statements after the interrupt even then) — probe restricted
as described. No product attempt failed.

## Limitations

- Statement-start absence is proven at the driver interface of the phase transaction (every call the Ask code or the reused
  helper makes) and physically by lock observation where possible. Engine/pool/network cleanup beyond measured lock-wait
  cancellation, rollback and promise settlement is not claimed; the owner is held while any phase promise is unsettled and is
  never released by the phase timer.
- Fixture evidence uses an injected deferred demo dependency; normal fixture HTTP scheduling does not normally reach that state.
- rc1/rc2 qualifications unchanged (post-compilation 413 audit choice, display marker, freshness clock, ENTITY descriptor
  enums, per-process budgets, shared-fence contention, generic-parser logging).

Write ownership returned to the coordinator; no background jobs, servers or disposable databases remain.
