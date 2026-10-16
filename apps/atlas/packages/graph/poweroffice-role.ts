/**
 * Readiness facts of the Stage 4 PowerOffice surface (docs/stage4/03_DATA_AND_CONCURRENCY.md "Exact roles and scope"):
 * the three FORCE-RLS tables with their exact PUBLIC scope policy and RESTRICTIVE three-ID maintenance policy, the guard
 * and deferred commit triggers, the confined cleanup routine (SECURITY DEFINER, owned by its NOLOGIN definer, EXECUTE for
 * exactly one confined runner), the definer's exact privileges and the runtime's exact grants. Prisma-free SQL fragments,
 * evaluated for the CURRENT role as `r` — in the runtime startup check (runtime-role.ts) and by every PowerOffice
 * admission (POWEROFFICE_READY_SQL). Any drift (a broad default grant, a PUBLIC routine, a missing or permissive maintenance
 * policy, a disabled trigger, an extra definer privilege) fails closed until prisma/roles.sql runs or the schema is repaired.
 *
 * Maintenance-role capability surface (RC1 F1, RC2 F1–F3): relations/columns/sequences, routines (temporary ones
 * included), namespace CREATE/USAGE/ownership, object ownership and grant options of BOTH roles across every user object
 * (poweroffice-surface.ts). The shared invoker helper list is reused, never widened.
 * Binding invariant (RC1 F3): Connection_poweroffice_binding_check must exist, be validated and have its exact definition.
 */
import { POWEROFFICE_SURFACE_CTES, surfaceViolations } from './poweroffice-surface.ts';

export const POWEROFFICE_TABLES: readonly string[] = ['PowerOfficeState', 'PowerOfficeAttempt', 'PowerOfficeSnapshot'];
/** The paired synthetic binding CHECK on Connection (migration 202610091200) and its pg_get_constraintdef rendering. */
export const POWEROFFICE_BINDING_CHECK = 'Connection_poweroffice_binding_check';
export const POWEROFFICE_BINDING_CHECK_DEF = `CHECK (COALESCE(((system <> 'poweroffice'::text) OR ("externalTenantId" !~ `
  + `'^synthetic-po-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) OR ("secretRef" = `
  + `('fixture://poweroffice/'::text || substr("externalTenantId", 14)))), false))`;
export const POWEROFFICE_CLEANUP_ROUTINE = 'atlas_poweroffice_cleanup';
export const POWEROFFICE_CLEANUP_ARGS = 'p_workspace text, p_client text, p_connection text, p_correlation uuid';
/** Runtime: SELECT + INSERT on all three; UPDATE only of these columns (State operational pointers/outcomes, Attempt terminal). */
export const POWEROFFICE_RUNTIME_UPDATE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PowerOfficeState: ['nextSequence', 'activeAttemptId', 'snapshotId', 'snapshotVersion', 'lastAttemptId', 'lastAttemptState', 'lastAttemptErrorCode',
    'lastCompletedAttemptId', 'lastCompletedState', 'lastCompletedErrorCode', 'lastSuccessAt', 'updatedAt'],
  PowerOfficeAttempt: ['state', 'completedAt', 'safeErrorCode'],
  PowerOfficeSnapshot: [],
});
/** The PowerOffice cleanup definer's EXACT privileges on every relation of the schema: table level, then column level. */
export const POWEROFFICE_DEFINER_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PowerOfficeState: ['SELECT'], PowerOfficeAttempt: ['SELECT', 'DELETE'], PowerOfficeSnapshot: ['SELECT', 'DELETE'], AuditEvent: ['INSERT'],
});
export const POWEROFFICE_DEFINER_COLUMN_PRIVILEGES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  ActionAuthorityFence: { SELECT: ['workspaceId'], UPDATE: ['workspaceId'] },
  Connection: { SELECT: ['id', 'workspaceId', 'clientId', 'system', 'externalTenantId', 'status', 'boundBy', 'boundAt', 'lifecycleVersion'] },
  PowerOfficeState: { UPDATE: ['snapshotId', 'snapshotVersion', 'updatedAt'] },
});
/** pg_get_expr renderings of the two policies every PowerOffice table carries (migration 202610091200, prisma/roles.sql §3b). */
export const POWEROFFICE_SCOPE_QUAL = '(("workspaceId" = atlas_app_workspace()) AND ("clientId" = ANY (atlas_app_clients())))';
export const POWEROFFICE_MAINTENANCE_QUAL = '(("workspaceId" = atlas_app_workspace()) AND ("clientId" = ANY (atlas_app_clients())) AND '
  + `("connectionId" = NULLIF(current_setting('app.poweroffice_connection_id'::text, true), ''::text)))`;
const INVOKER_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
const DEFINER_SEARCH_PATH = 'search_path=pg_catalog, public';
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32.
type TriggerSpec = readonly [table: string, trigger: string, fn: string, tgtype: number, deferred: boolean];
export const POWEROFFICE_TRIGGERS: readonly TriggerSpec[] = [
  ['PowerOfficeState', 'state'], ['PowerOfficeAttempt', 'attempt'], ['PowerOfficeSnapshot', 'snapshot'],
].flatMap(([t, f]): TriggerSpec[] => [
  [t!, `${t}_guard`, `atlas_poweroffice_${f}_guard`, 31, false], [t!, `${t}_truncate`, `atlas_poweroffice_${f}_guard`, 34, false],
  [t!, `${t}_commit`, 'atlas_poweroffice_commit_check', t === 'PowerOfficeSnapshot' ? 5 : 21, true]]);

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const rows = (values: readonly (readonly (string | number | boolean)[])[]) =>
  values.map(v => `(${v.map(x => typeof x === 'string' ? q(x) : String(x)).join(',')})`).join(',');
const schemaRel = (alias: string) => `JOIN pg_namespace ${alias}n ON ${alias}n.oid = ${alias}.relnamespace AND ${alias}n.nspname = current_schema()`;
const definerTable = rows(Object.entries(POWEROFFICE_DEFINER_TABLE_PRIVILEGES).flatMap(([t, ps]) => ps.map(p => [t, p])));
const definerColumn = rows(Object.entries(POWEROFFICE_DEFINER_COLUMN_PRIVILEGES)
  .flatMap(([t, byPrivilege]) => Object.entries(byPrivilege).flatMap(([p, cols]) => cols.map(c => [t, p, c]))));
const runtimeUpdate = rows(Object.entries(POWEROFFICE_RUNTIME_UPDATE_COLUMNS).flatMap(([t, cols]) => cols.map(c => [t, c])));

/** CTE definitions (each preceded by a comma) to append to a WITH list. */
export const POWEROFFICE_CTES = `,
  po_tables(relname) AS (VALUES ${rows(POWEROFFICE_TABLES.map(t => [t]))}),
  po_present AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner FROM pg_class c ${schemaRel('c')}
                 WHERE c.relkind = 'r' AND c.relname IN (SELECT relname FROM po_tables)),
  po_functions AS (SELECT p.oid, p.proname, p.proowner, p.proacl, p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid) AS args
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = current_schema() AND p.proname LIKE 'atlas\\_poweroffice\\_%'),
  po_routine AS (SELECT * FROM po_functions WHERE proname = ${q(POWEROFFICE_CLEANUP_ROUTINE)}),
  po_owner AS (SELECT o.* FROM po_routine x JOIN pg_roles o ON o.oid = x.proowner),
  po_acl AS (SELECT a.grantee, a.privilege_type, a.is_grantable
               FROM (SELECT x.proowner, (aclexplode(coalesce(x.proacl, acldefault('f', x.proowner)))).* FROM po_routine x) a
              WHERE a.grantee <> a.proowner),
  po_definer_table(relname, priv) AS (VALUES ${definerTable}),
  po_definer_column(relname, priv, attname) AS (VALUES ${definerColumn}),
  po_update(relname, attname) AS (VALUES ${runtimeUpdate}),
  po_triggers(relname, tgname, fn, tgtype, deferred) AS (VALUES ${rows(POWEROFFICE_TRIGGERS)}),
  po_runners AS (SELECT DISTINCT a.grantee AS oid FROM po_acl a WHERE a.grantee <> 0),
  po_binding AS (SELECT k.oid FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid ${schemaRel('c')}
                 WHERE c.relname = 'Connection' AND k.conname = ${q(POWEROFFICE_BINDING_CHECK)} AND k.contype = 'c' AND k.convalidated
                   AND pg_get_constraintdef(k.oid) = ${q(POWEROFFICE_BINDING_CHECK_DEF)})${POWEROFFICE_SURFACE_CTES}`;

/** Select-list columns over `r` (pg_roles row of the current role). */
export const POWEROFFICE_COLUMNS = `
  ((SELECT count(*)::int FROM po_tables t LEFT JOIN po_present p ON p.relname = t.relname
     WHERE p.oid IS NULL OR NOT p.relrowsecurity OR NOT p.relforcerowsecurity)
   + CASE WHEN (SELECT count(*) FROM po_binding) = 1 THEN 0 ELSE 1 END) AS "poTableViolations",
  ((SELECT count(*)::int FROM po_present t JOIN pg_policy p ON p.polrelid = t.oid
     WHERE NOT ((p.polname = t.relname || '_scope' AND p.polpermissive AND p.polcmd = '*' AND p.polroles = ARRAY[0]::oid[]
                 AND pg_get_expr(p.polqual, p.polrelid) = ${q(POWEROFFICE_SCOPE_QUAL)} AND pg_get_expr(p.polwithcheck, p.polrelid) = ${q(POWEROFFICE_SCOPE_QUAL)})
             OR (p.polname = t.relname || '_maintenance' AND NOT p.polpermissive AND p.polcmd = '*'
                 AND p.polroles = ARRAY[(SELECT x.proowner FROM po_routine x LIMIT 1)]::oid[]
                 AND pg_get_expr(p.polqual, p.polrelid) = ${q(POWEROFFICE_MAINTENANCE_QUAL)}
                 AND pg_get_expr(p.polwithcheck, p.polrelid) = ${q(POWEROFFICE_MAINTENANCE_QUAL)})))
   + (SELECT count(*)::int FROM po_present t WHERE (SELECT count(*) FROM pg_policy p WHERE p.polrelid = t.oid) <> 2
        OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND NOT p.polpermissive))
  ) AS "poPolicyViolations",
  (SELECT count(*)::int FROM po_triggers e
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ${schemaRel('c')}
                        JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = current_schema()
                       WHERE c.relname = e.relname AND t.tgname = e.tgname AND p.proname = e.fn AND t.tgtype = e.tgtype AND NOT t.tgisinternal
                         AND t.tgenabled IN ('O', 'A') AND t.tgdeferrable = e.deferred AND t.tginitdeferred = e.deferred
                         AND (t.tgconstraint <> 0) = e.deferred)) AS "poTriggerViolations",
  ((SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END::int FROM po_routine)
   + (SELECT count(*)::int FROM po_routine x WHERE NOT x.prosecdef OR x.args <> ${q(POWEROFFICE_CLEANUP_ARGS)}
        OR x.proconfig IS DISTINCT FROM ARRAY[${q(DEFINER_SEARCH_PATH)}]::text[])
   + (SELECT count(*)::int FROM po_functions x WHERE x.proname <> ${q(POWEROFFICE_CLEANUP_ROUTINE)}
        AND (x.prosecdef OR x.args <> '' OR x.proconfig IS DISTINCT FROM ARRAY[${q(INVOKER_SEARCH_PATH)}]::text[]))
   + (SELECT count(*)::int FROM po_functions x WHERE has_function_privilege(r.oid, x.oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a WHERE a.grantee = 0))
  ) AS "poRoutineViolations",
  ((SELECT count(*)::int FROM po_owner o
     WHERE o.rolsuper OR o.rolbypassrls OR o.rolcanlogin OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication OR o.rolinherit
        OR o.oid = r.oid OR pg_has_role(r.oid, o.oid, 'MEMBER')
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = o.oid)
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = o.oid AND (m.inherit_option OR m.member NOT IN (SELECT relowner FROM po_present)))
        OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = o.oid)
        OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = o.oid AND p.oid NOT IN (SELECT oid FROM po_routine)))
   + (SELECT coalesce(sum(${surfaceViolations('o.oid', true)}), 0)::int FROM po_owner o)
  ) AS "poOwnerViolations",
  ((SELECT count(*)::int FROM po_owner o CROSS JOIN po_definer_table d LEFT JOIN po_user_rels c ON c.pub = d.relname AND c.relkind = 'r'
     WHERE c.oid IS NULL OR NOT has_table_privilege(o.oid, c.oid, d.priv))
   + (SELECT count(*)::int FROM po_owner o CROSS JOIN po_definer_column d LEFT JOIN po_user_rels c ON c.pub = d.relname AND c.relkind = 'r'
       WHERE c.oid IS NULL OR NOT has_column_privilege(o.oid, c.oid, d.attname, d.priv))
   + (SELECT count(*)::int FROM po_owner o WHERE NOT has_schema_privilege(o.oid, 'public', 'USAGE'))
   + CASE WHEN EXISTS (SELECT 1 FROM po_owner) THEN 0 ELSE 1 END) AS "poOwnerMissingGrants",
  ((SELECT count(*)::int FROM po_acl a LEFT JOIN pg_roles g ON g.oid = a.grantee
     WHERE a.grantee = 0 OR g.oid IS NULL OR a.privilege_type <> 'EXECUTE' OR a.is_grantable
        OR g.rolsuper OR g.rolbypassrls OR g.rolcreaterole OR g.rolcreatedb OR g.rolreplication OR g.rolinherit OR NOT g.rolcanlogin
        OR g.oid = r.oid OR pg_has_role(r.oid, g.oid, 'MEMBER')
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = g.oid OR (m.roleid = g.oid
             AND NOT (m.member IN (SELECT relowner FROM po_present) AND NOT m.set_option AND NOT m.inherit_option)))
        OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = g.oid))
   + CASE WHEN (SELECT count(DISTINCT grantee) FROM po_acl) = 1 THEN 0 ELSE 1 END
   + (SELECT coalesce(sum(${surfaceViolations('g.oid', false)}), 0)::int FROM po_runners g)
  ) AS "poExecuteViolations",
  ((SELECT count(*)::int FROM po_present p
     WHERE has_any_column_privilege(r.oid, p.oid, 'REFERENCES') OR has_table_privilege(r.oid, p.oid, 'TRIGGER')
        OR has_table_privilege(r.oid, p.oid, 'DELETE') OR has_table_privilege(r.oid, p.oid, 'TRUNCATE')
        OR has_table_privilege(r.oid, p.oid, 'MAINTAIN'))
   + (SELECT count(*)::int FROM po_present p JOIN pg_attribute a ON a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE has_column_privilege(r.oid, p.oid, a.attnum, 'UPDATE')
         AND NOT EXISTS (SELECT 1 FROM po_update u WHERE u.relname = p.relname AND u.attname = a.attname))
   -- No grant option at all (delegation authority), even on an otherwise approved privilege: every PG17 table privilege
   -- and every column privilege on every column, effective (direct, table-derived or inherited).
   + (SELECT count(*)::int FROM po_present p,
        (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(priv)
       WHERE has_table_privilege(r.oid, p.oid, v.priv || ' WITH GRANT OPTION'))
   + (SELECT count(*)::int FROM po_present p JOIN pg_attribute a ON a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped,
        (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(priv)
       WHERE has_column_privilege(r.oid, p.oid, a.attnum, v.priv || ' WITH GRANT OPTION'))
  ) AS "poRuntimeGrantViolations",
  ((SELECT count(*)::int FROM po_tables t LEFT JOIN po_present p ON p.relname = t.relname
     WHERE p.oid IS NULL OR NOT has_table_privilege(r.oid, p.oid, 'SELECT') OR NOT has_table_privilege(r.oid, p.oid, 'INSERT'))
   + (SELECT count(*)::int FROM po_update u LEFT JOIN po_present p ON p.relname = u.relname
       WHERE p.oid IS NULL OR NOT has_column_privilege(r.oid, p.oid, u.attname, 'UPDATE'))
  ) AS "poRuntimeMissingGrants"`;

/** The PowerOffice facts alone, for the current role: re-evaluated by every PowerOffice admission. */
export const POWEROFFICE_READY_SQL = `WITH unused AS (SELECT 1)${POWEROFFICE_CTES}
  SELECT ${POWEROFFICE_COLUMNS} FROM pg_roles r WHERE r.rolname = current_user`;

export interface PowerOfficeFacts {
  poTableViolations: number; poPolicyViolations: number; poTriggerViolations: number; poRoutineViolations: number;
  poOwnerViolations: number; poOwnerMissingGrants: number; poExecuteViolations: number; poRuntimeGrantViolations: number; poRuntimeMissingGrants: number;
}
/** Problems of the PowerOffice surface, as fixed reasons (empty = ready). Never echoes catalog values. */
export function powerOfficeProblems(facts: PowerOfficeFacts | undefined): string[] {
  if (!facts) return ['no PowerOffice facts'];
  const checks: [keyof PowerOfficeFacts, string][] = [
    ['poTableViolations', 'PowerOffice tables missing or without FORCE RLS, or the paired binding CHECK missing/unvalidated/altered'],
    ['poPolicyViolations', 'PowerOffice tables lack their exact scope and restrictive maintenance policies; run prisma/roles.sql'],
    ['poTriggerViolations', 'PowerOffice guard or commit triggers missing or disabled'],
    ['poRoutineViolations', 'PowerOffice routines are not the confined cleanup definer and PUBLIC-revoked trigger functions'],
    ['poOwnerViolations', 'PowerOffice cleanup owner is not the confined definer (privileges or routine surface); run prisma/roles.sql'],
    ['poOwnerMissingGrants', 'PowerOffice cleanup definer lacks its specified grants; run prisma/roles.sql'],
    ['poExecuteViolations', 'PowerOffice cleanup EXECUTE is not exactly the confined runner (or it can execute another routine); run prisma/roles.sql'],
    ['poRuntimeGrantViolations', 'runtime holds PowerOffice privileges (or grant options) outside the allowlist; run prisma/roles.sql'],
    ['poRuntimeMissingGrants', 'runtime lacks a PowerOffice grant; run prisma/roles.sql'],
  ];
  return checks.filter(([key]) => Number(facts[key]) !== 0).map(([, reason]) => reason);
}
