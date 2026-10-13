Both RC3 findings are repaired and the single final run `checks.sh rc4` passed all 11 steps. This report is not acceptance: root inspects and seals RC4, then a fresh Astra/xhigh review decides.

## R1 — MAINTAIN is now part of every table-privilege check
- **Maintenance roles:** MAINTAIN was added to the full table-privilege list in `poweroffice-surface.ts`, so both roles are checked for it on user and builtin relations. The same list in the `roles.sql` postcondition (both the user and builtin relation checks) now includes it too.
- **Runtime:** its exact-grant check on all three PowerOffice tables (State, Attempt, Snapshot) now refuses MAINTAIN, in `poweroffice-role.ts`.
- **Approved grants are unchanged.** Explicit MAINTAIN is revoked by provisioning, as before. PUBLIC MAINTAIN now fails readiness and makes provisioning refuse atomically; PUBLIC is never rewritten.
- **Negative control** (`maintain-negative-control.log`): the RC3 predicate counts 0 violations for an explicit MAINTAIN grant to the runner; the repaired one counts 1.
- **New `tests/pg/poweroffice-maintain.pg.test.ts`:**
  - Explicit MAINTAIN on a synthetic table, per maintenance role: no lock before; with MAINTAIN alone, `LOCK … ACCESS EXCLUSIVE` succeeds (the positive control). Readiness then flags that role only, provisioning revokes it, and the lock is refused with 42501.
  - Explicit MAINTAIN to the runtime on each of the three tables fails the full runtime assertion and is revoked. A Snapshot lock positive control shows the capability was real.
  - PUBLIC MAINTAIN on the synthetic table and on each of the three tables runs inside the rollback envelope. Both maintenance roles are flagged, and the runtime is too for the PowerOffice tables. The full startup assertion refuses (evaluated with `SET LOCAL SESSION AUTHORIZATION`, so there is no session/role mismatch), the production provisioning body refuses, an observer session never sees the grant, and everything rolls back.

## R2 — every tablespace is examined
- **Readiness:** a role may not own, or have effective CREATE (explicit, PUBLIC or inherited) on, any tablespace. When the catalog is readable, as on every real server, all tablespaces are enumerated. The one enumeration query is built at runtime with `query_to_xml`, because PostgreSQL checks permissions on every referenced table before execution, even in a branch that never runs.
- **PGlite limitation, handled explicitly:** PGlite denies its confined roles read access to `pg_tablespace` even though the ACL grants PUBLIC, and it rejects any GRANT on that catalog. So when the catalog is unreadable and `version()` identifies the Emscripten/PGlite build, readiness checks the only two tablespaces PGlite can have (`pg_default`, `pg_global`) by name. Unreadable on any other server fails closed.
- **Provisioning:** `roles.sql` reads `pg_tablespace` directly as the owner and refuses ownership or CREATE on any tablespace. The existing explicit-grant reset already covered all tablespaces.
- **Regression** (in `poweroffice-builtins.pg.test.ts`), inside the rollback envelope:
  - It asserts the cluster has exactly `pg_default` and `pg_global`.
  - Explicit CREATE on the non-default `pg_global` is shown to be invisible to the old `pg_default`-only check, is flagged per role, and is revoked by the provisioning body.
  - PUBLIC CREATE on `pg_global` is refused.
  - The observer and rollback snapshots confirm nothing is ever visible or kept.
- **What this doesn't do:** it doesn't create, alter, use or drop any real tablespace, and does nothing on the host. `pg_global` stands in for "non-default", through the same predicate that enumerates every row.

## Unexpected failures (logs kept)
- `pglite-1.log`: my first approach restored PUBLIC SELECT on `pg_tablespace` in the PGlite harness. PGlite rejects that GRANT ("tuple concurrently deleted"), which failed 19 tests. I reverted it, and `tests/support/pglite.ts` matches its baseline bytes again.
- Nothing else failed.

## Checks
Focused logs are in `/tmp/atlas-stage4/s4a-repair3-work/`.
- **Focused:** typecheck exit 0; `npm test` 196/196; 115/115 PostgreSQL tests across all PowerOffice tests plus the Stage 2/3 fence, guard, requests, signers, non-superuser, upgrade, routine-ACL, privileges and roles-output tests.
- **Final `rc4`** (`/tmp/atlas-stage4/s4a-checks/rc4/`): `npm test` 196/196, `test:pg` 470/470, all 11 steps exit 0. Earlier runs are untouched.
- **Scratch and data:** scratch scripts live only in `/tmp/atlas-stage4/s4a-repair3-scratch/`. No builtin was invoked, no credential row was read, and no shared or PUBLIC grant was ever committed.

## Changed paths from the repair3 baseline
- **Changed:** `packages/graph/poweroffice-surface.ts`, `packages/graph/poweroffice-role.ts`, `prisma/roles.sql` (still 474 lines), `tests/pg/poweroffice-builtins.pg.test.ts`, `tests/support/poweroffice-envelope.ts`.
- **Added:** `tests/pg/poweroffice-maintain.pg.test.ts`.
- `verification/stage4/S4A_RC4_REPAIR_BASELINE.json` also appears as a new file; that's root's receipt, not mine.
- No migration, docs, status, evidence or accepted Stage 2/3 source changed. All files are under 500 lines.

**Not touched:** the runtime's MAINTAIN on the accepted Stage 2/3 tables. Its startup checks for those tables were left as accepted, since R1 named only the PowerOffice tables. S4-B, S4-C and LIVE remain deferred.

I'm stopping at S4-A and returning sole checkout write ownership to Codex.