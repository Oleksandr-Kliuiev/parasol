import { FENCE_SHARED_INVOKER_ROUTINES } from './fence-role.ts';

/**
 * Readiness facts of the R-EVAL server RS-A surface (docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md
 * §5/§8), evaluated for the CURRENT role as `r` inside the shared runtime startup check (runtime-role.ts) in every Ask mode,
 * and alone as REVAL_READY_SQL. Mirrors prisma/roles/reval.sql: the two FORCE-RLS Reval tables with exactly their policies,
 * scoped foreign keys, contract CHECKs and the ALWAYS owner-only guard; exactly two atlas_reval_* routines (the SECURITY
 * DEFINER snapshot owned by the confined NOLOGIN evidence definer, the invoker guard owned by the table owner); EXECUTE on
 * the snapshot for exactly ONE grantee, the confined evidence-reader LOGIN; the runtime holds exactly the RS-B column SELECTs
 * (REVAL_RUNTIME_COLUMNS, rs-b brief B10) and nothing else on the Reval tables. Both new
 * roles: the complete effective capability surface (any schema, temporary objects, grant options, ownership, PUBLIC and
 * built-in escalation) with only the accepted PUBLIC SECURITY INVOKER helpers (fence-role.ts) beyond their allowlist.
 * Any drift fails closed until prisma/roles.sql runs again.
 */
export const REVAL_TABLES: readonly string[] = ['RevalSandboxRegistration', 'RevalFixtureBinding'];
const SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
/** The evidence definer's exact column SELECT allowlist (prisma/roles/reval.sql v_def_column). No table-level privilege. */
export const REVAL_DEFINER_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  RemoteAskPolicy: ['workspaceId', 'admissionId', 'projectIdentity', 'policyVersion', 'state', 'profile', 'priceRevision', 'reserveMicroUsd',
    'dayCapMicroUsd', 'monthCapMicroUsd', 'expiresAt'],
  RemoteAskClientAdmission: ['workspaceId', 'admissionId', 'clientId', 'state'],
  RemoteAskPeriodCounter: ['workspaceId', 'projectIdentity', 'kind', 'periodStart', 'chargedMicroUsd'],
  RemoteAskAttempt: ['workspaceId', 'id', 'clientId', 'actorId', 'admissionId', 'projectIdentity', 'policyVersion', 'profile', 'priceRevision',
    'promptRate', 'completionRate', 'correlationId', 'dayStart', 'monthStart', 'reservedMicroUsd', 'accountedMicroUsd', 'state', 'outcome',
    'createdAt', 'settledAt'],
  ActionAuthorityFence: ['workspaceId', 'version'],
  RevalSandboxRegistration: ['registrationId', 'databaseInstanceId', 'workspaceId', 'clientId', 'actorId', 'admissionId', 'evidenceReaderRoleOid',
    'datasetManifestSha256', 'buildManifestSha256', 'syntheticOnly', 'createdAt'],
  RevalFixtureBinding: ['registrationId', 'workspaceId', 'clientId', 'fixtureId', 'generation', 'syntheticFreshnessAt', 'datasetManifestSha256',
    'installedAt'],
});
/** RS-B (rs-b brief B10, 01 "Runtime receives only the needed SELECT columns"): the runtime's exact Reval column SELECTs. */
export const REVAL_RUNTIME_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  RevalSandboxRegistration: ['registrationId', 'databaseInstanceId', 'workspaceId', 'clientId', 'actorId', 'admissionId', 'datasetManifestSha256',
    'syntheticOnly'],
  RevalFixtureBinding: ['registrationId', 'workspaceId', 'clientId', 'fixtureId', 'generation', 'syntheticFreshnessAt', 'datasetManifestSha256'],
});
type ForeignKeySpec = readonly [table: string, name: string, columns: string, refTable: string, refColumns: string];
export const REVAL_FOREIGN_KEYS: readonly ForeignKeySpec[] = [
  ['RevalSandboxRegistration', 'RevalSandboxRegistration_client_fkey', 'workspaceId,clientId', 'Client', 'workspaceId,id'],
  ['RevalSandboxRegistration', 'RevalSandboxRegistration_actor_fkey', 'workspaceId,actorId', 'Actor', 'workspaceId,id'],
  ['RevalSandboxRegistration', 'RevalSandboxRegistration_policy_fkey', 'workspaceId,admissionId', 'RemoteAskPolicy', 'workspaceId,admissionId'],
  ['RevalSandboxRegistration', 'RevalSandboxRegistration_admission_fkey', 'workspaceId,admissionId,clientId', 'RemoteAskClientAdmission',
    'workspaceId,admissionId,clientId'],
  ['RevalFixtureBinding', 'RevalFixtureBinding_registration_fkey', 'registrationId,workspaceId,clientId,datasetManifestSha256',
    'RevalSandboxRegistration', 'registrationId,workspaceId,clientId,datasetManifestSha256'],
];
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. All ENABLE ALWAYS ('A').
type TriggerSpec = readonly [table: string, trigger: string, tgtype: number];
export const REVAL_TRIGGERS: readonly TriggerSpec[] = REVAL_TABLES.flatMap((t): TriggerSpec[] => [[t, `${t}_guard`, 31], [t, `${t}_truncate`, 34]]);
export const REVAL_SCOPE_QUAL = '("workspaceId" = atlas_app_workspace())';
/** pg_get_expr of the evidence definer's role-specific lookup policy (prisma/roles/reval.sql). */
export const REVAL_EVIDENCE_QUAL = '("evidenceReaderRoleOid" = ( SELECT (r.oid)::bigint AS oid\n   FROM pg_roles r\n  WHERE (r.rolname = SESSION_USER)))';

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const rows = (values: readonly (readonly (string | number | boolean)[])[]) =>
  values.map(v => `(${v.map(x => typeof x === 'string' ? q(x) : String(x)).join(',')})`).join(',');
const schemaRel = (alias: string) => `JOIN pg_namespace ${alias}n ON ${alias}n.oid = ${alias}.relnamespace AND ${alias}n.nspname = current_schema()`;
const colNames = (rel: string, keys: string) =>
  `ARRAY(SELECT a.attname::text FROM unnest(${keys}) WITH ORDINALITY u(attnum, ord) JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = u.attnum ORDER BY u.ord)`;
const definerColumns = rows(Object.entries(REVAL_DEFINER_COLUMNS).flatMap(([t, cols]) => cols.map(c => [t, c])));
const runtimeColumns = rows(Object.entries(REVAL_RUNTIME_COLUMNS).flatMap(([t, cols]) => cols.map(c => [t, c])));
const TABLE_PRIVS = `(VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN'))`;
const COLUMN_PRIVS = `(VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES'))`;

/** CTE definitions (each preceded by a comma) to append to a WITH list. */
export const REVAL_CTES = `,
  rv_tables(relname) AS (VALUES ${rows(REVAL_TABLES.map(t => [t]))}),
  rv_present AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner FROM pg_class c ${schemaRel('c')}
                 WHERE c.relkind = 'r' AND c.relname IN (SELECT relname FROM rv_tables)),
  rv_table_owner AS (SELECT c.relowner AS oid FROM pg_class c ${schemaRel('c')} WHERE c.relkind = 'r' AND c.relname = 'RemoteAskPolicy'),
  rv_functions AS (SELECT p.oid, p.proname, p.proowner, p.proacl, p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid) AS args
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = current_schema() AND p.proname LIKE 'atlas\\_reval\\_%'),
  rv_snapshot AS (SELECT f.* FROM rv_functions f WHERE f.proname = 'atlas_reval_snapshot' AND f.args = ''),
  rv_guard AS (SELECT f.* FROM rv_functions f WHERE f.proname = 'atlas_reval_guard' AND f.args = ''),
  rv_definer AS (SELECT o.* FROM pg_roles o WHERE o.oid = (SELECT s.proowner FROM rv_snapshot s LIMIT 1)),
  rv_snapshot_acl AS (SELECT a.grantee, a.privilege_type, a.is_grantable FROM rv_snapshot s,
                        aclexplode(coalesce(s.proacl, acldefault('f', s.proowner))) a WHERE a.grantee <> s.proowner),
  rv_reader AS (SELECT o.* FROM pg_roles o WHERE o.oid = (SELECT a.grantee FROM rv_snapshot_acl a LIMIT 1)),
  rv_definer_column(relname, attname) AS (VALUES ${definerColumns}),
  rv_runtime_column(relname, attname) AS (VALUES ${runtimeColumns}),
  rv_fks(relname, conname, cols, refrel, refcols) AS (VALUES ${rows(REVAL_FOREIGN_KEYS)}),
  rv_triggers(relname, tgname, tgtype) AS (VALUES ${rows(REVAL_TRIGGERS)}),
  rv_user_rels AS (SELECT c.oid, c.relkind, c.relowner, c.relacl, CASE WHEN n.nspname = 'public' THEN c.relname END AS pub
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid >= 16384 AND c.relkind IN ('r','p','v','m','f','S')),
  rv_user_routines AS (SELECT p.oid, quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
                              p.prosecdef, p.proowner, p.proacl
                       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid >= 16384),
  rv_shared(signature) AS (VALUES ${FENCE_SHARED_INVOKER_ROUTINES.map(r => `(${q(r)})`).join(',')}),
  rv_builtin_routines AS (SELECT p.oid, p.proacl, i.initprivs, i.objoid IS NOT NULL AS recorded FROM pg_proc p
                          LEFT JOIN pg_init_privs i ON i.objoid = p.oid AND i.classoid = 'pg_proc'::regclass AND i.objsubid = 0 WHERE p.oid < 16384),
  rv_builtin_rels AS (SELECT c.oid, c.relname, c.relacl, n.nspname, i.initprivs, i.objoid IS NOT NULL AS recorded FROM pg_class c
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                      LEFT JOIN pg_init_privs i ON i.objoid = c.oid AND i.classoid = 'pg_class'::regclass AND i.objsubid = 0
                      WHERE c.oid < 16384 AND c.relkind IN ('r','p','v','m','f','S'))`;

/** Tablespace ownership/CREATE (pg_tablespace is unreadable for non-superusers in in-memory PGlite; poweroffice-surface.ts). */
function tablespaceViolations(R: string): string {
  return `(CASE WHEN has_table_privilege('pg_catalog.pg_tablespace', 'SELECT')
      THEN (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM pg_catalog.pg_tablespace ts WHERE ts.spcowner = %s'
             || ' OR pg_catalog.has_tablespace_privilege(%s::oid, ts.oid, ''CREATE'')', ${R}, ${R}), false, true, '')))[1]::text::int
      WHEN pg_catalog.version() LIKE '%Emscripten%'
      THEN CASE WHEN has_tablespace_privilege(${R}, 'pg_default', 'CREATE') OR has_tablespace_privilege(${R}, 'pg_global', 'CREATE') THEN 1 ELSE 0 END
      ELSE 1 END)`;
}
/**
 * Number of capability violations of `R` (a SQL oid expression). `definer`: the evidence definer (its exact column SELECTs;
 * owns exactly the snapshot); otherwise the evidence reader (no relation privilege; EXECUTE on the snapshot by explicit
 * grant). Both: other routines only through PUBLIC on the exact accepted SECURITY INVOKER helpers.
 */
export function revalSurfaceViolations(R: string, definer: boolean): string {
  const allowedColumn = definer
    ? `EXISTS (SELECT 1 FROM rv_definer_column d WHERE d.relname = c.pub AND d.attname = a.attname AND v.priv = 'SELECT')` : 'false';
  return `(
    (SELECT count(*) FROM rv_user_rels c, ${TABLE_PRIVS} v(priv) WHERE c.relkind <> 'S' AND has_table_privilege(${R}, c.oid, v.priv))
    + (SELECT count(*) FROM rv_user_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL, ${COLUMN_PRIVS} v(priv)
        WHERE c.relkind <> 'S' AND has_column_privilege(${R}, c.oid, a.attnum, v.priv) AND NOT has_table_privilege(${R}, c.oid, v.priv) AND NOT ${allowedColumn})
    + (SELECT count(*) FROM rv_user_rels c WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(${R}, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END)
    + (SELECT count(*) FROM rv_user_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL, ${COLUMN_PRIVS} v(priv)
        WHERE c.relkind <> 'S' AND has_column_privilege(${R}, c.oid, a.attnum, v.priv || ' WITH GRANT OPTION'))
    + (SELECT count(*) FROM rv_user_rels c WHERE c.relowner = ${R})
    + (SELECT count(*) FROM pg_type t WHERE t.oid >= 16384 AND t.typowner = ${R})
    + (SELECT count(*) FROM rv_user_routines x WHERE x.proowner = ${R} AND ${definer ? 'x.oid NOT IN (SELECT oid FROM rv_snapshot)' : 'true'})
    + (SELECT count(*) FROM rv_user_routines x
        WHERE x.oid NOT IN (SELECT oid FROM rv_snapshot) AND has_function_privilege(${R}, x.oid, 'EXECUTE')
          AND (x.prosecdef OR x.signature NOT IN (SELECT signature FROM rv_shared)
               OR EXISTS (SELECT 1 FROM aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) e WHERE e.grantee = ${R})))
    + (SELECT count(*) FROM pg_namespace n WHERE n.nspowner = ${R}
        OR (n.oid IS DISTINCT FROM pg_my_temp_schema() AND has_schema_privilege(${R}, n.oid, 'CREATE'))
        OR EXISTS (SELECT 1 FROM aclexplode(n.nspacl) e WHERE (e.grantee = ${R} AND n.nspname <> 'public')
                     OR (n.oid = pg_my_temp_schema() AND e.grantee = 0 AND e.privilege_type = 'CREATE')))
    + (SELECT count(*) FROM (SELECT e.grantee, e.is_grantable FROM rv_user_rels c, aclexplode(c.relacl) e
         UNION ALL SELECT e.grantee, e.is_grantable FROM rv_user_rels c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) e
         UNION ALL SELECT e.grantee, e.is_grantable FROM rv_user_routines x, aclexplode(x.proacl) e WHERE x.proowner <> ${R}
         UNION ALL SELECT e.grantee, e.is_grantable FROM pg_namespace n, aclexplode(n.nspacl) e) g WHERE g.grantee = ${R} AND g.is_grantable)
    + (SELECT count(*) FROM rv_builtin_routines x WHERE EXISTS (SELECT 1 FROM aclexplode(x.proacl) e WHERE e.grantee = ${R})
        OR (x.recorded AND has_function_privilege(${R}, x.oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(x.initprivs) e WHERE e.grantee = 0 AND e.privilege_type = 'EXECUTE')))
    + (SELECT count(*) FROM rv_builtin_rels c WHERE EXISTS (SELECT 1 FROM aclexplode(c.relacl) e WHERE e.grantee = ${R})
        OR EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) e WHERE a.attrelid = c.oid AND e.grantee = ${R}))
    + (SELECT count(*) FROM rv_builtin_rels c, ${TABLE_PRIVS} v(priv) WHERE has_table_privilege(${R}, c.oid, v.priv)
        AND NOT CASE WHEN c.recorded THEN EXISTS (SELECT 1 FROM aclexplode(c.initprivs) e WHERE e.grantee = 0 AND e.privilege_type = v.priv)
                     ELSE c.nspname = 'information_schema' AND v.priv = 'SELECT' AND c.relname NOT LIKE '\\_pg\\_%'
                          AND c.relname NOT IN ('sql_parts', 'transforms') END)
    + (SELECT count(*) FROM rv_builtin_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
        LEFT JOIN pg_init_privs ci ON ci.objoid = c.oid AND ci.classoid = 'pg_class'::regclass AND ci.objsubid = a.attnum, ${COLUMN_PRIVS} v(priv)
        WHERE has_column_privilege(${R}, c.oid, a.attnum, v.priv) AND NOT has_table_privilege(${R}, c.oid, v.priv)
          AND NOT EXISTS (SELECT 1 FROM aclexplode(ci.initprivs) e WHERE e.grantee = 0 AND e.privilege_type = v.priv))
    + CASE WHEN has_database_privilege(${R}, current_database(), 'CREATE') THEN 1 ELSE 0 END
    + (SELECT count(*) FROM pg_parameter_acl pa, aclexplode(pa.paracl) e WHERE e.grantee IN (${R}, 0))
    + (SELECT count(*) FROM pg_language l, aclexplode(l.lanacl) e WHERE e.grantee = ${R})
    + (SELECT count(*) FROM pg_type t, aclexplode(t.typacl) e WHERE e.grantee = ${R})
    + (SELECT count(*) FROM pg_largeobject_metadata l WHERE l.lomowner = ${R} OR EXISTS (SELECT 1 FROM aclexplode(l.lomacl) e WHERE e.grantee IN (${R}, 0)))
    + CASE WHEN current_setting('lo_compat_privileges') = 'on' AND EXISTS (SELECT 1 FROM pg_largeobject_metadata) THEN 1 ELSE 0 END
    + (SELECT count(*) FROM pg_foreign_data_wrapper w WHERE w.fdwowner = ${R} OR has_foreign_data_wrapper_privilege(${R}, w.oid, 'USAGE'))
    + (SELECT count(*) FROM pg_foreign_server fs WHERE fs.srvowner = ${R} OR has_server_privilege(${R}, fs.oid, 'USAGE'))
    + (SELECT count(*) FROM pg_user_mappings um WHERE um.umuser = ${R})
    + (SELECT count(*) FROM pg_default_acl da WHERE da.defaclrole = ${R} OR EXISTS (SELECT 1 FROM aclexplode(da.defaclacl) e WHERE e.grantee = ${R}))
    + (SELECT count(*) FROM pg_shdepend sd WHERE sd.dbid = 0 AND sd.refclassid = 'pg_authid'::regclass AND sd.refobjid = ${R} AND sd.deptype IN ('a', 'o'))
    + ${tablespaceViolations(R)}
  )`;
}
/** Attribute/membership violations shared by both roles: `R` is a pg_roles row alias, `login` its required LOGIN. */
const roleShape = (R: string, login: boolean, setAllowed: boolean) => `(${R}.rolsuper OR ${R}.rolbypassrls OR ${R}.rolcanlogin <> ${login}
    OR ${R}.rolcreaterole OR ${R}.rolcreatedb OR ${R}.rolreplication OR ${R}.rolinherit OR ${R}.rolconfig IS NOT NULL
    OR ${R}.oid = r.oid OR pg_has_role(r.oid, ${R}.oid, 'MEMBER') OR pg_has_role(${R}.oid, r.oid, 'MEMBER')
    OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = ${R}.oid)
    OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = ${R}.oid
                 AND (m.inherit_option OR ${setAllowed ? 'false' : 'm.set_option'} OR m.member NOT IN (SELECT oid FROM rv_table_owner))))`;

/** Select-list columns over `r` (pg_roles row of the current role). */
export const REVAL_COLUMNS = `
  ((SELECT count(*)::int FROM rv_tables t LEFT JOIN rv_present p ON p.relname = t.relname
     WHERE p.oid IS NULL OR NOT p.relrowsecurity OR NOT p.relforcerowsecurity OR p.relowner IS DISTINCT FROM (SELECT oid FROM rv_table_owner)
        OR (SELECT count(*) FROM pg_policy x WHERE x.polrelid = p.oid) <> CASE t.relname WHEN 'RevalSandboxRegistration' THEN 2 ELSE 1 END
        OR NOT EXISTS (SELECT 1 FROM pg_policy x WHERE x.polrelid = p.oid AND x.polname = t.relname || '_scope' AND x.polpermissive AND x.polcmd = '*'
                         AND x.polroles = ARRAY[0]::oid[] AND pg_get_expr(x.polqual, x.polrelid) = ${q(REVAL_SCOPE_QUAL)}
                         AND pg_get_expr(x.polwithcheck, x.polrelid) = ${q(REVAL_SCOPE_QUAL)})
        OR (t.relname = 'RevalSandboxRegistration' AND NOT EXISTS (SELECT 1 FROM pg_policy x WHERE x.polrelid = p.oid
              AND x.polname = 'RevalSandboxRegistration_evidence' AND x.polpermissive AND x.polcmd = 'r'
              AND x.polroles = ARRAY[(SELECT oid FROM rv_definer)]::oid[] AND x.polwithcheck IS NULL
              AND pg_get_expr(x.polqual, x.polrelid) = ${q(REVAL_EVIDENCE_QUAL)}))
        OR NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = p.oid AND k.conname = t.relname || '_contract_check' AND k.contype = 'c' AND k.convalidated))
   + (SELECT count(*)::int FROM rv_fks e
       WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN rv_present p ON p.oid = k.conrelid AND p.relname = e.relname
                           JOIN pg_class rc ON rc.oid = k.confrelid ${schemaRel('rc')}
                          WHERE k.conname = e.conname AND k.contype = 'f' AND k.convalidated AND rc.relname = e.refrel
                            AND k.confdeltype = 'r' AND k.confupdtype = 'r'
                            AND array_to_string(${colNames('k.conrelid', 'k.conkey')}, ',') = e.cols
                            AND array_to_string(${colNames('k.confrelid', 'k.confkey')}, ',') = e.refcols))
  ) AS "rvTableViolations",
  ((SELECT count(*)::int FROM rv_triggers e
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ${schemaRel('c')} JOIN rv_guard g ON g.oid = t.tgfoid
                        WHERE c.relname = e.relname AND t.tgname = e.tgname AND t.tgtype = e.tgtype AND NOT t.tgisinternal AND t.tgenabled = 'A'))
   + (SELECT count(*)::int FROM pg_trigger t JOIN rv_present p ON p.oid = t.tgrelid WHERE NOT t.tgisinternal
       AND NOT EXISTS (SELECT 1 FROM rv_triggers e WHERE e.relname = p.relname AND e.tgname = t.tgname))
  ) AS "rvTriggerViolations",
  ((SELECT count(*)::int FROM rv_functions f WHERE f.oid NOT IN (SELECT oid FROM rv_snapshot) AND f.oid NOT IN (SELECT oid FROM rv_guard))
   + CASE WHEN (SELECT count(*) FROM rv_snapshot) = 1 AND (SELECT count(*) FROM rv_guard) = 1 THEN 0 ELSE 1 END
   + (SELECT count(*)::int FROM rv_snapshot s WHERE NOT s.prosecdef OR s.proconfig IS DISTINCT FROM ARRAY[${q(SEARCH_PATH)}]::text[])
   + (SELECT count(*)::int FROM rv_guard g WHERE g.prosecdef OR g.proconfig IS DISTINCT FROM ARRAY[${q(SEARCH_PATH)}]::text[]
       OR g.proowner IS DISTINCT FROM (SELECT oid FROM rv_table_owner)
       OR EXISTS (SELECT 1 FROM aclexplode(coalesce(g.proacl, acldefault('f', g.proowner))) a WHERE a.grantee <> g.proowner))
  ) AS "rvRoutineViolations",
  ((SELECT count(*)::int FROM rv_definer o WHERE ${roleShape('o', false, true)}
      OR o.oid = (SELECT oid FROM rv_table_owner) OR has_schema_privilege(o.oid, current_schema(), 'CREATE'))
   + (SELECT coalesce(sum(${revalSurfaceViolations('o.oid', true)}), 0)::int FROM rv_definer o)
   + CASE WHEN EXISTS (SELECT 1 FROM rv_definer) THEN 0 ELSE 1 END
  ) AS "rvDefinerViolations",
  ((SELECT count(*)::int FROM rv_definer o CROSS JOIN rv_definer_column d LEFT JOIN rv_user_rels c ON c.pub = d.relname AND c.relkind = 'r'
     WHERE c.oid IS NULL OR NOT has_column_privilege(o.oid, c.oid, d.attname, 'SELECT'))
   + (SELECT count(*)::int FROM rv_definer o WHERE NOT has_schema_privilege(o.oid, 'public', 'USAGE'))) AS "rvDefinerMissingGrants",
  ((SELECT count(*)::int FROM rv_reader o WHERE ${roleShape('o', true, false)}
      OR o.oid = (SELECT oid FROM rv_table_owner) OR o.oid IN (SELECT oid FROM rv_definer) OR NOT has_schema_privilege(o.oid, 'public', 'USAGE'))
   + (SELECT coalesce(sum(${revalSurfaceViolations('o.oid', false)}), 0)::int FROM rv_reader o)
   + CASE WHEN EXISTS (SELECT 1 FROM rv_reader) THEN 0 ELSE 1 END
  ) AS "rvReaderViolations",
  ((SELECT count(*)::int FROM rv_snapshot_acl a WHERE a.privilege_type <> 'EXECUTE' OR a.is_grantable OR a.grantee = 0)
   + CASE WHEN (SELECT count(DISTINCT grantee) FROM rv_snapshot_acl) = 1 THEN 0 ELSE 1 END
   + (SELECT count(*)::int FROM rv_functions f WHERE has_function_privilege(r.oid, f.oid, 'EXECUTE'))
  ) AS "rvExecuteViolations",
  ((SELECT count(*)::int FROM rv_present p, ${TABLE_PRIVS} v(priv)
     WHERE has_table_privilege(r.oid, p.oid, v.priv) OR (v.priv IN ('INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(r.oid, p.oid, v.priv)))
   + (SELECT count(*)::int FROM rv_present p JOIN pg_attribute a ON a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE has_column_privilege(r.oid, p.oid, a.attnum, 'SELECT')
             <> EXISTS (SELECT 1 FROM rv_runtime_column x WHERE x.relname = p.relname AND x.attname = a.attname))
  ) AS "rvRuntimeViolations"`;

/** The R-EVAL facts alone, for the current role. */
export const REVAL_READY_SQL = `WITH unused AS (SELECT 1)${REVAL_CTES}
  SELECT ${REVAL_COLUMNS} FROM pg_roles r WHERE r.rolname = current_user`;

export interface RevalFacts {
  rvTableViolations: number; rvTriggerViolations: number; rvRoutineViolations: number; rvDefinerViolations: number;
  rvDefinerMissingGrants: number; rvReaderViolations: number; rvExecuteViolations: number; rvRuntimeViolations: number;
}
/** Problems of the R-EVAL surface, as fixed reasons (empty = ready). Never echoes catalog values. */
export function revalProblems(facts: RevalFacts | undefined): string[] {
  if (!facts) return ['no R-EVAL facts'];
  const checks: [keyof RevalFacts, string][] = [
    ['rvTableViolations', 'R-EVAL tables lack FORCE RLS, their exact policies, contract CHECK, owner or scoped foreign keys'],
    ['rvTriggerViolations', 'R-EVAL guard triggers missing, extra, altered or not ENABLE ALWAYS'],
    ['rvRoutineViolations', 'R-EVAL routines are not exactly the snapshot and the owner-only guard; run prisma/roles.sql'],
    ['rvDefinerViolations', 'R-EVAL snapshot owner is not the confined evidence definer (attributes, membership or capabilities); run prisma/roles.sql'],
    ['rvDefinerMissingGrants', 'R-EVAL evidence definer lacks its specified column grants; run prisma/roles.sql'],
    ['rvReaderViolations', 'R-EVAL evidence reader is missing or not confined (attributes, membership or capabilities); run prisma/roles.sql'],
    ['rvExecuteViolations', 'R-EVAL snapshot EXECUTE is not exactly the evidence reader, or the runtime can execute an R-EVAL routine'],
    ['rvRuntimeViolations', 'runtime R-EVAL table privileges are not exactly the RS-B column SELECTs; run prisma/roles.sql'],
  ];
  return checks.filter(([key]) => Number(facts[key]) !== 0).map(([, reason]) => reason);
}
