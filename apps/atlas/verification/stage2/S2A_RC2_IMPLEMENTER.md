Implementation handoff — NOT independent acceptance.

All four review findings (F1–F4) are fixed, and each has a permanent regression test that drives the scenario the review reproduced. Typecheck is clean, `npm test` passes 106/106, and the full `test:pg` passed twice on the same cluster (165, then 166 after one more case). No approved behaviour had to change, and S2-B was not started.

## Findings closure

**F1 — startup accepted forbidden SET ROLE paths.**
- **Behaviour:** the runtime self-check in `packages/graph/runtime-role.ts` now enforces what `prisma/roles.sql` already requires. The runtime must be LOGIN and NOINHERIT, with no CREATEROLE, CREATEDB or REPLICATION. It may not be a member of any role, which also closes transitive paths. Startup is refused if the check runs under SET ROLE from a different login.
- **Unchanged:** the migration owner's ADMIN-only links into the cleanup roles are still allowed, so non-superuser provisioning still passes.
- **PGlite helpers:** they now enter the runtime with `SET SESSION AUTHORIZATION`. PGlite ignores `RESET` and `DEFAULT` for this, so the helper restores the owner by name.
- **Test:** `tests/pg/m365-runtime-membership.pg.test.ts` (5/5). It covers:
  - a direct SET-only path to a BYPASSRLS role (the test shows SET ROLE really reaches all rows), and a transitive path through an intermediate role;
  - SET-only paths to DELETE on the audit table and to UPDATE of an immutable evidence column;
  - an inherited grant as the control case;
  - each attribute drift, and a session that switched into the runtime from another login;
  - `roles.sql` refusing the same memberships, and re-provisioning being accepted again.

**F2 — unlocked parent-state checks.** There is now one lock order, shared with the cleanup routine: Connection → resource state or sign-in window → generation or attempt → leaf → objects and memberships. It is documented before `atlas_m365_connection_fence` in `202610081000`.
- **Inserts** (object, membership, leaf, attempt, generation) lock their parents in that order and wait.
- **Updates** already hold their own row, so they take an earlier parent only with NOWAIT and fail with SQLSTATE 55P03 rather than risk a deadlock. A publisher that follows the order already holds those locks.
- **Publication** takes a share lock on the Connection row and checks ACTIVE status and `lifecycleVersion` under it. A concurrent disable or cleanup therefore either waits for the publication or makes it fail.
- **Revalidation:** after any wait, the trigger re-reads the committed state.
- **Counts:** attempt publication now requires `evidenceCount` and `leafCount` to equal the actual rows.
- **Siblings:** leaf inserts lock the attempt row exclusively, so concurrent sibling overlap checks and the 60-leaf cap see each other's rows.
- **Cleanup deletes** still read parents without locks; the definer has no UPDATE grant on those tables, and cleanup's lock on the Connection already keeps publishers out.
- **File split:** the sign-in triggers moved to the new migration `202610081150_stage2_m365_signin_triggers`, to keep files small.
- **Tests:** `tests/pg/m365-race-directory.pg.test.ts` (7/7) and `tests/pg/m365-race-signin.pg.test.ts` (6/6). Every ordering is forced by watching `pg_locks` until the loser is waiting — no sleeps — using the new `tests/support/pg-race.ts`. They cover:
  - object or membership insertion before publication, and publication before insertion;
  - leaf completion while a membership write is in progress;
  - disable versus directory and sign-in publication, in both orders;
  - the newest-attempt check for directories and for sign-in windows;
  - concurrent sibling leaves;
  - cleanup contention in both directions;
  - the ordinary publication path with mirror fill, under the exact production runtime grants.

**F3 — mapping freshness used a timestamp captured before lock waits.** `confirmLink` now takes a clock function and reads it inside the transaction after every lock is held, on each retry. That time is checked for freshness and expiry and persisted as `confirmedAt` and `reviewedAt`. Audit `recordedAt` stays on the database clock, as for all Stage 1 audit rows. Its only caller, the CLI, is unaffected.
- **Test:** `tests/pg/m365-confirm-clock.pg.test.ts` (3/3). The clock moves while `confirmLink` is provably blocked. Crossing 60 minutes is refused; crossing a 30-minute payload expiry is refused; a just-fresh case is confirmed with exactly one clock read, after the locks.

**F4 — DTO checks accepted `{}` through SQL NULL.** Both DTO checks now only accept rows that are positively valid, so `{}` or a missing field can no longer slip through as NULL. Required IDs must be typed strings; nullable fields, including `userType`, are accepted as explicit JSON null.
- **Tests:** shared PGlite and PG17 cases in `tests/m365-sql-invariants.ts`:
  - rejected: `{}`, missing or null ID, incomplete shapes, a bad `userType`, a null `createdDateTime`;
  - accepted: all-null optional fields for users, devices and sign-ins.

## Other test results
- `db:check:drift` and `db:check:pg17` pass.
- `git diff --check` is clean, and there is no trailing whitespace in new files.
- The Stage 1 `REVIEW_REPORT.md` hash and the RC5 package hash are unchanged; no historical migration changed.
- No test roles or databases were left on the cluster.

## Changed files
- **Migrations:** `202610081000_stage2_m365_directory`, `202610081100_stage2_m365_signin_windows`, and the new `202610081150_stage2_m365_signin_triggers`.
- **Source:** `packages/graph/runtime-role.ts`, `packages/graph/mapping.ts`.
- **Tests and helpers:**
  - modified: `tests/support/pglite.ts`, `tests/support/m365-fixtures.ts`, `tests/database.test.ts`, `tests/context-mapper.test.ts`, `tests/m365-sql-invariants.ts`;
  - new: `tests/support/pg-race.ts`, `tests/pg/m365-race-directory.pg.test.ts`, `tests/pg/m365-race-signin.pg.test.ts`, `tests/pg/m365-runtime-membership.pg.test.ts`, `tests/pg/m365-confirm-clock.pg.test.ts`.
- **Docs:** `docs/AI_CONTEXT_MAP.md`.

## Residual risks
- **Lock-order dependency:** the S2-B workers must follow the documented order. A writer that goes out of order fails fast with 55P03 rather than deadlocking; the order should become a worker contract in S2-B.
- **Leaf-update contention:** a leaf update fails fast while another transaction holds its attempt exclusively (for example a split or lease renewal). Workers on one attempt are expected to be serial.
- **Failure codes:** losers are refused rather than auto-retried. Retry policy for those codes belongs to the S2-B workers.
- **PGlite quirk:** session switching in PGlite relies on the explicit-name workaround above.
- **Superusers** remain outside these controls.
