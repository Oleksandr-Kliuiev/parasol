RC2 findings F1–F3 are repaired, and the single final run `checks.sh rc3` passed all 11 steps. This report is not acceptance: root still reviews and seals RC3 for a fresh Astra/xhigh gate. Work was done natively by claude-opus-5-5 at high effort, same session, no API or credits.

**Root cause, common to all three findings:** the readiness checks and `roles.sql` enumerated only `current_schema`/`public` and skipped every namespace starting with `pg_`. The new rule treats only built-in objects (OID below 16384) as trusted. Every other relation, column, sequence, routine, type and namespace counts as a user object, in any schema and including user-created objects in `pg_temp_N` of any session. Allowlisted relations match only their exact `public."<name>"` identity.

**Changed paths from the repair2 baseline (all under 430 lines):**
- New: `packages/graph/poweroffice-surface.ts` and `tests/pg/poweroffice-surface.pg.test.ts`.
- Changed: `packages/graph/poweroffice-role.ts`, `prisma/roles.sql`, `tests/pg/poweroffice-nonsuper.pg.test.ts`.
- No migration, grant contract or shared-helper list changed, and no docs, status, evidence or frozen files were touched.

## How each finding closes
**What readiness now checks, for each role separately:**
- **F1 (relations):** the definer keeps only its exact `public.*` table/column allowlist and the runner gets nothing. No sequences, no ownership of any user relation or type, and no grant option anywhere.
- **F2 (routines):** EXECUTE only on the cleanup capability plus the existing shared invoker helpers reached through PUBLIC. No SECURITY DEFINER or temp routine, and no explicit grant.
- **F3 (schemas):** no schema ownership, and no effective CREATE anywhere, whether explicit, through PUBLIC or inherited. Explicit schema grants are allowed only on `public`.

**What provisioning (`roles.sql`) now does:**
- It revokes every explicit table, column, sequence, routine and schema grant to either role on any user object. Each revoke runs as the grant's recorded grantor (PG17 refuses `REVOKE … GRANTED BY` for anyone else), inside a subtransaction.
- It then runs a complete postcondition and refuses the whole provisioning transaction if anything remains: PUBLIC or inherited paths, ownership, or another grantor this owner can't act for. Nothing is transferred, dropped or rewritten globally.

**Regressions:** each case first proves the access path is real, then checks readiness flags exactly the role that holds it, then checks provisioning revokes it or refuses.
- **F1:** foreign view, column-only grant, same-name foreign table, foreign sequence, a grant option on an allowed relation (plain privilege kept), another grantor (revoked), PUBLIC and inherited paths (refused, then repaired).
- **F2:** the reviewer's temp SECURITY DEFINER routine, called from the separate runner session with the owner session kept open, for each role (revoked). The same for a temp routine of a second open owner session (revoked). PUBLIC EXECUTE plus PUBLIC schema USAGE is refused.
- **F3:**
  - CREATE on `public` or a foreign schema for each role, and explicit foreign USAGE: revoked.
  - Definer schema ownership, PUBLIC CREATE and inherited CREATE: provisioning refuses and the ownership is left as found.
  - The non-superuser owner revokes its own foreign grants and ends healthy.

## Decisions for root to confirm
- **PUBLIC USAGE on another schema is not flagged.** An accepted Stage 3 fence test expects a schema with only PUBLIC USAGE (no reachable objects) to be healthy. So that alone doesn't fail readiness, but explicit USAGE grants to these roles outside `public` do. USAGE gives no object access by itself, and every object path is checked by effective privilege. If you read the brief's "only explicitly required USAGE" as also covering PUBLIC, that rule and the accepted Stage 3 test would conflict.
- **The session's own temp schema is checked by its explicit ACL.** In the session that owns a temp schema, PostgreSQL reports full privileges on it to any role with database TEMP (PUBLIC by default). Provisioning runs in such a session, so there I check the schema's explicit ACL (the role, or PUBLIC CREATE) instead of effective privileges. Everywhere else the effective check applies.
- **Database-level TEMP is left unchanged.** It is a global PUBLIC privilege. Anything either role creates with it is still a user object covered by these checks.

## Checks and failures
Focused logs are in `/tmp/atlas-stage4/s4a-repair2-work/`.
- **Focused, final source:** typecheck exit 0; `npm test` 196/196; 101/101 PostgreSQL tests across all PowerOffice tests plus the Stage 2/3 fence, guard, requests, non-superuser, upgrade, routine-ACL, privileges and roles-output tests.
- **Final `rc3`** (`/tmp/atlas-stage4/s4a-checks/rc3/`): `npm test` 196/196, `test:pg` 461/461, and all other steps exit 0. Earlier rc2 logs are untouched.
- **Failures on the way, all diagnosed, all kept in logs:**
  - Two SQL defects caught before the regressions ran: an alias collision in the readiness SQL, and the planner evaluating `has_sequence_privilege` on non-sequences.
  - `surface-1`: `GRANTED BY` is rejected unless the grantor is the current user, so revokes now run as that grantor.
  - `surface-2`: phantom privileges from the provisioning session's own temp schema, fixed by the explicit-ACL rule above.
  - `focused-pg.log`: two Stage 3 fence tests failed. The new postcondition fired before the accepted fence check (so the message differed); I moved it last in step 5. A remaining failure then came from the PUBLIC USAGE rule, resolved as described above.

**Still deferred:** S4-B services, S4-C API/CLI/maintenance wrapper, and LIVE.

I'm stopping at S4-A and returning sole checkout write ownership to Codex now.