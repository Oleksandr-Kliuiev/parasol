# S2-B RC3 — implementer report (Astra RC2-R1..R4, approved corrective policy)

Implementer: Claude Code 2.1.293, native Anthropic, `claude-opus-5-5`, effort high; same S2-B task session. Implementer
evidence only — not acceptance. Fresh Astra xhigh review of the actual RC3 is required before S2-C. Mock transport and
disposable PostgreSQL only; no live tenant, deployment, commit, packaging or status update.

**Baseline:**
- Frozen `S2B_RC2_MANIFEST.json`, 260 files; the checkout matched it exactly before editing.
- Findings: `docs/stage2/reviews/ASTRA_S2B_RC2.md`.
- Policy: `docs/stage2/reviews/S2B_RETRY_REPAIR_PLAN_RC2.md`, SHA-256 `95035762…3799`, verified before work and approved by
  Astra xhigh and Fable high.

**Not changed:** RC1/RC2 evidence, normative RC5 `docs/stage2/*`, accepted and RC2 migrations (`2026100810…1300`).

**Delta:** 24 modified + 9 new files. List hash `8adb8832…0b3a`; per-file SHA-256 in
`/tmp/atlas-s2b/rc3-checkpoint/rc3-delta.sha256`.

## Implemented corrections

**R1 — finite durable directory retry chain.**
- **Migration** `202610081400_stage2_m365_directory_budget`:
  - Adds `M365ResourceState.attemptsUsed INT NOT NULL DEFAULT 0`.
  - Backfill `LEAST(8, started − published)` for directory rows, run *before* the guard trigger is created.
  - `M365ResourceState_attempts_check`: 0..8, sign-in rows 0.
  - Trigger `M365ResourceState_sequence_budget` (fires after `_order`/`_retry`) with exactly the plan's classes:
    - INSERT: zero budget.
    - Claim: started +1 / budget +1 from below 8.
    - Publication: any pointer move needs budget 0 (0→0 allowed), a higher published sequence and the newest recorded outcome.
    - Reset: positive → 0, started +1, recorded = started, retryAt NULL, pointer/published unchanged, only for an exhausted
      chain, an ERROR/MISSING status or an outstanding claim.
    - Anything else changes neither started nor budget.
  - No `now()` rule in SQL.
- **Grants and runtime check:** runtime-only `UPDATE("attemptsUsed")` in `roles.sql`; the definer gains nothing. The column
  is on the runtime allowlist, and the fail-closed `missingUpdateColumns` self-check refuses the runtime until `roles.sql` is
  reapplied.
- **Service** (`directory.ts`, limit `m365Limits.directory.maxAttempts = 8`):
  - Every claim charges one attempt before secrets or I/O; crashed and superseded claims stay charged.
  - The newest unexpired failure persists `retryAt` for every TRANSIENT error, the final attempt included: exponential from
    30s by charged count, capped at 15m; 429 exact or 60s + ≤10s jitter. PERMANENT clears it. The code is preserved in state
    and generation.
  - Publication resets budget and `retryAt`.
  - Results carry `attemptsUsed`/`maxAttempts`; `status.ts` `directoryView` exposes them plus `M365_ATTEMPTS_EXHAUSTED`.
- **Reset** `directory-retry.ts` `resetM365DirectoryRetry`:
  - ACTIVE connection, current `events:ingest` + `connections:manage`; Connection → state → latest generation locks; clock
    after the locks.
  - Refusals: future `retryAt` → `M365_RETRY_NOT_DUE`; live STAGING claim → `M365_CLAIM_HELD`; zero budget or ineligible chain
    → `M365_RESET_NOT_ELIGIBLE`.
  - Effect: common new fence, budget 0, elapsed `retryAt` cleared, last-good pointer/counts/lastSuccess, failure status/code
    and history kept. PENDING/OK chains become ERROR/`M365_CLAIM_EXPIRED`, also after cleanup removed the generation.
  - Same-transaction client audit `m365.directory_retry_reset`.
- No HTTP/scheduler retries, sleeping or CLI/API.

**R2 — atomic admission.** Under Connection FOR SHARE and current authority:
1. `INSERT … ON CONFLICT DO NOTHING` (waits for a concurrent uncommitted first insert).
2. `SELECT … FOR UPDATE`, then the clock.
3. Exhaustion (`M365_ATTEMPTS_EXHAUSTED`, PERMANENT, details used/max/retryAt), then throttle (`M365_RETRY_NOT_DUE`, TRANSIENT),
   both refused with no write.
4. Only then charge + sequence, and the generation in a later statement.

The two-session regression uses an uncommitted owner insert as a test-only DB barrier; no production hook was added.

**R3 — repeat sign-in outcomes** (`windows.ts`, `ingest.ts`):
- The terminal check precedes expired-attempt maintenance. COMPLETE → DONE/null; FAILED → FAILED with the stored code.
- A crashed final claim keeps its original code (`M365_ATTEMPTS_EXHAUSTED` only when none exists).
- HELD and NOT_DUE stay distinct.
- Root results carry `attemptsUsed`/`maxAttempts`. FAILED with used == max means exhausted; the code tells the cause (a
  permanent failure on the last attempt also has used == max).
- The incorrect recovery expectation (exhausted → DONE) now asserts `FAILED`, `M365_UPSTREAM_UNAVAILABLE`, 5/5, with no
  sixth attempt.

**R4 — workspace denial at public boundaries** (`denial.ts`):
- `withDenialAudit` wraps `syncM365Directory`, `resetM365DirectoryRetry`, `createM365SignInRequest`, `runM365SignInRequest`
  and `requeueM365RootJob`. One row per invocation for PERMISSION_DENIED/SCOPE_DENIED through `PrismaSecurityAudit`, in its
  own workspace transaction. Fields: actor workspace, requested client ID, fixed event type, safe code, correlation; metadata
  `{}`.
- A failed audit write becomes `SECURITY_AUDIT_FAILED`; it is never swallowed.
- `recordUnlessDenied` rethrows a denial of the original operation or of the failure recording, so the outcome is never
  reported as recorded. Other recording errors return `recorded: false`.
- A withdrawn actor never writes a client audit row.
- Activation's denial branch reuses `appendDenial` (same event type and shape; no scope change).

**Fixture adaptation** (required by the approved "any other change refused" class; no assertion weakened): raw-SQL claim
emulations in `m365-fixtures`, `m365-sql-invariants`, `m365-publication-atomic` and `m365-race-directory` now charge one
attempt per started step and reset to 0 in their publication UPDATEs. The RC2 retry/upgrade tests were adjusted for the
new column and the advancing-clock backoff. SQL coverage of the new CHECK/trigger is in `tests/m365-budget-invariants.ts`,
run on PGlite and in `db:check:pg17`.

**Workflow wording:** `docs/DEVELOPMENT_WORKFLOW.md` now states that S2-B is not yet accepted and needs fresh Astra xhigh
acceptance.

## Commands (2026-10-08, Node 25.8.1, Prisma 6.19.0, PostgreSQL 17.11) — logs `/tmp/atlas-s2b/rc3-checkpoint/`

| Command | Result |
|---|---|
| `npm run schema:validate` / `db:generate` / `typecheck` | exit 0 / 0 / 0 |
| `npm test` | exit 0 — **132 tests, 132 pass**, 0 fail, 0 skipped (RC2 128 + 4: budget invariants on PGlite, 3 denial-helper units) |
| `npm run api:build` / `api:smoke` | exit 0 / 0 |
| `npm run test:pg` | exit 0 — **240 tests, 240 pass**, 0 fail, 0 skipped (RC2 227 + 13); run once |
| `npm run db:check:pg17` | exit 0 — 17 passed blocks incl. "M365 directory retry budget" |
| `npm run db:check:drift` | exit 0 — zero drift with both new migrations |
| `git diff --check` | exit 0; new untracked files: no trailing whitespace; largest changed file 358 lines (modules ≤293) |

New PostgreSQL tests (13):
- `m365-directory-budget` (5):
  - 503/network/timeout backoff 30s→15m persisted through the 8th attempt.
  - Exhaustion before throttle across a fresh client, with no write, secret or I/O.
  - View counters; reset refused before `retryAt`, then fenced and audited.
  - Crashed/superseded charges with an exact 7200s 429 on the final attempt.
  - Reset refusals (zero/held/permission + workspace denial) and normalized reset fencing the old claim.
  - First-ever crash reset before publication and after cleanup.
  - R2 barrier race.
- `m365-budget-upgrade` (1): populated RC2 → RC3. Backfill 5/8/0, retryAt and codes preserved, runtime refused until
  `roles.sql`, then NOT_DUE/EXHAUSTED with zero I/O.
- `m365-signin-outcomes` (2): DONE / FAILED-403 / FAILED-exhausted 5/5 / NOT_DUE / HELD with no claim, charge, secret, I/O or
  history change; terminal before maintenance.
- `m365-sync-denial` (5): pre-I/O at all five sign-in/directory boundaries, plus directory and sign-in withdrawal between
  pages and before publication. Each has one safe workspace row, no further request, no publication or recording, and no
  client row.

Focused runs before the checkpoint: all S2-A M365 suites touched by the fixture adaptation (publication-atomic,
race-directory, permissions, confirm-clock, schema, scope, privileges, routine-acl, upgrade) and every S2-B suite passed.

## Risks and notes

- SQL cannot tell a mischarging claim from an eligible reset in every ERROR/unrecorded case. "Every claim charges" and "every
  reset is authorized and audited" are service-plus-test invariants, as the approved plan states.
- A valid page already received before a withdrawal can still be *staged* (invisible STAGING/evidence rows). Staging
  rechecks the claim, not authority; publication and recording do recheck authority. This is unchanged from RC1/RC2 design.
- With 8 attempts and a 15m cap, an exhausted chain needs an explicit audited reset. No automatic recovery exists by design.
- Mock transport only; live Graph behaviour is unverified (S2-LIVE). `test:pg` was run once.

## Write handoff

Implementation writing has stopped; this process makes no further edits after this report. Write ownership returns to
Codex when it exits. Not done by me: RC3 manifest/ZIP, status files, commit, S2-C, live checks.
