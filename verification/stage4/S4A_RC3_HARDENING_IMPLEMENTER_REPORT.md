Built-in objects (OID below 16384) are no longer trusted blindly for the two PowerOffice maintenance roles, and the single final `checks.sh rc3-final` passed all 11 steps. Root's `pg_read_file(text)` reproduction now fails readiness for each role, and provisioning revokes that grant. This report is not acceptance.

## How initial catalog privileges were verified
I read PG17's own metadata on disposable databases; no builtin was ever invoked. Logs are `initprivs-probe-2/3/4.log` in `/tmp/atlas-stage4/s4a-repair2-hardening-work/`.
- **Routines:** initdb records 62 builtin routines in `pg_init_privs` (privtype `i`) as owner-only, including `pg_read_file(text)` and `pg_ls_dir`. None of those records grants PUBLIC. Every builtin routine without a record has a NULL ACL, i.e. the default PUBLIC EXECUTE. In a fresh database, current ACLs equal the initial ones for all builtin routines.
- **Relations:** 159 relation rows and 17 column-level rows are recorded; `pg_authid`, `pg_shadow` and `pg_statistic` are owner-only. The only builtin relations without a record are in `information_schema`: 62 carry PUBLIC SELECT, and 7 are owner-only (`_pg_*` FDW/user-mapping views, `sql_parts`, `transforms`).
- **Readable by the runtime role:** `pg_init_privs` and `pg_parameter_acl` (which is empty by default).
- **Not readable on PGlite:** `pg_database`, as found when the PGlite suite failed. Database-level privileges are therefore checked through `has_database_privilege` instead.

## What readiness and provisioning now enforce, for each role separately
- **Explicit grants:** any explicit ACL entry for the role on a builtin routine, relation, column, type, language or configuration parameter is a violation, including grant options. Low OID or otherwise-PUBLIC status doesn't matter.
- **PUBLIC drift:** effective access to a builtin routine, relation or column must not exceed what PUBLIC held initially per `pg_init_privs`. A routine with no record allows its default PUBLIC EXECUTE.
- **Database and parameters:** no effective database CREATE. No parameter ACL entry for the role or for PUBLIC.
- **Provisioning:** it revokes the role's explicit entries on all of these, acting as each grant's recorded grantor. Its postcondition refuses the whole transaction on any PUBLIC or inherited remainder; global PUBLIC privileges and other roles are never changed.
- **Preserved:** all earlier user/temp/schema checks, the own-temp-namespace rule, the PUBLIC-USAGE compatibility decision, and the shared helper list.

## Regression (new test in `poweroffice-surface.pg.test.ts`)
- It first asserts the actual initial metadata: `pg_read_file` is recorded owner-only, and `lower` has no record.
- **Each role, revoked by provisioning back to the initial state:** EXECUTE on `pg_read_file(text)`; explicit EXECUTE with grant option on the otherwise-PUBLIC `lower(text)`; SELECT on `pg_authid`; column SELECT on `pg_authid.rolname`; SET on parameter `session_replication_role`; CREATE on the database.
- **Refused atomically and left as found, both roles flagged:** PUBLIC EXECUTE on `pg_read_file`, PUBLIC SELECT on `pg_authid`, PUBLIC SELECT on `information_schema._pg_user_mappings`, PUBLIC SET on that parameter. Each case is then repaired manually and provisioning succeeds again.
- Normal SQL (`lower`) and a shared helper still work for the runner, and the synthetic ApiToken/Connection counts are unchanged. Access is checked only with `has_*_privilege`.

## Remaining scope decision for root
For the two `information_schema` relations that are owner-only but have no initial record (`sql_parts`, `transforms`), metadata cannot prove the original grant. Unrecorded builtin relations may give a role SELECT only, never anything else, and never on the internal `_pg_*` views. So a later PUBLIC SELECT on `sql_parts` or `transforms` would not be detected. Both expose only SQL-standard catalog metadata. If root wants that closed too, it would need an explicit approved list, which I did not invent.

## Checks
Logs are in `/tmp/atlas-stage4/s4a-repair2-hardening-work/`.
- **Focused:** typecheck exit 0; `npm test` 196/196; 102/102 PostgreSQL tests across all PowerOffice tests plus the Stage 2/3 fence, guard, non-superuser, upgrade and role-output tests.
- **Readiness timing:** 16 ms for the PowerOffice readiness query and 26 ms for the full runtime check (`timing-before.log`).
- **Final `rc3-final`** (`/tmp/atlas-stage4/s4a-checks/rc3-final/`): `npm test` 196/196, `test:pg` 462/462, and all other steps exit 0. Earlier rc3 logs are untouched.
- **Failures on the way, kept in logs:**
  - My first metadata probe had a SQL type error (`initprivs-probe-1.log`).
  - The PGlite suite failed 4 tests because the runtime role can't read `pg_database` there; fixed as described above.
  - Provisioning slowed down (one test went from 0.46 s to 5.2 s). Restricting the effective checks to relations/columns that actually have an ACL brought it back down without changing semantics.
- **One honest note:** a scratch probe file, `.s4a-probe.ts`, sat untracked at the repo root during the `rc3-final` run. It was not imported by any check, all checks passed, and I've deleted it.

## Changed paths from the hardening baseline
`packages/graph/poweroffice-surface.ts`, `prisma/roles.sql` and `tests/pg/poweroffice-surface.pg.test.ts`. All are under 460 lines. No migration, docs, status or evidence changed. S4-B, S4-C and LIVE remain deferred.

I'm stopping at S4-A and returning sole checkout write ownership to Codex.