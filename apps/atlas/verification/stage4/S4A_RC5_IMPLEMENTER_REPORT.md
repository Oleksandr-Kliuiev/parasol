Runtime readiness now refuses every grant option on the three PowerOffice tables, and the single final `checks.sh rc5` passed all 11 steps. This report is not acceptance: root seals RC5 for a fresh Astra/xhigh review.

## The fix (`packages/graph/poweroffice-role.ts`)
Two checks were added to the runtime grant check used by both the full startup readiness and every PowerOffice admission. They refuse any effective grant option held by the runtime (direct, derived from the table, or inherited) on:
- **Tables:** any of the eight PG17 table privileges on State, Attempt or Snapshot.
- **Columns:** SELECT, INSERT, UPDATE or REFERENCES on every column of those tables.

This covers options on otherwise-approved privileges too: table SELECT/INSERT, column SELECT/INSERT, and the approved mutable-column UPDATE. The approved grants, the existing forbidden-privilege checks, MAINTAIN, the all-tablespace check and the Stage 2/3 checks are unchanged.

A negative control on a rolled-back table SELECT grant option on Snapshot shows the RC4 version counted 0 violations and the repaired one counts 13 (log `grant-option-negative-control.log`).

## Regression (`tests/pg/poweroffice-grant-options.pg.test.ts`)
- **How each case runs:** inside one owner transaction that always rolls back. The full startup facts are evaluated as the runtime (with `session_user` and `current_user` both the runtime) and must refuse, as must the per-admission facts. An observer session never sees the change.
- **Matrix completeness:** the test asserts the tables have 43 columns and 15 approved mutable UPDATE columns (State 12, Attempt 3, Snapshot 0).
- **Table options:** SELECT and INSERT WITH GRANT OPTION on each of the three tables (6 cases). The production provisioning body then removes the option and the exact approved ACLs return.
- **Column options:** SELECT and INSERT WITH GRANT OPTION on each of the 43 columns (86 cases), then one all-columns case per table that provisioning restores.
- **UPDATE options:** WITH GRANT OPTION on each of the 15 approved mutable columns, then one case per table that provisioning restores.
- **Controls:** re-granting approved privileges without options stays healthy. Column REFERENCES, immutable UPDATE and MAINTAIN are still refused.

## Checks
Focused logs are in `/tmp/atlas-stage4/s4a-repair4-work/`.
- **Focused:**
  - typecheck exit 0;
  - PGlite and policy tests 29/29;
  - `npm test` 196/196;
  - 120/120 PostgreSQL tests across all PowerOffice tests plus the Stage 2/3 fence, guard, requests, signers, non-superuser, upgrade, routine-ACL, privileges and roles-output tests.
- **Final `rc5`** (`/tmp/atlas-stage4/s4a-checks/rc5/`): `npm test` 196/196, `test:pg` 475/475, all 11 steps exit 0. Earlier runs are untouched.
- No failures occurred in this phase.
- Every grant in this phase was rolled back; nothing shared or PUBLIC was committed. There were no host, tablespace or credential operations, and scratch scripts stayed in `/tmp/atlas-stage4/s4a-repair4-scratch/`.

## Changed paths from the repair4 baseline
- **Changed:** `packages/graph/poweroffice-role.ts` (185 lines).
- **Added:** `tests/pg/poweroffice-grant-options.pg.test.ts` (95 lines).
- The repo's `verification/stage4/S4A_RC5_REPAIR_BASELINE.json` is root's receipt, not mine.
- Nothing else changed: no migrations, docs, status or evidence.

**Not touched:** runtime grant options on the accepted Stage 2/3 tables, since the finding covered only the three PowerOffice tables. S4-B, S4-C and LIVE remain deferred.

I'm stopping at S4-A and returning sole checkout write ownership to Codex.