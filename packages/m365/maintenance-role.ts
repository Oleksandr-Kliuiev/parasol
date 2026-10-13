import { AtlasError } from '../core/contracts.ts';
import { CLEANUP_ROUTINE, DEFINER_COLUMN_PRIVILEGES, DEFINER_TABLE_PRIVILEGES, PROTECTED_TABLES } from '../graph/runtime-role.ts';

/**
 * Startup check of the cleanup RUNNER, run on the runner's own connection before any maintenance call (02 §6, brief RC3).
 * It reuses the definer/ACL specification of runtime-role.ts (DEFINER_*_PRIVILEGES, CLEANUP_ROUTINE, PROTECTED_TABLES) but
 * is NOT the runtime self-check (assertRuntimeRole is never called on the runner and the runtime check is unchanged):
 *   runner        LOGIN NOINHERIT, no SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION, not under SET ROLE, member of no
 *                 role, no member except the table owner's ADMIN-only creator link, owns nothing, and holds NO privilege on
 *                 any relation or sequence of the schema (no direct SELECT/DML) — but EXECUTE on the routine;
 *   routine       exists once, SECURITY DEFINER with a fixed search_path;
 *   definer       the routine owner is the confined NOLOGIN definer with exactly its specified table/column grants, not the
 *                 runner and not reachable from it (no SET ROLE path);
 *   ACL           besides the owner exactly one grantee — this runner — with EXECUTE and no grant option.
 */
const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');
const definerTable = Object.entries(DEFINER_TABLE_PRIVILEGES).flatMap(([t, ps]) => ps.map(p => `('${t}','${p}')`)).join(',');
const definerColumn = Object.entries(DEFINER_COLUMN_PRIVILEGES)
  .flatMap(([t, byPrivilege]) => Object.entries(byPrivilege).flatMap(([p, cols]) => cols.map(c => `('${t}','${p}','${c}')`))).join(',');

export const RUNNER_ROLE_CHECK_SQL = `
  WITH protected AS (SELECT unnest(ARRAY[${list(PROTECTED_TABLES)}]) AS relname),
       present AS (SELECT c.oid, c.relname, c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname IN (SELECT relname FROM protected)),
       schema_objects AS MATERIALIZED (SELECT c.oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')),
       routine AS (SELECT p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = current_schema() AND p.proname = '${CLEANUP_ROUTINE}'),
       routine_acl AS (SELECT a.grantee, a.privilege_type, a.is_grantable
                         FROM (SELECT x.proowner, (aclexplode(coalesce(x.proacl, acldefault('f', x.proowner)))).* FROM routine x) a
                        WHERE a.grantee <> a.proowner),
       definer AS (SELECT o.* FROM routine x JOIN pg_roles o ON o.oid = x.proowner),
       definer_table(relname, priv) AS (VALUES ${definerTable}),
       definer_column(relname, priv, attname) AS (VALUES ${definerColumn}),
       table_privs(priv) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
       column_privs(priv) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES'))
  SELECT r.rolsuper AS "superuser", r.rolbypassrls AS "bypassRls", (session_user <> current_user) AS "sessionRoleMismatch",
         ((r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit OR NOT r.rolcanlogin)::int) AS "attributeViolations",
         (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS "memberships",
         (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid
            AND NOT (m.member IN (SELECT relowner FROM present) AND NOT m.set_option AND NOT m.inherit_option)) AS "members",
         (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS "ownedRelations",
         -- CASE keeps each privilege function on the object kind it accepts (the planner may otherwise evaluate it first)
         (SELECT count(*)::int FROM schema_objects s WHERE CASE WHEN s.relkind = 'S' THEN has_sequence_privilege(r.oid, s.oid, 'USAGE, SELECT, UPDATE')
             ELSE has_any_column_privilege(r.oid, s.oid, 'SELECT') OR has_any_column_privilege(r.oid, s.oid, 'INSERT')
               OR has_any_column_privilege(r.oid, s.oid, 'UPDATE') OR has_any_column_privilege(r.oid, s.oid, 'REFERENCES')
               OR has_table_privilege(r.oid, s.oid, 'DELETE') OR has_table_privilege(r.oid, s.oid, 'TRUNCATE') OR has_table_privilege(r.oid, s.oid, 'TRIGGER') END)
           AS "relationPrivileges",
         (SELECT count(*)::int FROM routine) AS "routines",
         EXISTS (SELECT 1 FROM routine x WHERE has_function_privilege(r.oid, x.oid, 'EXECUTE')) AS "canExecute",
         EXISTS (SELECT 1 FROM routine x WHERE x.prosecdef AND EXISTS (SELECT 1 FROM unnest(x.proconfig) c WHERE c LIKE 'search_path=%')) AS "definerRoutine",
         ((SELECT count(*)::int FROM definer o
            WHERE o.rolsuper OR o.rolbypassrls OR o.rolcanlogin OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication
               OR o.oid = r.oid OR pg_has_role(r.oid, o.oid, 'MEMBER')
               OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = o.oid)
               OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = o.oid AND m.member NOT IN (SELECT relowner FROM present))
               OR EXISTS (SELECT 1 FROM present p WHERE pg_has_role(o.oid, p.relowner, 'MEMBER')))
          + (SELECT count(*)::int FROM definer o, present p, table_privs v
              WHERE has_table_privilege(o.oid, p.oid, v.priv) AND NOT EXISTS (SELECT 1 FROM definer_table d WHERE d.relname = p.relname AND d.priv = v.priv))
          + (SELECT count(*)::int FROM definer o, present p JOIN pg_attribute a ON a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped, column_privs v
              WHERE has_column_privilege(o.oid, p.oid, a.attnum, v.priv)
                AND NOT EXISTS (SELECT 1 FROM definer_table d WHERE d.relname = p.relname AND d.priv = v.priv)
                AND NOT EXISTS (SELECT 1 FROM definer_column d WHERE d.relname = p.relname AND d.priv = v.priv AND d.attname = a.attname))
         ) AS "ownerViolations",
         ((SELECT count(*)::int FROM definer o, definer_table d LEFT JOIN present p ON p.relname = d.relname
            WHERE p.oid IS NULL OR NOT has_table_privilege(o.oid, p.oid, d.priv))
          + (SELECT count(*)::int FROM definer o, definer_column d LEFT JOIN present p ON p.relname = d.relname
              WHERE p.oid IS NULL OR NOT has_column_privilege(o.oid, p.oid, d.attname, d.priv))) AS "ownerMissingGrants",
         ((SELECT count(*)::int FROM routine_acl a WHERE a.grantee <> r.oid OR a.privilege_type <> 'EXECUTE' OR a.is_grantable)
          + CASE WHEN (SELECT count(DISTINCT grantee) FROM routine_acl) = 1 THEN 0 ELSE 1 END) AS "executeViolations"
  FROM pg_roles r WHERE r.rolname = current_user`;

export interface RunnerRoleFacts {
  superuser: boolean; bypassRls: boolean; sessionRoleMismatch: boolean; attributeViolations: number; memberships: number; members: number;
  ownedRelations: number; relationPrivileges: number; routines: number; canExecute: boolean; definerRoutine: boolean;
  ownerViolations: number; ownerMissingGrants: number; executeViolations: number;
}
/** Fails closed with one fixed safe code; the failing fact name stays in the (safe, bounded) details only. */
export function assertConfinedRunner(facts: RunnerRoleFacts | undefined): void {
  const fail = (fact: string) => new AtlasError('M365_CLEANUP_RUNNER_NOT_CONFINED', 'PERMANENT', { fact });
  if (!facts) throw fail('noFacts');
  if (facts.superuser || facts.bypassRls) throw fail('bypassesRls');
  if (facts.sessionRoleMismatch) throw fail('sessionRoleMismatch');
  for (const fact of ['attributeViolations', 'memberships', 'members', 'ownedRelations', 'relationPrivileges', 'ownerViolations', 'ownerMissingGrants',
    'executeViolations'] as const) if (Number(facts[fact]) !== 0) throw fail(fact);
  if (Number(facts.routines) !== 1 || !facts.canExecute || !facts.definerRoutine) throw fail('routine');
}
