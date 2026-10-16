Root's three confirmed issues are closed, and the single final run `checks.sh rc3-sealed` passed all 11 steps. This report is not acceptance.

## 1. Large objects and related ACL objects
I tried a single generic guard keyed on `pg_shdepend` first, but rejected it. PGlite's runtime role cannot read `pg_database`, so database-local rows can't be scoped reliably. PG17 also has no `has_largeobject_privilege` (it arrives in PG18). Probe log: `probe-catalogs.log`. Instead, readiness and the `roles.sql` postcondition now use focused catalog unions, and both maintenance roles are refused:
- **Large objects:** owning one; any ACL entry for the role or PUBLIC (grant options included); `lo_compat_privileges` turned on while any large object exists.
- **Foreign-data wrappers and servers:** owning one, or effective USAGE (explicit or PUBLIC).
- **User mappings:** any mapping for the role.
- **Default privileges:** any entry created by or naming the role.
- **Shared objects:** any ACL entry or ownership on a shared object (`pg_shdepend` with `dbid = 0`: database, tablespace, parameter).
- **Tablespace:** effective CREATE on `pg_default`.

Provisioning revokes the role's explicit large-object, FDW, server and tablespace entries, acting as the recorded grantor. It refuses atomically on PUBLIC grants, ownership, user mappings and default privileges; it never transfers, drops or rewrites globally. Inherited paths stay denied because any membership of these roles is refused.

Tests (`tests/pg/poweroffice-objects.pg.test.ts`):
- **Large objects:** the runner reads one synthetic byte in its own session; that grant is flagged per role and revoked, after which the read returns 42501. PUBLIC grants and definer ownership are refused, then repaired. `lo_compat_privileges` is tested session-locally inside the rollback envelope.
- **FDW/server:** metadata-only, NO HANDLER, a synthetic non-secret option, never connected. USAGE on the FDW and on the server is revoked per role. PUBLIC USAGE, a user mapping, server ownership and default privileges are refused, then repaired.

**What is not covered:** PUBLIC CREATE on a user-created tablespace other than `pg_default`. It can't be listed on PGlite, and creating real tablespaces was out of bounds. It is low-impact: placing objects there still needs schema or database CREATE, both of which are refused. Coverage is exactly the classes above; this is not a claim of full-cluster security.

## 2. Shared-catalog test isolation
Every builtin and shared-catalog drift case (parameter, database, tablespace, builtin routine/relation/column ACLs) now lives in `tests/pg/poweroffice-builtins.pg.test.ts` and is never committed.
- **New helper `tests/support/poweroffice-envelope.ts`:** it renders the production `roles.sql` and strips exactly its outer BEGIN/COMMIT. It first asserts the script has exactly one of each, a single `DO $roles$` block, and no transaction control outside that block.
- **How each case runs:** inside one owner transaction it applies the grant, computes readiness on the same connection under `SET LOCAL ROLE` (verified via `current_user`), and runs the provisioning body under a savepoint. The envelope always ends with ROLLBACK.
- **Proof of invisibility:** a separate observer session sees an unchanged shared-ACL snapshot while each drift is applied. The owner's snapshot is unchanged after rollback, and `pg_parameter_acl` has 0 rows at the end.
- **Data safety:** no builtin was invoked and no credential or password rows were read.
- **Where the full wrapper still runs:** database-local tests still use the complete production provisioning wrapper.

## 3. `sql_parts` and `transforms`
Extra PUBLIC SELECT on these two, like on the internal `_pg_*` views, is now refused, and an explicit grant to either role is revoked. Standard PUBLIC `information_schema` access (for example `information_schema.tables`) stays healthy, and that is asserted. PUBLIC USAGE on a schema by itself remains allowed, per the earlier decision.

## Checks
Focused logs are in `/tmp/atlas-stage4/s4a-repair2-closure-work/`.
- **Focused:** typecheck exit 0; `npm test` 196/196; 106/106 PostgreSQL tests (all PowerOffice tests plus the Stage 2/3 fence, guard, non-superuser, upgrade and role-output tests).
- **Final `rc3-sealed`:** `npm test` 196/196 and `test:pg` 466/466, with all 11 steps exit 0 (`/tmp/atlas-stage4/s4a-checks/rc3-sealed/`). No scratch file was in the repo during that run, and earlier rc3 and rc3-final logs are untouched.
- **Failures on the way, kept in logs:**
  - `builtins-1.log`: my body-shape validator wrongly treated PL/pgSQL `END;` as transaction control. I narrowed it to the text outside the DO block.
  - `builtins-2.log`: a baseline readiness call ran outside a transaction, so `SET LOCAL ROLE` had no effect. I wrapped it in the envelope and added an exact `current_user` guard.
  - While editing that guard, one replacement mangled the function. I rewrote it before running anything.

## Changed paths from the closure baseline
- **Changed:** `packages/graph/poweroffice-surface.ts` (113 lines), `prisma/roles.sql` (474), `tests/pg/poweroffice-surface.pg.test.ts` (its old committed builtin test was moved out).
- **Added:** `tests/pg/poweroffice-builtins.pg.test.ts`, `tests/pg/poweroffice-objects.pg.test.ts`, `tests/support/poweroffice-envelope.ts`.
- No migration, docs, status or evidence changed. S4-B, S4-C and LIVE remain deferred.

I'm stopping at S4-A and returning sole checkout write ownership to Codex.