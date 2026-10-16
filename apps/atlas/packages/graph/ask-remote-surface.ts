import { FENCE_SHARED_INVOKER_ROUTINES } from './fence-role.ts';

/**
 * The complete effective capability surface of the ASK-REMOTE definer (RC2 R2), evaluated at runtime startup by
 * ask-remote-role.ts and mirrored by the provisioning postcondition of prisma/roles.sql §5. The same rules as the accepted
 * PowerOffice surface (poweroffice-surface.ts), with the remote allowlist and the definer's own eight routines:
 *   - EVERY user object (OID ≥ 16384) in ANY schema, temporary ones included; allowed relations are anchored to the exact
 *     schema-qualified identity public."<name>" (a same-name relation elsewhere never matches);
 *   - table and column privileges: only ASK_REMOTE_DEFINER_* (table SELECT/INSERT on the four tables, the listed UPDATE
 *     columns and the fence columns); no sequence privilege;
 *   - grant options: none — neither explicit ACL entries nor EFFECTIVE table- or column-level WITH GRANT OPTION;
 *   - ownership: no relation, type or namespace; routines only its eight atlas_ask_remote_* in public;
 *   - EXECUTE on other routines only via PUBLIC on the accepted shared SECURITY INVOKER helpers (no SECURITY DEFINER, no
 *     explicit grant);
 *   - namespaces: no effective CREATE anywhere (explicit, PUBLIC or inherited) and no explicit grant except on public; the
 *     checking session's own temporary namespace is judged by its explicit ACL (it reports every privilege to TEMP holders);
 *   - built-in objects: no explicit ACL entry for the role; effective access never beyond what PUBLIC held initially
 *     (pg_init_privs); no database CREATE, parameter ACL (role or PUBLIC), language/type grant, large object, FDW/server,
 *     user mapping, default-privilege entry, shared-object dependency or tablespace ownership/CREATE.
 * Effective checks (has_*_privilege) include PUBLIC grants; membership paths are refused separately (the definer is NOINHERIT
 * and must be a member of nothing). Needs the CTEs ar_functions, ar_definer_table, ar_definer_column (ask-remote-role.ts).
 */
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const TABLE_PRIVS = `(VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN'))`;
const COLUMN_PRIVS = `(VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES'))`;

/** CTE definitions (each preceded by a comma). */
export const ASK_REMOTE_SURFACE_CTES = `,
  ar_user_rels AS (SELECT c.oid, c.relkind, c.relowner, c.relacl, CASE WHEN n.nspname = 'public' THEN c.relname END AS pub
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid >= 16384 AND c.relkind IN ('r','p','v','m','f','S')),
  ar_user_routines AS (SELECT p.oid, quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
                              p.prosecdef, p.proowner, p.proacl
                       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid >= 16384),
  ar_surface_shared(signature) AS (VALUES ${FENCE_SHARED_INVOKER_ROUTINES.map(r => `(${q(r)})`).join(',')}),
  ar_user_acl AS (SELECT a.grantee, a.is_grantable FROM ar_user_rels c, aclexplode(c.relacl) a
                  UNION ALL SELECT a.grantee, a.is_grantable FROM ar_user_rels c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a
                  UNION ALL SELECT a.grantee, a.is_grantable FROM ar_user_routines x, aclexplode(x.proacl) a WHERE x.oid NOT IN (SELECT oid FROM ar_functions)
                  UNION ALL SELECT a.grantee, a.is_grantable FROM pg_namespace n, aclexplode(n.nspacl) a),
  ar_builtin_routines AS (SELECT p.oid, p.proacl, i.initprivs, i.objoid IS NOT NULL AS recorded FROM pg_proc p
                          LEFT JOIN pg_init_privs i ON i.objoid = p.oid AND i.classoid = 'pg_proc'::regclass AND i.objsubid = 0 WHERE p.oid < 16384),
  ar_builtin_rels AS (SELECT c.oid, c.relname, c.relacl, n.nspname, i.initprivs, i.objoid IS NOT NULL AS recorded FROM pg_class c
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                      LEFT JOIN pg_init_privs i ON i.objoid = c.oid AND i.classoid = 'pg_class'::regclass AND i.objsubid = 0
                      WHERE c.oid < 16384 AND c.relkind IN ('r','p','v','m','f','S'))`;

/** Tablespace ownership/CREATE (the PowerOffice rule: pg_tablespace is unreadable for non-superusers in in-memory PGlite). */
function tablespaceViolations(R: string): string {
  return `(CASE WHEN has_table_privilege('pg_catalog.pg_tablespace', 'SELECT')
      THEN (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM pg_catalog.pg_tablespace ts WHERE ts.spcowner = %s'
             || ' OR pg_catalog.has_tablespace_privilege(%s::oid, ts.oid, ''CREATE'')', ${R}, ${R}), false, true, '')))[1]::text::int
      WHEN pg_catalog.version() LIKE '%Emscripten%'
      THEN CASE WHEN has_tablespace_privilege(${R}, 'pg_default', 'CREATE') OR has_tablespace_privilege(${R}, 'pg_global', 'CREATE') THEN 1 ELSE 0 END
      ELSE 1 END)`;
}

/** Number of capability violations of the remote definer `R` (a SQL oid expression). */
export function askRemoteSurfaceViolations(R: string): string {
  const notAllowedTable = `NOT EXISTS (SELECT 1 FROM ar_definer_table d WHERE d.relname = c.pub AND d.priv = v.priv)`;
  return `(
    (SELECT count(*) FROM ar_user_rels c, ${TABLE_PRIVS} v(priv) WHERE c.relkind <> 'S' AND has_table_privilege(${R}, c.oid, v.priv) AND ${notAllowedTable})
    + (SELECT count(*) FROM ar_user_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL, ${COLUMN_PRIVS} v(priv)
        WHERE c.relkind <> 'S' AND has_column_privilege(${R}, c.oid, a.attnum, v.priv) AND NOT has_table_privilege(${R}, c.oid, v.priv) AND ${notAllowedTable}
          AND NOT EXISTS (SELECT 1 FROM ar_definer_column d WHERE d.relname = c.pub AND d.priv = v.priv AND d.attname = a.attname))
    + (SELECT count(*) FROM ar_user_rels c WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(${R}, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END)
    + (SELECT count(*) FROM ar_user_rels c, ${TABLE_PRIVS} v(priv) WHERE c.relkind <> 'S' AND has_table_privilege(${R}, c.oid, v.priv || ' WITH GRANT OPTION'))
    + (SELECT count(*) FROM ar_user_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL, ${COLUMN_PRIVS} v(priv)
        WHERE c.relkind <> 'S' AND has_column_privilege(${R}, c.oid, a.attnum, v.priv || ' WITH GRANT OPTION'))
    + (SELECT count(*) FROM ar_user_rels c WHERE c.relowner = ${R})
    + (SELECT count(*) FROM pg_type t WHERE t.oid >= 16384 AND t.typowner = ${R})
    + (SELECT count(*) FROM ar_user_routines x WHERE x.proowner = ${R} AND x.oid NOT IN (SELECT oid FROM ar_functions))
    + (SELECT count(*) FROM ar_user_routines x
        WHERE x.oid NOT IN (SELECT oid FROM ar_functions) AND has_function_privilege(${R}, x.oid, 'EXECUTE')
          AND (x.prosecdef OR x.signature NOT IN (SELECT signature FROM ar_surface_shared)
               OR EXISTS (SELECT 1 FROM aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) e WHERE e.grantee = ${R})))
    + (SELECT count(*) FROM pg_namespace n WHERE n.nspowner = ${R}
        OR (n.oid IS DISTINCT FROM pg_my_temp_schema() AND has_schema_privilege(${R}, n.oid, 'CREATE'))
        OR EXISTS (SELECT 1 FROM aclexplode(n.nspacl) e WHERE (e.grantee = ${R} AND n.nspname <> 'public')
                     OR (n.oid = pg_my_temp_schema() AND e.grantee = 0 AND e.privilege_type = 'CREATE')))
    + (SELECT count(*) FROM ar_user_acl ua WHERE ua.grantee = ${R} AND ua.is_grantable)
    + (SELECT count(*) FROM ar_builtin_routines x WHERE EXISTS (SELECT 1 FROM aclexplode(x.proacl) e WHERE e.grantee = ${R})
        OR (x.recorded AND has_function_privilege(${R}, x.oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(x.initprivs) e WHERE e.grantee = 0 AND e.privilege_type = 'EXECUTE')))
    + (SELECT count(*) FROM ar_builtin_rels c WHERE EXISTS (SELECT 1 FROM aclexplode(c.relacl) e WHERE e.grantee = ${R})
        OR EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) e WHERE a.attrelid = c.oid AND e.grantee = ${R}))
    + (SELECT count(*) FROM ar_builtin_rels c, ${TABLE_PRIVS} v(priv) WHERE has_table_privilege(${R}, c.oid, v.priv)
        AND NOT CASE WHEN c.recorded THEN EXISTS (SELECT 1 FROM aclexplode(c.initprivs) e WHERE e.grantee = 0 AND e.privilege_type = v.priv)
                     ELSE c.nspname = 'information_schema' AND v.priv = 'SELECT' AND c.relname NOT LIKE '\\_pg\\_%'
                          AND c.relname NOT IN ('sql_parts', 'transforms') END)
    + (SELECT count(*) FROM ar_builtin_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
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
