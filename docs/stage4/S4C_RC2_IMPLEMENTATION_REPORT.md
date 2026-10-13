# S4-C RC2 implementation report — cleanup deadline/cancellation repair (Astra S4C-rc1 R1/R2)

Status: **IMPLEMENTED — PENDING fresh independent GPT-6 Astra/xhigh acceptance** of this new artifact (deadline/cancellation is
a critical invariant). S4C-rc1 is CHANGES_REQUIRED and was never accepted. LIVE remains **DEFERRED_BY_OWNER**. Not
self-accepted; status files, seals and the RC1 report/review/evidence are unchanged. This report **supersedes** the RC1
report's qualification that the post-check COMMIT gap was "sub-millisecond": that statement was wrong (Astra reproduced a
COMMIT at 12,120 ms, seconds after the original deadline); the exact fixed behavior and the remaining residual are below.

Implementer: the same cohesive native Claude Code session, `claude-opus-5-5`, effort high, no subagents; identity and
billing are captured by the launcher (preflight `verification/stage4/S4C_RC2_REPAIR_PREFLIGHT.json`). Baseline
`verification/stage4/S4C_RC2_REPAIR_BASELINE.json`: all 847 files hash-identical before the first edit.

## Changes (bounded to the approved maintenance concern)

- NEW `packages/poweroffice/runner-transaction.ts` (cohesive helper): original budget, server-side deadline anchor, bounded
  statements, structured failure classification, one Prisma runner transaction.
- `packages/poweroffice/maintenance.ts`: `runPowerOfficeCleanup` now runs its unchanged body (runner confinement + pairing
  facts, singleton GUCs, `atlas_poweroffice_cleanup`) through `runBoundedTransaction`; the RC1 in-file timer/classifier was
  removed. Admission, capability (single use), URL pairing and receipt validation are unchanged.
- NEW tests: `tests/poweroffice-runner.test.ts` (pure), `tests/pg/poweroffice-cleanup-deadline.pg.test.ts` (actual PG17).
- Routing/runbook only: `packages/poweroffice/AGENTS.md`, `tests/pg/AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `docs/RUNBOOK.md` §10.
- Unchanged: `runner-role.ts` (exact confinement/pairing SQL), `packages/ops/poweroffice.ts` (CLEANUP_TIMEOUT was already
  exit 1, RUNTIME_NOT_READY exit 2), every RC1 test, migrations, roles, schema, shared contracts. No `pg` runtime dependency
  was introduced (it remains a devDependency); the transport stays Prisma.

## Fixed cancellation/COMMIT semantics

1. The deadline is fixed once (`performance.now() + 10 000 ms`) before the runner client exists and is never reset.
2. Acquisition/login/pool and BEGIN: Prisma `maxWait` = remaining budget. Its timeout (structured `errorCode`/`code` P2024)
   rejects before the transaction body runs — no SQL, routine, audit or commit ever follows (proven after the delayed
   login completes).
3. Server-side absolute deadline: the first statement after BEGIN sets, transaction-locally, `lock_timeout` 1000 ms,
   `statement_timeout` = min(10 s, remaining − 250 ms) and `transaction_timeout` = remaining − 250 ms. Verified on PG17
   (`/tmp/atlas-stage4/s4c-rc2-scratch/tt-probe.log`): the timer is armed when that statement arrives, ends a slow COMMIT with
   25P04 and zero rows, and is NOT extended by a later set (a disable-then-enable re-anchor also did not re-arm it, so the
   code never re-anchors). The anchor is accepted only if its client-measured round trip is ≤ 250 ms; the server timer then
   started no later than the client's receipt, so it fires inside [deadline − 250 ms, deadline]. A slower anchor fails
   closed as CLEANUP_TIMEOUT (rollback, no retry). When the timer fires PostgreSQL terminates the session and rolls back —
   during any statement, while the client is idle between statements, and during COMMIT/deferred trigger work.
4. Every later statement: client budget check, `statement_timeout` re-set to the remaining budget, check again; a pre-COMMIT
   client check. Lock waits stay limited to 1000 ms.
5. The client never returns before the DB outcome settles (`$transaction` awaits COMMIT/ROLLBACK; no `Promise.race`). Prisma's
   own transaction timeout is only a backstop at remaining + 2 s so it cannot misreport a COMMIT the server completed
   before the deadline.
6. Classification uses structured fields only (`name`, `code`, `errorCode`, Prisma `meta.code` or a driver SQLSTATE), never
   message text, and echoes nothing: own budget marker, 57014/55P03/25P03/25P04, P2024/P2028, initialization `errorCode`
   P2024/P1002/P1001, or any failure inside the server deadline window → `POWEROFFICE_CLEANUP_TIMEOUT` (CLI exit 1);
   40P01/40001/P2034 → `POWEROFFICE_DB_CONFLICT`; other initialization failures (P1000 authentication, unknown database/role…)
   → `POWEROFFICE_RUNTIME_NOT_READY` (exit 2); runner confinement/pairing → RUNTIME_NOT_READY; BUSY → SYNC_BUSY; otherwise
   CLEANUP_FAILED. P1001 is treated as a connect timeout because the runner target is already proven identical to the runtime
   target that just served the admission (a different target is refused by URL pairing before any connection).

## R1/R2 closure evidence (actual PostgreSQL 17.11, disposable DBs/roles, silent wrapper)

- Reviewer reproductions, unmodified scripts, on the repaired source: `budget-probes.mjs` → pool-over-budget
  `POWEROFFICE_CLEANUP_TIMEOUT` 10 011 ms unchanged; commit-over-original-budget `POWEROFFICE_CLEANUP_TIMEOUT` 9 769 ms,
  snapshots 1 → 1, pointer kept (`/tmp/atlas-stage4/s4c-rc2-scratch/budget-probes-rc2-final.log`; first repaired run
  10 008 / 9 763 ms in `budget-probes-rc2-run1.log`). `login-metadata.mjs` (pure Prisma behavior) still reports
  `errorCode P2024` at 10 006 ms, which the wrapper now classifies as timeout.
- `tests/pg/poweroffice-cleanup-deadline.pg.test.ts` (5/5): 4 s login + 4 s routine audit + 4 s deferred COMMIT trigger →
  CLEANUP_TIMEOUT returned ≤ 10 150 ms, pointer/snapshots/attempts/cleanup audit unchanged immediately AND at 13.5 s after the
  start, no runner backend left; 12 s COMMIT-only work → same; 2+2+2 s within budget → COMMITTED (positive control, no
  premature deadline); 15 s login with `connect_timeout=30` → CLEANUP_TIMEOUT at ≈10 s, nothing at 17 s, 7 s login with the
  default 5 s connect timeout → CLEANUP_TIMEOUT, wrong password → RUNTIME_NOT_READY; actual CLI 15 s login → exit 1
  `POWEROFFICE_CLEANUP_TIMEOUT`, no URL/password in output, empty network trap, no late effect.
- Negative control: the same test file run against the frozen RC1 source tree (`/tmp/atlas-stage4/S4C_RC1_SOURCE.zip`
  extracted to scratch) fails 4/5 exactly as reviewed — `ok:COMPLETED` instead of timeout for both COMMIT cases,
  RUNTIME_NOT_READY in-process and `[2, RUNTIME_NOT_READY]` from the CLI — while the positive control passes
  (`deadline-negative-control-rc1.log`).
- `tests/poweroffice-runner.test.ts` (4/4): structured classification, message text ignored, server-window rule, budget never
  resets.
- Existing invariants re-run on the repaired source (16/16): runner facts positive/negative, 1 s lock timeout, routine audit
  failure, original budget with slow login, Connection UPDATE orders, both deadlock victims, admission denials,
  unforgeable single-use capability, completion after revocation, ten runner misconfigurations, BUSY, NO_STATE, disabled purge,
  sibling isolation, 1000 bound, missing/healthy fence and runner tamper (`focused-rc2-run1.log`).

## Checks

Focused during repair: unit 4/4; deadline PG 5/5 (two runs: `deadline-run1.log`, `deadline-run2.log`); RC1 maintenance,
budget and fence PG 16/16; reviewer reproductions as above (logs in `/tmp/atlas-stage4/s4c-rc2-scratch/`).
Final required run on the corrected source `/tmp/atlas-stage4/s4c-tools/checks.sh rc2-final`, logs
`/tmp/atlas-stage4/s4c-checks/rc2-final/` (10:21:23Z–10:24:14Z), all 11 exit 0: npm test **217/217** (213 + 4 new),
schema:validate, db:generate, typecheck, api:build, api:smoke, test:pg **554/554** (549 + 5 new; 149 s), db:check:pg17,
db:check:drift, git diff --check, untracked-whitespace. RC1 run logs (`rc1-final`) are retained unchanged. This report was
completed after the run (documentation only); diff/whitespace checks were re-run on it.

## Failed attempts and diagnostics (preserved)

1. Re-anchor design rejected by evidence: on PG17 `set_config('transaction_timeout','0')` followed by a new value in one
   statement did not re-arm the timer (COMMIT completed at 4 015 ms); the implementation uses one conservative anchor only.
2. First negative-control run passed 5/5 on "RC1": the silent wrapper runs from the repository, so the relative test path
   executed the repaired tree. Re-run with absolute paths gave the valid 4/5 failure above; both logs are kept.
3. Prisma reports a 7 s login under its default connect timeout as `errorCode P1001`, not P2024
   (`connect-probe.log`); classification extended to P1001/P1002 with the pairing rationale above.
No other repair round was needed; the first implementation closed both reviewer reproductions.

## Residual risks and qualifications

- The only window after the original deadline is PostgreSQL's atomic commit point (interrupts are held while the commit record
  is written); the server timer itself fires no later than the client deadline when the anchor round trip ≤ 250 ms. Up to
  250 ms of the budget is deliberately unused by the server.
- If the client loses the COMMIT response (network loss) the outcome may be unknown to the CLI even though the server finished
  before the deadline; cleanup has no unsafe effect when re-run explicitly, and no automatic retry exists.
- Requires PostgreSQL 17 (`transaction_timeout`); on an older server the anchor statement fails and cleanup refuses
  (CLEANUP_FAILED, zero effects). Stage 4 targets PG17 only.
- Test-only DB-local delay objects (login event trigger for the disposable runner role, BEFORE and deferred constraint audit
  triggers limited to `poweroffice.cleanup`, all PUBLIC-revoked) are dropped in `finally`; they emulate latency, they are not
  shipped schema.
- RC1 qualifications on deadlock construction, reads/admission without lock_timeout, per-read audit rows and the 1000-attempt
  cap are unchanged.
