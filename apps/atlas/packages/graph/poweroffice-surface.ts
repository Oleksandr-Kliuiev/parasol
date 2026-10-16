import { FENCE_SHARED_INVOKER_ROUTINES } from './fence-role.ts';

/**
 * The complete effective capability surface of the two Stage 4 PowerOffice maintenance roles (RC2 F1–F3). Prisma-free
 * SQL fragments used by poweroffice-role.ts (readiness) and mirrored by the postcondition of prisma/roles.sql.
 *
 * Trusted system objects are the built-in ones created by initdb: OID below FirstNormalObjectId (16384). EVERY other
 * relation, routine, type and namespace — in any schema, including user-created objects in pg_temp_N of any session — is a
 * user object; nothing is exempted by its namespace name. Allowed relations are anchored to the exact schema-qualified
 * identity public."<name>" (a same-name relation in another schema never matches). For a role R (a SQL oid expression):
 *   - table and column privileges on user relations: only the definer's allowlist (POWEROFFICE_DEFINER_*), the runner none;
 *   - sequences: none; grant options on any user relation, column, routine or namespace: none;
 *   - ownership of any user relation, type, routine (except the definer's cleanup routine) or namespace: none;
 *   - routines: EXECUTE only on its exact capability (the cleanup routine, granted to the runner / owned by the definer) and
 *     the accepted shared SECURITY INVOKER helpers via PUBLIC (FENCE_SHARED_INVOKER_ROUTINES, reused, never widened);
 *   - namespaces: no ownership; no effective CREATE anywhere (explicit, PUBLIC or inherited); an explicit grant of any
 *     schema privilege to the role only on public (its required USAGE). PUBLIC USAGE on another schema is a global
 *     privilege left as is: it grants no object access by itself, and every object path is checked above (the accepted
 *     Stage 3 fence tests rely on that). The checking session's OWN temporary namespace reports every privilege to any
 *     role with database TEMP (a rule for the owning backend only), so there its explicit ACL is checked instead.
 *   - BUILT-IN objects (OID < 16384) are not trusted blindly: an explicit ACL entry for the role on any built-in routine,
 *     relation, column, type, language, the database or a configuration parameter is a violation (none is ever needed),
 *     and the role's effective privilege on a built-in routine/relation/column must not exceed what PUBLIC held INITIALLY
 *     per pg_init_privs (privtype 'i', recorded by initdb; a routine without a record has the default PUBLIC EXECUTE). A
 *     PUBLIC grant on an initially restricted built-in (e.g. pg_read_file) is therefore refused, never "repaired" globally.
 *     Built-in relations without an initial record exist only in information_schema (verified on PG17): there at most
 *     SELECT, and none on its internal _pg_* views (foreign servers/user mappings) nor on the two initially owner-only
 *     sql_parts/transforms. No database CREATE; no parameter ACL entry for the role or PUBLIC. (Database privileges are
 *     CONNECT/TEMP — PUBLIC by default — and CREATE, checked effectively.)
 *   - Other ACL-carrying objects: no owned large object, no large-object ACL entry for the role or PUBLIC, and
 *     lo_compat_privileges off whenever large objects exist; no owned foreign-data wrapper/server and no effective USAGE
 *     on one; no user mapping for the role; no default-privilege entry by or for the role; no ACL entry or ownership on a
 *     SHARED object (pg_shdepend dbid 0: database, tablespace, parameter); no ownership of and no effective CREATE
 *     (explicit, PUBLIC or inherited) on ANY tablespace, default or not (see tablespaceViolations).
 * Effective checks (has_*_privilege) include PUBLIC and inherited paths; membership of these roles is refused elsewhere.
 * A column can exceed its table's privilege only through a non-NULL column ACL, so only such columns are examined.
 * The database-level TEMP privilege (PUBLIC by default) is left unchanged: objects a role creates itself run with its own
 * rights; any routine/relation it creates is still a user object subject to the checks above for the other role.
 */
export const FIRST_USER_OID = 16384;
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
// Every PostgreSQL 17 table privilege, MAINTAIN included (VACUUM/ANALYZE/REINDEX/REFRESH/CLUSTER/LOCK TABLE).
const TABLE_PRIVS = `(VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN'))`;
const COLUMN_PRIVS = `(VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES'))`;

/** CTE definitions (each preceded by a comma). Needs po_routine and po_definer_table/po_definer_column from poweroffice-role.ts. */
export const POWEROFFICE_SURFACE_CTES = `,
  po_user_rels AS (SELECT c.oid, c.relkind, c.relowner, c.relacl, CASE WHEN n.nspname = 'public' THEN c.relname END AS pub
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE c.oid >= ${FIRST_USER_OID} AND c.relkind IN ('r','p','v','m','f','S')),
  po_user_routines AS (SELECT p.oid, quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
                              p.prosecdef, p.proowner, p.proacl
                       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid >= ${FIRST_USER_OID}),
  po_shared(signature) AS (VALUES ${FENCE_SHARED_INVOKER_ROUTINES.map(r => `(${q(r)})`).join(',')}),
  po_user_acl AS (SELECT a.grantee, a.is_grantable FROM po_user_rels c, aclexplode(c.relacl) a
                  UNION ALL SELECT a.grantee, a.is_grantable FROM po_user_rels c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a
                  UNION ALL SELECT a.grantee, a.is_grantable FROM po_user_routines x, aclexplode(x.proacl) a WHERE x.oid NOT IN (SELECT oid FROM po_routine)
                  UNION ALL SELECT a.grantee, a.is_grantable FROM pg_namespace n, aclexplode(n.nspacl) a),
  po_builtin_routines AS (SELECT p.oid, p.proacl, i.initprivs, i.objoid IS NOT NULL AS recorded FROM pg_proc p
                          LEFT JOIN pg_init_privs i ON i.objoid = p.oid AND i.classoid = 'pg_proc'::regclass AND i.objsubid = 0
                          WHERE p.oid < ${FIRST_USER_OID}),
  po_builtin_rels AS (SELECT c.oid, c.relname, c.relacl, n.nspname, i.initprivs, i.objoid IS NOT NULL AS recorded FROM pg_class c
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                      LEFT JOIN pg_init_privs i ON i.objoid = c.oid AND i.classoid = 'pg_class'::regclass AND i.objsubid = 0
                      WHERE c.oid < ${FIRST_USER_OID} AND c.relkind IN ('r','p','v','m','f','S'))`;

/**
 * Tablespaces owned by `R` or on which it has effective CREATE, over EVERY tablespace. PostgreSQL grants SELECT on the
 * pg_tablespace catalog to PUBLIC; because permissions are checked for every referenced relation before execution (even
 * in an unexecuted CASE branch), that one enumeration runs as a runtime-built query only when the catalog is readable.
 * Unreadable: in-memory PGlite (an Emscripten build that denies this shared catalog to non-superusers and cannot hold any
 * tablespace besides the built-in pg_default/pg_global) checks those two by name; any other server fails closed (1).
 */
function tablespaceViolations(R: string): string {
  return `(CASE WHEN has_table_privilege('pg_catalog.pg_tablespace', 'SELECT')
      THEN (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM pg_catalog.pg_tablespace ts WHERE ts.spcowner = %s'
             || ' OR pg_catalog.has_tablespace_privilege(%s::oid, ts.oid, ''CREATE'')', ${R}, ${R}), false, true, '')))[1]::text::int
      WHEN pg_catalog.version() LIKE '%Emscripten%'
      THEN CASE WHEN has_tablespace_privilege(${R}, 'pg_default', 'CREATE') OR has_tablespace_privilege(${R}, 'pg_global', 'CREATE') THEN 1 ELSE 0 END
      ELSE 1 END)`;
}

/** Number of capability violations of role `R`; `definer` selects the definer's relation allowlist (else: none). */
export function surfaceViolations(R: string, definer: boolean): string {
  const tableAllowed = definer ? `AND NOT EXISTS (SELECT 1 FROM po_definer_table d WHERE d.relname = c.pub AND d.priv = v.priv)` : '';
  const columnAllowed = definer ? `AND NOT EXISTS (SELECT 1 FROM po_definer_table d WHERE d.relname = c.pub AND d.priv = v.priv)
         AND NOT EXISTS (SELECT 1 FROM po_definer_column d WHERE d.relname = c.pub AND d.priv = v.priv AND d.attname = a.attname)` : '';
  return `(
    (SELECT count(*) FROM po_user_rels c, ${TABLE_PRIVS} v(priv) WHERE c.relkind <> 'S' AND has_table_privilege(${R}, c.oid, v.priv) ${tableAllowed})
    + (SELECT count(*) FROM po_user_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL, ${COLUMN_PRIVS} v(priv)
        WHERE c.relkind <> 'S' AND has_column_privilege(${R}, c.oid, a.attnum, v.priv) AND NOT has_table_privilege(${R}, c.oid, v.priv) ${columnAllowed})
    + (SELECT count(*) FROM po_user_rels c WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(${R}, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END)
    + (SELECT count(*) FROM po_user_rels c WHERE c.relowner = ${R})
    + (SELECT count(*) FROM pg_type t WHERE t.oid >= ${FIRST_USER_OID} AND t.typowner = ${R})
    + (SELECT count(*) FROM po_user_routines x WHERE x.proowner = ${R} AND x.oid NOT IN (SELECT oid FROM po_routine))
    + (SELECT count(*) FROM po_user_routines x
        WHERE x.oid NOT IN (SELECT oid FROM po_routine) AND has_function_privilege(${R}, x.oid, 'EXECUTE')
          AND (x.prosecdef OR x.signature NOT IN (SELECT signature FROM po_shared)
               OR EXISTS (SELECT 1 FROM aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) e WHERE e.grantee = ${R})))
    + (SELECT count(*) FROM pg_namespace n WHERE n.nspowner = ${R}
        OR (n.oid IS DISTINCT FROM pg_my_temp_schema() AND has_schema_privilege(${R}, n.oid, 'CREATE'))
        OR EXISTS (SELECT 1 FROM aclexplode(n.nspacl) e WHERE (e.grantee = ${R} AND n.nspname <> 'public')
                     OR (n.oid = pg_my_temp_schema() AND e.grantee = 0 AND e.privilege_type = 'CREATE')))
    + (SELECT count(*) FROM po_user_acl ua WHERE ua.grantee = ${R} AND ua.is_grantable)
    + (SELECT count(*) FROM po_builtin_routines x WHERE EXISTS (SELECT 1 FROM aclexplode(x.proacl) e WHERE e.grantee = ${R})
        OR (x.recorded AND has_function_privilege(${R}, x.oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(x.initprivs) e WHERE e.grantee = 0 AND e.privilege_type = 'EXECUTE')))
    + (SELECT count(*) FROM po_builtin_rels c WHERE EXISTS (SELECT 1 FROM aclexplode(c.relacl) e WHERE e.grantee = ${R})
        OR EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) e WHERE a.attrelid = c.oid AND e.grantee = ${R}))
    + (SELECT count(*) FROM po_builtin_rels c, ${TABLE_PRIVS} v(priv) WHERE has_table_privilege(${R}, c.oid, v.priv)
        AND NOT CASE WHEN c.recorded THEN EXISTS (SELECT 1 FROM aclexplode(c.initprivs) e WHERE e.grantee = 0 AND e.privilege_type = v.priv)
                     ELSE c.nspname = 'information_schema' AND v.priv = 'SELECT' AND c.relname NOT LIKE '\\_pg\\_%'
                          AND c.relname NOT IN ('sql_parts', 'transforms') END)
    + (SELECT count(*) FROM po_builtin_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
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
