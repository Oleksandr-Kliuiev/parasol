# S4-C RC3 implementation report — inherited transaction timer repair (Astra S4C-rc2 R1)

Status: **IMPLEMENTED — PENDING fresh independent GPT-6 Astra/xhigh acceptance** of this new artifact (critical
deadline/cancellation invariant). S4C-rc1 and S4C-rc2 are CHANGES_REQUIRED and were never accepted. LIVE remains
**DEFERRED_BY_OWNER**. Not self-accepted; status, manifests, seals and the RC1/RC2 reports, reviews and evidence are unchanged.
Same cohesive native Claude Code session (`claude-opus-5-5`, high, no subagents); identity/billing captured by the launcher
(`verification/stage4/S4C_RC3_REPAIR_PREFLIGHT.json`). Baseline `S4C_RC3_REPAIR_BASELINE.json`: 860 files hash-identical
before the first edit.

## Correction of earlier claims

The RC2 report and code comment said the first statement after BEGIN "arms" the server deadline. That is **false whenever
a positive `transaction_timeout` is inherited** (role, role-in-database, database, user or connection-startup setting):
PostgreSQL 17 arms the timer when the transaction starts and an in-transaction assignment never replaces an armed timer.
Astra reproduced a COMMIT at 12 125 / 12 097 ms with an inherited 30 s value. RC2's guarantee held only for the default
`transaction_timeout = 0`. RC3 replaces that mechanism; the RC2 report stays unmodified as history and is superseded here.

## Diagnosis (actual PG17.11, `/tmp/atlas-stage4/s4c-rc3-scratch/prebegin-probe.log`)

On one connection with a deferred 4 s COMMIT trigger: an inherited role-in-database 30 s value alone COMMITTED at 4 020 ms
(source "database user"); a SESSION `set_config('transaction_timeout','1500ms', false)` before BEGIN ended COMMIT with
25P04 at ~1 510 ms and zero rows for inherited role (source shown "session"), database and startup-option (`options=-c …`)
30 s values and for the default — the implicit transactions of the setup statements end before BEGIN, so BEGIN arms the
timer with the session value. This control must happen on the SAME session that runs BEGIN, which Prisma's pooled
interactive transactions do not guarantee; hence the transport change below.

## Changes (bounded to the approved maintenance concern)

- `packages/poweroffice/runner-transaction.ts` (rewritten transport): ONE dedicated `pg` client per cleanup (never a pool),
  connected within min(remaining budget, the paired URL's `connect_timeout`, Prisma's documented 5 s default). Before BEGIN
  on that session: read the inherited `transaction_timeout`/`statement_timeout`/`lock_timeout`; set as SESSION values
  `transaction_timeout` = remaining − 250 ms, `statement_timeout` = min(that, 10 s), `lock_timeout` = 1000 ms — each lowered
  to a STRICTER positive inherited value, never raised — and `search_path` = the paired URL's Prisma `schema` (default
  public); read back `pg_settings` and require exactly these values with source `session`, else RUNTIME_NOT_READY. Then
  BEGIN; the time from computing the value to the BEGIN reply must be ≤ 250 ms, else ROLLBACK + CLEANUP_TIMEOUT (server
  timer therefore fires inside [deadline − 250 ms, deadline]). Inside: budget check + `statement_timeout` re-set before each
  statement; pre-COMMIT check; COMMIT awaited; on failure ROLLBACK (best effort), connection closed. No Promise.race, no retry.
- Classification stays structured-only: own budget marker and own connect timer, SQLSTATE 57014/55P03/25P03/25P04 (and the
  RC2 Prisma codes for compatibility), the deadline-window rule → CLEANUP_TIMEOUT; 40P01/40001 → DB_CONFLICT; refused
  connection/authentication/unknown role or database (e.g. 28P01) → RUNTIME_NOT_READY; else CLEANUP_FAILED.
- `packages/poweroffice/maintenance.ts`: the unchanged body (runner confinement + pairing facts, singleton GUCs, routine) now
  receives a single-connection `query` function; admission, single-use capability, URL pairing (every query option) and
  receipt validation unchanged. `runner-role.ts`, CLI exit mapping, schema, roles and migrations unchanged; no new grant.
- Test support: `tests/support/poweroffice-net-trap.ts` now lets exactly the paired database `host:port` (passed by
  `poweroffice-process.ts` from the child's runtime URL, never printed) through `net.Socket.connect`/`dns.lookup`; every
  other target is still recorded; the CLI privacy test's positive control now runs WITH that allowance and must record
  `fetch`, `net.connect` and `net.Socket.connect` to another target.
- NEW `tests/pg/poweroffice-cleanup-inherited.pg.test.ts`; routing/runbook: `packages/poweroffice/AGENTS.md`,
  `tests/pg/AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `docs/RUNBOOK.md` §10.

## Closure evidence (actual PostgreSQL 17.11, disposable DBs/roles, silent wrapper, absolute paths)

- Reviewer's unmodified `inherited-timeout.mjs`: **POWEROFFICE_CLEANUP_TIMEOUT at 9 768 ms**, snapshots 1 → 1, pointer kept;
  ≥ 11 768 ms later: 1 snapshot, pointer kept, **0 cleanup audits, 0 working runner backends**. RC1 probes: pool-over-budget
  TIMEOUT 10 005 ms unchanged; commit-over-budget TIMEOUT 9 761 ms retained; `login-metadata.mjs` (Prisma-only) unchanged
  (`reviewer-probes-rc3-run1.log`).
- `poweroffice-cleanup-inherited.pg.test.ts` 4/4: role-in-database, database and startup-option inherited 30 s (each verified
  by an independent `SHOW`) with 4 s login + 4 s routine + 4 s deferred COMMIT → CLEANUP_TIMEOUT ≤ 10 150 ms, pointer/snapshots/
  attempts/audit unchanged immediately and at 13.5 s, no working runner backend; within-budget 2+2+2 s under inherited 30 s
  commits; stricter inherited 2 s ends a 4 s routine before 4 s with zero effects; inherited 60 s lock/statement timeouts
  still give the contract 1 s lock timeout; after reset the cleanup completes (`inherited-run1.log`).
- Negative control: the same file against the frozen RC2 source (`/tmp/atlas-stage4/S4C_RC2_SOURCE.zip`, absolute path) fails
  3/4 with `ok:COMPLETED` in all three inherited-30 s variants; the stricter-value control passes on both
  (`inherited-negative-control-rc2.log`).
- RC2 deadline tests 5/5 (12 s default-setting sum, COMMIT-only, within-budget positive, 15 s login with connect_timeout=30
  timeout and no late work, 7 s login under the 5 s default connect timeout, wrong password RUNTIME_NOT_READY, actual CLI
  exit 1), RC1 budget/maintenance/fence (runner facts, 1 s lock, audit failure, slow-login budget, Connection UPDATE orders,
  both deadlock victims, admission denials, single use, revocation, ten misconfigurations, BUSY, NO_STATE, bound, fence and
  runner tamper), read, API and CLI journeys all pass on the final transport (`focused-rc3-run1.log`, `focused-rc3-run2.log`).

## Checks

Focused during repair: reviewer probes (`reviewer-probes-rc3-run1.log`), `focused-rc3-run1.log` (30/33, the three CLI
failures below), `focused-rc3-run2.log` (CLI/API/deadline 14/14 after the test-support fix), `inherited-run1.log` (4/4), all
under `/tmp/atlas-stage4/s4c-rc3-scratch/`. Final required run on the corrected source
`/tmp/atlas-stage4/s4c-tools/checks.sh rc3-final`, logs `/tmp/atlas-stage4/s4c-checks/rc3-final/` (10:42:31Z–10:45:19Z), all
11 exit 0: npm test **217/217**, schema:validate, db:generate, typecheck, api:build, api:smoke, test:pg **558/558** (554 + 4
new; 146 s), db:check:pg17, db:check:drift, git diff --check, untracked-whitespace. Earlier `rc1-final`/`rc2-final` logs are
retained. This report was completed after the run (documentation only); diff/whitespace checks were re-run on it.

## Failed attempts (preserved)

1. First focused run on the new transport: 3 CLI tests failed (`focused-rc3-run1.log`) — the test-only network trap recorded
   the runner's own database socket (`net.Socket.connect`; Prisma's native engine had been invisible to it) and its
   synchronous throw ended the child without JSON. Fixed in test support by allowing exactly the paired DB endpoint; no
   production change. The API, which still uses only Prisma, keeps the full trap.
2. Design adjustment before tests: overriding a stricter inherited timeout with ~9.75 s would loosen an operator policy;
   the runner now takes the stricter of inherited and contract values.
No in-transaction re-anchor was attempted (rejected by the RC2 diagnosis and the review).

## Residual risks and qualifications

- Packaging residual CLOSED (see "Packaging completion"): `pg` 8.23.1 is now a runtime dependency. The runner still loads it
  lazily, so a broken installation refuses cleanup with RUNTIME_NOT_READY instead of affecting other commands.
- The runner keeps only two Prisma URL options (`schema` → search_path, `connect_timeout`); `pg` additionally honors the
  standard libpq-style options it parses (`sslmode`, `options` startup parameters…); Prisma pool options are irrelevant
  for a single connection. The URL is still the paired runtime URL with runner credentials, compared in full first.
- Up to 250 ms of the budget is unused by the server; setup slower than 250 ms fails closed. PostgreSQL's atomic commit point
  (interrupts held while writing the commit record) and a lost COMMIT acknowledgement (unknown outcome, no retry) remain.
- Inherited idle-in-transaction/statement settings stricter than ours can end a cleanup earlier (fail closed, rollback).
- Requires PostgreSQL 17 (`transaction_timeout`). Test-only DB-local settings/objects (role-in-database and database
  settings of the disposable runner/database, startup options in test URLs, PUBLIC-revoked delay triggers and a login event
  trigger) are reset/dropped in `finally` and with the disposable database.
- RC1/RC2 qualifications on constructed deadlocks, reads/admission waiting on the fence without lock_timeout, per-read audit
  rows and the 1000-attempt cap are unchanged.

## Packaging completion (Codex-authorized after the rc3-final run; package.json and package-lock.json only)

Change: the existing pinned `"pg": "8.23.1"` moved from `devDependencies` to `dependencies` in `package.json` (no version
change; `@types/pg` 8.23.1 stays a devDependency because it is types-only). `package-lock.json` was regenerated with
`npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund` (exit 0), then inspected structurally
against a byte backup: the root entry moves `pg` from devDependencies to dependencies, and exactly 13 entries of pg's
runtime tree lose `"dev": true` (`pg`, `pg-cloudflare` (still optional), `pg-connection-string`, `pg-int8`, `pg-pool`,
`pg-protocol`, `pg-types`, `pgpass`, `postgres-array`, `postgres-bytea`, `postgres-date`, `postgres-interval`, `split2`).
No version, `resolved` URL or `integrity` hash changed; lockfileVersion 3, top-level keys, name and version unchanged; no
package was added or removed. npm also wanted to rewrite the lockfile's stale root `"version": "1.0.0"` to `"1.1.3"`
(pre-existing mismatch with package.json); those two lines were restored to `1.0.0` so the delta is classification only —
an idempotency re-run in a temporary copy confirms that is the only further change npm would make.
SHA-256 before → after: package.json `bd7b63fe…4cacb2` → `84dbb495…161179`, package-lock.json `5449366f…f660a6` →
`646477af…3c05fb` (backups and the exact lock diff in
`/tmp/atlas-stage4/s4c-rc3-packaging/`).

Installed dependency bytes: unchanged — no file under `node_modules/` changed except npm's own hidden metadata
`node_modules/.package-lock.json`, which `--package-lock-only` rewrote; it now equals `package-lock.json` for all 163 entries
(pg no longer marked dev). Installed `pg` files (e.g. `pg/package.json`, `pg/lib/client.js`) keep their bytes.

Focused verification (logs in `/tmp/atlas-stage4/s4c-rc3-packaging/`): `npm ls pg --omit=dev` resolves `pg@8.23.1` (exit 0),
`@types/pg` absent from the production tree, `npm ls --all` and `--all --omit=dev` exit 0; an isolated production install
(`npm ci --omit=dev --ignore-scripts --offline` in a temporary copy of package.json + package-lock.json) exits 0, contains
pg's runtime tree and no `@types/pg`, and a dynamic `import('pg')` there yields `Client` from pg 8.23.1; `npm run typecheck`
exit 0; `npm test` 217/217; the actual-PG17 `tests/pg/poweroffice-maintenance.pg.test.ts` (live runner path through the lazy
`pg` import: positive cleanup, misconfiguration incl. wrong password, BUSY, bounds) 6/6; `git diff --check` clean. Source
code is unchanged by the reclassification, so the full eleven-check `rc3-final` run (217/217 + 558/558) was not repeated;
its logs are retained unchanged.

