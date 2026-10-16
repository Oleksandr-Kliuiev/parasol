# S4-C RC4 implementation report — runner phase map, setup cancellation and idle classification (Astra S4C-rc3 F1/F2)

Status: **IMPLEMENTED — PENDING fresh independent GPT-6 Astra/xhigh acceptance** (critical cancellation invariant).
S4C-rc1/rc2/rc3 are CHANGES_REQUIRED and were never accepted; LIVE remains **DEFERRED_BY_OWNER**. Not self-accepted; status,
manifests, seals and earlier reports/reviews/evidence unchanged. Same cohesive native Claude Code session
`02752ee0-ea51-4249-b089-d6aba4205d5d` (`claude-opus-5-5`, high, no subagents); preflight
`verification/stage4/S4C_RC4_REPAIR_PREFLIGHT.json`; baseline `S4C_RC4_REPAIR_BASELINE.json` (871 files hash-identical before
the first edit). Sections 1–2 were written first, before any code, as the diagnostic re-plan required.

## 1. Phase / failure map of the RC3 runner (diagnosis, before changes)

Budget origin for every row: ONE `performance.now()` deadline fixed in `runPowerOfficeCleanup` before the runner
connection exists (`startBudget`), never reset. "Server bound" = what makes PostgreSQL itself stop work; "client bound" =
what only stops the client from waiting.

| # | Phase (RC3) | Server cancellation in RC3 | Client bound in RC3 | Classification in RC3 | Late-effect exposure |
|---|---|---|---|---|---|
| P1 | connect / authentication / login (event triggers) | none possible: PostgreSQL sends the cancel key only after login completes (probe `cancel-probe.log`: key unknown during a login trigger); a closed socket is not noticed while login code runs, even with `client_connection_check_interval` (`check-interval-probe.log`) | pg `connectionTimeoutMillis` = min(budget, URL connect_timeout, 5 s default) destroys the socket | own connect timer / window → TIMEOUT; 28xxx, refused → RUNTIME_NOT_READY | no runner statement can exist; the backend finishes login code then exits |
| P2 | first setup query (inherited `pg_settings` read) — **RC3-F1** | **none**: no statement/lock/transaction timeout installed yet; inherited values may be 0 | **none**: the budget is only checked after the await returns | after release: window → TIMEOUT (13 521 ms) | backend active on a relation lock 3.5 s after the deadline (reviewer probe) — no domain effect, but unbounded |
| P3 | session timeout install (`set_config(…, false)`) and `pg_settings` readback | readback runs with our statement_timeout / 1 s lock_timeout once installed; the install itself has none | none until return | structured / window | as P2 for the install statement |
| P4 | BEGIN | arms the transaction timer with the session value | setup-duration guard ≤ 250 ms after return | own marker → TIMEOUT | none |
| P5 | body statements (readiness, GUCs, routine) | statement_timeout ≤ remaining, lock_timeout 1 s, transaction timer | budget check before each statement | structured SQLSTATE / window | none (server timer ≤ deadline) |
| P6 | client idle inside the transaction | transaction timer terminates the session | next statement's check | **RC3-F2**: pg surfaces a generic `Error` without SQLSTATE; with an inherited STRICTER timer the original-budget window is far away → CLEANUP_FAILED instead of TIMEOUT (1 512 ms) | none (server rolled back) |
| P7 | COMMIT | transaction timer (incl. deferred triggers); atomic commit point is the only window | awaited | structured / window | atomic commit point only |
| P8 | ROLLBACK / close after failure | n/a | best-effort ROLLBACK, `end()` | fixed code of the original failure | none |

Root causes: (a) RC3 relied on server-side timeouts that only exist AFTER the session settings are installed, so P2/P3 had
no server bound; client-side checks after an await cannot stop a backend that is waiting; (b) the classifier knew only the
original 10 s budget, not the EFFECTIVE (possibly stricter) server deadline it had itself armed at BEGIN, and did not retain
a structured terminal cause.

## 2. Repair plan (within the approved runner contract)

- A deadline WATCHDOG armed with the original budget before connect: at the deadline, if a client operation is in flight,
  it sends PostgreSQL's protocol CancelRequest for this backend (cancel key from the same connection; a separate short
  socket to the same paired endpoint; no role, privilege or grant), then a bounded grace backstop destroys the socket if
  the operation still does not settle. Probe: a CancelRequest ends a `pg_settings` lock wait with 57014 in ~200 ms and
  leaves the backend idle; a plain socket close leaves it waiting (`cancel-probe.log`). This bounds EVERY statement in P2–P8
  regardless of its wait class, not only the observed catalog lock.
- P2 becomes a relation-free `current_setting()` read; P3 installs statement/lock/transaction timeouts next, so every later
  setup statement is also server-bounded by statement_timeout / 1 s lock_timeout in addition to the watchdog.
- Classification keeps the effective server deadline (BEGIN send time + the armed, possibly stricter, transaction timeout)
  and the first structured terminal cause from the session's error events; a generic termination observed in the
  transaction AFTER that effective deadline is CLEANUP_TIMEOUT, before it stays the fixed non-timeout failure.
- P1 cannot be cancelled by any client before the server issues the cancel key; the socket is closed at the bound and this
  limit is reported as a residual (no privilege is added to work around it).

## 3. Changes

- NEW `packages/poweroffice/runner-cancel.ts`: protocol CancelRequest (16 bytes: length, 80877102, backend PID, secret key)
  on a separate short socket to the same paired endpoint; bounded, never rejects, no credential/role/privilege.
- `packages/poweroffice/runner-transaction.ts`: deadline watchdog (armed before connect from the original budget; cancel +
  2 s socket backstop for any in-flight operation, including operations started after the deadline such as ROLLBACK);
  relation-free first read (`current_setting` + `settingMs` parser, unknown form → RUNTIME_NOT_READY); statement/lock
  timeouts installed before the `pg_settings` readback; effective server deadline (`BEGIN` send time + the armed, possibly
  stricter, transaction timeout) and the session's first structured terminal cause feed `runnerFailure(error, budget,
  context)`. Single connection, pre-BEGIN session timers, stricter-inherited rule, 250 ms setup guard, 1 s lock, pairing and
  confinement (maintenance body unchanged), single-use admission, no retry — all unchanged. `maintenance.ts` unchanged.
- Tests: NEW `tests/pg/poweroffice-cleanup-phases.pg.test.ts` (4), NEW `tests/poweroffice-runner-phases.test.ts` (3).
- Routing/runbook: `packages/poweroffice/AGENTS.md`, `tests/pg/AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `docs/RUNBOOK.md` §10.
- Packaging unchanged (pg 8.23.1 runtime dependency from the RC3 completion).

## 4. Phase coverage after RC4

| # | Phase | Server cancellation | Client bound | Classification | Evidence |
|---|---|---|---|---|---|
| P1 | connect/login | none possible before the cancel key (residual) | connect timer ≤ budget; watchdog closes the socket | own timers → TIMEOUT; 28xxx → NOT_READY | RC2 deadline tests (15 s login TIMEOUT ≈10 s, CLI exit 1, no late work after the login ends); `check-interval-probe.log` |
| P2 | relation-free inherited read | watchdog CancelRequest | awaited settlement | 57014 / watchdog → TIMEOUT | watchdog test; `cancel-probe.log` (current_setting unaffected by a pg_settings lock) |
| P3 | install + `pg_settings` readback | statement_timeout, 1 s lock_timeout, watchdog | awaited | 55P03/57014 → TIMEOUT | F1 test: 1 011 ms TIMEOUT, no runner backend while the lock is still held |
| P4 | BEGIN | watchdog; arms the session timer | 250 ms guard | marker → TIMEOUT | inherited tests |
| P5 | body | statement_timeout, lock_timeout, transaction timer, watchdog | per-statement check | structured / watchdog | watchdog test with ALL server timers switched off: 57014 at 10 016 ms, backend gone |
| P6 | idle in transaction | transaction timer (effective, maybe stricter) | next check | generic loss after the effective deadline → TIMEOUT; earlier → FAILED | F2 test both ways; driver control proves only generic errors are available |
| P7 | COMMIT | transaction timer, watchdog | awaited | structured / watchdog | RC2/RC3 4+4+4 s default and inherited cases |
| P8 | ROLLBACK/close | watchdog backstop also for post-deadline operations | bounded | original failure's code | all timeout cases leave 0 runner backends |

## 5. Closure evidence (actual PostgreSQL 17.11, disposable DBs/roles, silent wrapper, absolute paths)

- Reviewer probes, unchanged (`/tmp/atlas-stage4/s4c-rc4-scratch/reviewer-probes-run1.log`): `admitted-setup-lock.mjs` now
  finds the cleanup SETTLED with NO runner backend at 13 512 ms while the lock is still held — its built-in assertion of the
  RC3 counterexample (`settled === false`) therefore fails (ERR_ASSERTION), which is the expected outcome on the repaired
  source; `idle-timeout.mjs` → POWEROFFICE_CLEANUP_TIMEOUT at 1 513 ms, 0 backends (its direct driver control still shows
  generic errors only); `inherited-timeout.mjs` → TIMEOUT 9 766 ms, nothing committed later; RC1 `budget-probes.mjs` →
  10 003 / 9 762 ms TIMEOUT, unchanged rows.
- `poweroffice-cleanup-phases.pg.test.ts` 4/4 (`phases-run2.log`): F1 through the real admitted wrapper → TIMEOUT at 1 011 ms
  (the 1 s lock timeout installed before the readback), lock held until 10.5 s, no runner backend and unchanged
  pointer/snapshots/attempts/audit while held and 1 s after release, then a positive cleanup COMPLETES; watchdog with
  statement/lock/transaction timers all disabled by a test-only body → 57014 TIMEOUT at 10 016 ms instead of the 30 s sleep,
  backend gone; F2 effective 1 s inherited timer + 1.5 s idle → TIMEOUT < 2.5 s, early `pg_terminate_backend` → CLEANUP_FAILED,
  0 backends; wrong password → RUNTIME_NOT_READY and the driver control (generic errors only).
- Negative control against the frozen RC3 source (`/tmp/atlas-stage4/S4C_RC3_SOURCE.zip`, absolute paths,
  `phases-negative-control-rc3.log`): 3/4 fail — F1 unsettled with the lock held, watchdog case 30 024 ms, F2 CLEANUP_FAILED;
  only the driver/password control passes.
- Unit 12/12 (`tests/poweroffice-{read,runner,runner-phases}.test.ts`); nearby PG 48/48 on RC4 (`nearby-rc4-run1.log`):
  maintenance, cleanup-budget (lock 1 s, audit failure, budget with slow login, Connection UPDATE orders, both deadlock
  victims), cleanup-deadline (default 4+4+4, COMMIT-only, within-budget commit, 15 s login, 7 s login, wrong password, CLI
  exit 1), cleanup-inherited (role/database/startup 30 s, stricter 2 s, looser 60 s lock), fence, CLI journey/privacy/network
  trap, API, reads.

## 6. Checks

Final required run on the final source `/tmp/atlas-stage4/s4c-tools/checks.sh rc4-final`, logs
`/tmp/atlas-stage4/s4c-checks/rc4-final/` (11:12:00Z–11:14:50Z), all 11 exit 0: npm test **220/220** (217 + 3 new),
schema:validate, db:generate, typecheck, api:build, api:smoke, test:pg **562/562** (558 + 4 new; 149 s), db:check:pg17,
db:check:drift, git diff --check, untracked-whitespace. Preserved failed run `/tmp/atlas-stage4/s4c-checks/rc4-final-failed1/`
(11:08:55Z): typecheck exit 2 — a test-only listener annotation in the new phase test (`(e: { code?: unknown })` where pg types
an `Error`); every other check exited 0 there (220/220, 562/562). Fixed by typing the listener parameter as `Error`; no source
change. Earlier rc1/rc2/rc3 logs retained. This report was completed after the final run (documentation only).

## 7. Failed attempts and diagnostics

1. Rejected options from probes before coding: a socket close alone leaves a lock-waiting backend active
   (`cancel-probe.log`); `client_connection_check_interval` as a startup option does not end a backend still in login code
   (`check-interval-probe.log`); the cancel key is not available during login. No code attempt failed on the phase
   behavior; the first implementation closed both reviewer probes and all nearby tests.
2. `rc4-final-failed1`: test-only typecheck error described in §6.

## 8. Residual risks and qualifications

- P1 login/authentication: PostgreSQL issues no cancel key before login completes, and the server does not notice a closed
  socket while login code (e.g. a login event trigger) runs. The runner closes its socket at the bound and cannot issue any
  statement on that backend, which finishes its login code and exits. Bounding server-side login code would need privilege
  or server configuration beyond the approved runner (`pg_signal_backend`/superuser) — not added.
- CancelRequest is unauthenticated by design and sent in clear text (as libpq ≤ 16 / node-pg); if it cannot be delivered the
  2 s backstop closes the socket; inside a transaction the server's own transaction timer still ends the work by the deadline.
- A generic connection loss AFTER the effective server deadline is classified as timeout (the runner cannot distinguish an
  unrelated coincident disconnect at that moment); before it, it stays CLEANUP_FAILED; a known structured non-timeout
  terminal cause is never relabelled.
- PostgreSQL's atomic commit point and a lost COMMIT acknowledgement (unknown outcome, no automatic retry) remain; the 250 ms
  reserve is unused by the server; PostgreSQL 17 is required.
- Test-only DB-local objects/settings (pg_settings ACCESS EXCLUSIVE lock in an uncommitted transaction rolled back in finally,
  role-in-database settings reset in finally, a test-only body that disables its own timers) live only in disposable
  databases. RC1–RC3 qualifications (constructed deadlocks, reads/admission waiting on the fence, per-read audit rows,
  1000-attempt cap) are unchanged.

