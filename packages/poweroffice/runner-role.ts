import { POWEROFFICE_CLEANUP_ARGS, POWEROFFICE_CLEANUP_ROUTINE, POWEROFFICE_CTES } from '../graph/poweroffice-role.ts';
import { surfaceViolations } from '../graph/poweroffice-surface.ts';

/**
 * Runner-perspective confinement and pairing facts of the PowerOffice cleanup runner (docs/stage4/03_DATA_AND_CONCURRENCY.md
 * "Exact roles and scope", "Explicit bounded maintenance"), evaluated INSIDE the runner transaction before any lock or
 * routine call. It reuses the accepted readiness CTEs (packages/graph/poweroffice-role.ts, poweroffice-surface.ts) with the
 * current role `r` = the connected runner; it neither changes nor replaces the runtime readiness check:
 *   runner   LOGIN NOINHERIT, no SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION, session_user = current_user, member of
 *            no role, no member except the table owner's ADMIN-only creator link, and the complete capability surface of a
 *            runner (no relation/sequence/routine/namespace/built-in/shared capability) — EXECUTE on the routine only;
 *   routine  exactly one public.atlas_poweroffice_cleanup(text,text,text,uuid), SECURITY DEFINER, search_path pg_catalog, public;
 *   ACL      besides the owner exactly ONE grantee — this runner — with EXECUTE and no grant option;
 *   definer  the routine owner: NOLOGIN NOINHERIT confined role, not this runner nor reachable from it, owning no relation and
 *            no other routine, with its exact definer surface and every specified grant.
 * Pairing facts (database, postmaster start, routine OID and runner name) are compared with the ones the runtime admission
 * observed under the fence, so the runner provably targets the SAME database without ever printing a URL.
 */
export const POWEROFFICE_RUNNER_CHECK_SQL = `WITH unused AS (SELECT 1)${POWEROFFICE_CTES}
  SELECT r.rolsuper AS "superuser", r.rolbypassrls AS "bypassRls", (session_user <> current_user) AS "sessionRoleMismatch",
    ((r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit OR NOT r.rolcanlogin)::int) AS "attributeViolations",
    (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS "memberships",
    (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid
       AND NOT (m.member IN (SELECT relowner FROM po_present) AND NOT m.set_option AND NOT m.inherit_option)) AS "members",
    ${surfaceViolations('r.oid', false)}::int AS "surfaceViolations",
    (SELECT count(*)::int FROM po_routine x WHERE x.prosecdef AND x.args = '${POWEROFFICE_CLEANUP_ARGS}'
       AND x.proconfig = ARRAY['search_path=pg_catalog, public']::text[] AND has_function_privilege(r.oid, x.oid, 'EXECUTE')) AS "routines",
    (SELECT count(*)::int FROM po_routine) AS "routineCount",
    ((SELECT count(*)::int FROM po_acl a WHERE a.grantee <> r.oid OR a.privilege_type <> 'EXECUTE' OR a.is_grantable)
     + CASE WHEN (SELECT count(DISTINCT grantee) FROM po_acl) = 1 THEN 0 ELSE 1 END) AS "executeViolations",
    ((SELECT count(*)::int FROM po_owner o
       WHERE o.rolsuper OR o.rolbypassrls OR o.rolcanlogin OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication OR o.rolinherit
          OR o.oid = r.oid OR pg_has_role(r.oid, o.oid, 'MEMBER')
          OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = o.oid)
          OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = o.oid AND (m.inherit_option OR m.member NOT IN (SELECT relowner FROM po_present)))
          OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = o.oid)
          OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = o.oid AND p.oid NOT IN (SELECT oid FROM po_routine)))
     + (SELECT coalesce(sum(${surfaceViolations('o.oid', true)}), 0)::int FROM po_owner o)
     + (SELECT count(*)::int FROM po_owner o CROSS JOIN po_definer_table d LEFT JOIN po_user_rels c ON c.pub = d.relname AND c.relkind = 'r'
         WHERE c.oid IS NULL OR NOT has_table_privilege(o.oid, c.oid, d.priv))
     + (SELECT count(*)::int FROM po_owner o CROSS JOIN po_definer_column d LEFT JOIN po_user_rels c ON c.pub = d.relname AND c.relkind = 'r'
         WHERE c.oid IS NULL OR NOT has_column_privilege(o.oid, c.oid, d.attname, d.priv))
     + CASE WHEN (SELECT count(*) FROM po_owner) = 1 THEN 0 ELSE 1 END) AS "definerViolations",
    current_database()::text AS "database", pg_postmaster_start_time()::text AS "started",
    (SELECT x.oid::text FROM po_routine x LIMIT 1) AS "routine", r.rolname::text AS "runner"
  FROM pg_roles r WHERE r.rolname = current_user`;

/** The same pairing facts as the runtime sees them under the admission fence: the routine's single EXECUTE grantee by name. */
export const POWEROFFICE_PAIRING_SQL = `SELECT current_database()::text AS "database", pg_postmaster_start_time()::text AS "started",
    p.oid::text AS "routine", (SELECT g.rolname::text FROM aclexplode(p.proacl) a JOIN pg_roles g ON g.oid = a.grantee WHERE a.grantee <> p.proowner LIMIT 1) AS "runner"
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '${POWEROFFICE_CLEANUP_ROUTINE}' AND pg_get_function_identity_arguments(p.oid) = '${POWEROFFICE_CLEANUP_ARGS}'`;

export interface Pairing { database: string; started: string; routine: string; runner: string }
export interface RunnerFacts extends Pairing {
  superuser: boolean; bypassRls: boolean; sessionRoleMismatch: boolean; attributeViolations: number; memberships: number; members: number;
  surfaceViolations: number; routines: number; routineCount: number; executeViolations: number; definerViolations: number;
}
/** Fixed reasons (empty = confined and paired). Never echoes a role, database or URL. */
export function runnerProblems(facts: RunnerFacts | undefined, admitted: Pairing): string[] {
  if (!facts) return ['noFacts'];
  const problems: string[] = [];
  if (facts.superuser || facts.bypassRls) problems.push('bypassesRls');
  if (facts.sessionRoleMismatch) problems.push('sessionRoleMismatch');
  for (const fact of ['attributeViolations', 'memberships', 'members', 'surfaceViolations', 'executeViolations', 'definerViolations'] as const) {
    if (Number(facts[fact]) !== 0) problems.push(fact);
  }
  if (Number(facts.routines) !== 1 || Number(facts.routineCount) !== 1) problems.push('routine');
  for (const fact of ['database', 'started', 'routine', 'runner'] as const) {
    if (typeof facts[fact] !== 'string' || facts[fact] !== admitted[fact]) problems.push(`pairing.${fact}`);
  }
  return problems;
}
