import { ASK_REMOTE_SURFACE_CTES, askRemoteSurfaceViolations } from './ask-remote-surface.ts';

/**
 * Readiness facts of the Stage 5 ASK-REMOTE R-A surface (docs/stage5/ask/remote/04_AUTHORITY_AND_BILLING.md): the four
 * FORCE-RLS remote tables with exactly their PUBLIC workspace policy, scoped foreign keys and contract CHECKs, the ALWAYS
 * guard/ledger triggers, the nine atlas_ask_remote_* routines owned by ONE confined NOLOGIN remote definer (exact
 * relation/column allowlist incl. SELECT(workspaceId, version) + UPDATE(version) on the authority fence), their exact
 * EXECUTE ACLs (runtime: reserve/settle/pause and the R-B reserve_floor; table owner: the provisioning routines; nobody
 * else, never PUBLIC) and the runtime's SELECT-only access. Prisma-free SQL fragments evaluated for the CURRENT role as `r` inside the shared runtime
 * startup check (runtime-role.ts) — in every Ask mode, OFF/MOCK included — and alone as ASK_REMOTE_READY_SQL. Any drift
 * (a default regrant, a PUBLIC routine, a missing grant, an extra privilege, a disabled trigger) fails closed until
 * prisma/roles.sql runs again. RC2 R2: the definer's complete effective capability surface across every schema (effective
 * grant options, schema CREATE/ownership, PUBLIC/built-in escalation; ask-remote-surface.ts) is checked here at startup as
 * well as by the prisma/roles.sql §5 postcondition; the existing fence definer, its two policies and its routine stay
 * unchanged (fence-role.ts).
 */
export const ASK_REMOTE_TABLES: readonly string[] = ['RemoteAskPolicy', 'RemoteAskClientAdmission', 'RemoteAskPeriodCounter', 'RemoteAskAttempt'];
const SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
/** Every atlas_ask_remote_* routine: name, exact identity arguments, SECURITY DEFINER, EXECUTE grantee besides the owner. */
type RoutineSpec = readonly [name: string, args: string, definer: boolean, grantee: 'runtime' | 'owner' | 'none'];
export const ASK_REMOTE_ROUTINES: readonly RoutineSpec[] = [
  ['atlas_ask_remote_reserve', 'p_workspace text, p_client text, p_actor text, p_admission uuid, p_policy_version bigint, p_fence_version integer, '
    + 'p_profile text, p_price_revision text, p_correlation uuid', true, 'runtime'],
  ['atlas_ask_remote_settle', 'p_workspace text, p_client text, p_attempt uuid, p_correlation uuid, p_outcome text, p_prompt_tokens integer, '
    + 'p_completion_tokens integer', true, 'runtime'],
  ['atlas_ask_remote_pause', 'p_workspace text, p_admission uuid, p_reason text', true, 'runtime'],
  // R-B migration 202610121000: the egress reservation with the original-deadline floor inside the routine.
  ['atlas_ask_remote_reserve_floor', 'p_workspace text, p_client text, p_actor text, p_admission uuid, p_policy_version bigint, '
    + 'p_fence_version integer, p_profile text, p_price_revision text, p_correlation uuid, p_floor timestamp with time zone', true, 'runtime'],
  ['atlas_ask_remote_policy_create', 'p_workspace text, p_admission uuid, p_project text, p_secret_ref text, p_owner_approval_ref text, '
    + 'p_retention_ref text, p_price_revision text, p_prompt_sha256 text, p_schema_sha256 text, p_package_sha256 text, p_day_cap bigint, '
    + 'p_month_cap bigint, p_expires_at timestamp with time zone', true, 'owner'],
  ['atlas_ask_remote_policy_revise', 'p_workspace text, p_admission uuid, p_expected_version bigint, p_state text, p_secret_ref text, '
    + 'p_owner_approval_ref text, p_retention_ref text, p_price_revision text, p_prompt_sha256 text, p_schema_sha256 text, p_package_sha256 text, '
    + 'p_day_cap bigint, p_month_cap bigint, p_expires_at timestamp with time zone', true, 'owner'],
  ['atlas_ask_remote_client_set', 'p_workspace text, p_admission uuid, p_client text, p_expected_version bigint, p_admitted boolean', true, 'owner'],
  ['atlas_ask_remote_guard', '', false, 'none'],
  ['atlas_ask_remote_ledger_check', '', false, 'none'],
];
/** The remote definer's EXACT privileges (prisma/roles.sql §4c): table level, then column level. Anything else fails. */
export const ASK_REMOTE_DEFINER_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(ASK_REMOTE_TABLES.map(t => [t, ['SELECT', 'INSERT']])));
export const ASK_REMOTE_DEFINER_COLUMN_PRIVILEGES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  ActionAuthorityFence: { SELECT: ['workspaceId', 'version'], UPDATE: ['version'] },
  RemoteAskPolicy: { UPDATE: ['policyVersion', 'state', 'stateReason', 'promptSha256', 'schemaSha256', 'packageSha256', 'secretRef', 'ownerApprovalRef',
    'retentionAttestationRef', 'priceRevision', 'dayCapMicroUsd', 'monthCapMicroUsd', 'expiresAt', 'revisedAt'] },
  RemoteAskClientAdmission: { UPDATE: ['state', 'changedAtPolicyVersion', 'updatedAt'] },
  RemoteAskPeriodCounter: { UPDATE: ['chargedMicroUsd', 'updatedAt'] },
  RemoteAskAttempt: { UPDATE: ['state', 'outcome', 'promptTokens', 'completionTokens', 'accountedMicroUsd', 'settledAt'] },
});
/** Scoped foreign keys (migration 202610111010): every reference carries the workspace; RESTRICT on delete and update. */
type ForeignKeySpec = readonly [table: string, name: string, columns: string, refTable: string, refColumns: string];
export const ASK_REMOTE_FOREIGN_KEYS: readonly ForeignKeySpec[] = [
  ['RemoteAskPolicy', 'RemoteAskPolicy_workspace_fkey', 'workspaceId', 'Workspace', 'id'],
  ['RemoteAskClientAdmission', 'RemoteAskClientAdmission_client_fkey', 'workspaceId,clientId', 'Client', 'workspaceId,id'],
  ['RemoteAskClientAdmission', 'RemoteAskClientAdmission_policy_fkey', 'workspaceId,admissionId', 'RemoteAskPolicy', 'workspaceId,admissionId'],
  ['RemoteAskPeriodCounter', 'RemoteAskPeriodCounter_policy_fkey', 'workspaceId,projectIdentity', 'RemoteAskPolicy', 'workspaceId,projectIdentity'],
  ['RemoteAskAttempt', 'RemoteAskAttempt_client_fkey', 'workspaceId,clientId', 'Client', 'workspaceId,id'],
  ['RemoteAskAttempt', 'RemoteAskAttempt_actor_fkey', 'workspaceId,actorId', 'Actor', 'workspaceId,id'],
  ['RemoteAskAttempt', 'RemoteAskAttempt_admission_fkey', 'workspaceId,admissionId,clientId', 'RemoteAskClientAdmission', 'workspaceId,admissionId,clientId'],
  ['RemoteAskAttempt', 'RemoteAskAttempt_policy_fkey', 'workspaceId,admissionId,projectIdentity', 'RemoteAskPolicy', 'workspaceId,admissionId,projectIdentity'],
];
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. All ENABLE ALWAYS ('A').
type TriggerSpec = readonly [table: string, trigger: string, fn: string, tgtype: number, deferred: boolean];
export const ASK_REMOTE_TRIGGERS: readonly TriggerSpec[] = [
  ...ASK_REMOTE_TABLES.flatMap((t): TriggerSpec[] => [[t, `${t}_guard`, 'atlas_ask_remote_guard', 31, false],
    [t, `${t}_truncate`, 'atlas_ask_remote_guard', 34, false]]),
  ['RemoteAskPeriodCounter', 'RemoteAskPeriodCounter_ledger', 'atlas_ask_remote_ledger_check', 21, true],
  ['RemoteAskAttempt', 'RemoteAskAttempt_ledger', 'atlas_ask_remote_ledger_check', 21, true],
];
export const ASK_REMOTE_SCOPE_QUAL = '("workspaceId" = atlas_app_workspace())';

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const rows = (values: readonly (readonly (string | number | boolean)[])[]) =>
  values.map(v => `(${v.map(x => typeof x === 'string' ? q(x) : String(x)).join(',')})`).join(',');
const schemaRel = (alias: string) => `JOIN pg_namespace ${alias}n ON ${alias}n.oid = ${alias}.relnamespace AND ${alias}n.nspname = current_schema()`;
const definerTable = rows(Object.entries(ASK_REMOTE_DEFINER_TABLE_PRIVILEGES).flatMap(([t, ps]) => ps.map(p => [t, p])));
const definerColumn = rows(Object.entries(ASK_REMOTE_DEFINER_COLUMN_PRIVILEGES)
  .flatMap(([t, byPrivilege]) => Object.entries(byPrivilege).flatMap(([p, cols]) => cols.map(c => [t, p, c]))));
const colNames = (rel: string, keys: string) =>
  `ARRAY(SELECT a.attname::text FROM unnest(${keys}) WITH ORDINALITY u(attnum, ord) JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = u.attnum ORDER BY u.ord)`;

/** CTE definitions (each preceded by a comma) to append to a WITH list. */
export const ASK_REMOTE_CTES = `,
  ar_tables(relname) AS (VALUES ${rows(ASK_REMOTE_TABLES.map(t => [t]))}),
  ar_present AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner FROM pg_class c ${schemaRel('c')}
                 WHERE c.relkind = 'r' AND c.relname IN (SELECT relname FROM ar_tables)),
  ar_spec(proname, args, secdef, grantee) AS (VALUES ${rows(ASK_REMOTE_ROUTINES)}),
  ar_functions AS (SELECT p.oid, p.proname, p.proowner, p.proacl, p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid) AS args
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = current_schema() AND p.proname LIKE 'atlas\\_ask\\_remote\\_%'),
  ar_owner AS (SELECT o.* FROM pg_roles o WHERE o.oid = (SELECT f.proowner FROM ar_functions f WHERE f.proname = 'atlas_ask_remote_reserve' LIMIT 1)),
  ar_table_owner AS (SELECT p.relowner AS oid FROM ar_present p WHERE p.relname = 'RemoteAskPolicy'),
  ar_acl AS (SELECT f.proname, s.grantee AS spec, a.grantee, a.privilege_type, a.is_grantable
               FROM ar_functions f JOIN ar_spec s ON s.proname = f.proname,
                    aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a WHERE a.grantee <> f.proowner),
  ar_definer_table(relname, priv) AS (VALUES ${definerTable}),
  ar_definer_column(relname, priv, attname) AS (VALUES ${definerColumn}),
  ar_fks(relname, conname, cols, refrel, refcols) AS (VALUES ${rows(ASK_REMOTE_FOREIGN_KEYS)}),
  ar_triggers(relname, tgname, fn, tgtype, deferred) AS (VALUES ${rows(ASK_REMOTE_TRIGGERS)})${ASK_REMOTE_SURFACE_CTES}`;

const ALL_TABLE_PRIVS = `(VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN'))`;
const COLUMN_PRIVS = `(VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES'))`;

/** Select-list columns over `r` (pg_roles row of the current role). */
export const ASK_REMOTE_COLUMNS = `
  ((SELECT count(*)::int FROM ar_tables t LEFT JOIN ar_present p ON p.relname = t.relname
     WHERE p.oid IS NULL OR NOT p.relrowsecurity OR NOT p.relforcerowsecurity
        OR (SELECT count(*) FROM pg_policy x WHERE x.polrelid = p.oid) <> 1
        OR NOT EXISTS (SELECT 1 FROM pg_policy x WHERE x.polrelid = p.oid AND x.polname = t.relname || '_scope' AND x.polpermissive AND x.polcmd = '*'
                         AND x.polroles = ARRAY[0]::oid[] AND pg_get_expr(x.polqual, x.polrelid) = ${q(ASK_REMOTE_SCOPE_QUAL)}
                         AND pg_get_expr(x.polwithcheck, x.polrelid) = ${q(ASK_REMOTE_SCOPE_QUAL)})
        OR NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = p.oid AND k.conname = t.relname || '_contract_check' AND k.contype = 'c' AND k.convalidated))
   + (SELECT count(*)::int FROM ar_fks e
       WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN ar_present p ON p.oid = k.conrelid AND p.relname = e.relname
                           JOIN pg_class rc ON rc.oid = k.confrelid ${schemaRel('rc')}
                          WHERE k.conname = e.conname AND k.contype = 'f' AND k.convalidated AND rc.relname = e.refrel
                            AND k.confdeltype = 'r' AND k.confupdtype = 'r'
                            AND array_to_string(${colNames('k.conrelid', 'k.conkey')}, ',') = e.cols
                            AND array_to_string(${colNames('k.confrelid', 'k.confkey')}, ',') = e.refcols))
  ) AS "arTableViolations",
  (SELECT count(*)::int FROM ar_triggers e
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ${schemaRel('c')}
                        JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = current_schema()
                       WHERE c.relname = e.relname AND t.tgname = e.tgname AND p.proname = e.fn AND t.tgtype = e.tgtype AND NOT t.tgisinternal
                         AND t.tgenabled = 'A' AND t.tgdeferrable = e.deferred AND t.tginitdeferred = e.deferred
                         AND (t.tgconstraint <> 0) = e.deferred)) AS "arTriggerViolations",
  ((SELECT count(*)::int FROM ar_spec s WHERE NOT EXISTS (SELECT 1 FROM ar_functions f WHERE f.proname = s.proname AND f.args = s.args))
   + (SELECT count(*)::int FROM ar_functions f LEFT JOIN ar_spec s ON s.proname = f.proname AND s.args = f.args
       WHERE s.proname IS NULL OR f.prosecdef <> s.secdef OR f.proconfig IS DISTINCT FROM ARRAY[${q(SEARCH_PATH)}]::text[]
          OR f.proowner IS DISTINCT FROM (SELECT oid FROM ar_owner)
          OR EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a WHERE a.grantee = 0))
  ) AS "arRoutineViolations",
  ((SELECT count(*)::int FROM ar_owner o
     WHERE o.rolsuper OR o.rolbypassrls OR o.rolcanlogin OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication OR o.rolinherit
        OR o.oid = r.oid OR pg_has_role(r.oid, o.oid, 'MEMBER') OR has_schema_privilege(o.oid, current_schema(), 'CREATE')
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = o.oid)
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = o.oid AND (m.inherit_option OR m.member NOT IN (SELECT oid FROM ar_table_owner)))
        OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = o.oid)
        OR EXISTS (SELECT 1 FROM pg_type t WHERE t.oid >= 16384 AND t.typowner = o.oid)
        OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = o.oid AND p.oid NOT IN (SELECT oid FROM ar_functions)))
   -- RC2 R2: the complete effective surface across every schema (ask-remote-surface.ts): schema-qualified relation allowlist,
   -- effective table/column grant options, schema CREATE/ownership, PUBLIC/built-in escalation, routines and other objects.
   + (SELECT coalesce(sum(${askRemoteSurfaceViolations('o.oid')}), 0)::int FROM ar_owner o)
  ) AS "arOwnerViolations",
  ((SELECT count(*)::int FROM ar_owner o CROSS JOIN ar_definer_table d LEFT JOIN ar_user_rels c ON c.pub = d.relname AND c.relkind = 'r'
     WHERE c.oid IS NULL OR NOT has_table_privilege(o.oid, c.oid, d.priv))
   + (SELECT count(*)::int FROM ar_owner o CROSS JOIN ar_definer_column d LEFT JOIN ar_user_rels c ON c.pub = d.relname AND c.relkind = 'r'
       WHERE c.oid IS NULL OR NOT has_column_privilege(o.oid, c.oid, d.attname, d.priv))
   + (SELECT count(*)::int FROM ar_owner o WHERE NOT has_schema_privilege(o.oid, 'public', 'USAGE'))
   + CASE WHEN EXISTS (SELECT 1 FROM ar_owner) THEN 0 ELSE 1 END) AS "arOwnerMissingGrants",
  ((SELECT count(*)::int FROM ar_acl a
     WHERE a.privilege_type <> 'EXECUTE' OR a.is_grantable
        OR NOT CASE a.spec WHEN 'runtime' THEN a.grantee = r.oid WHEN 'owner' THEN a.grantee = (SELECT oid FROM ar_table_owner) ELSE false END)
   + (SELECT count(*)::int FROM ar_spec s
       WHERE s.grantee <> 'none' AND (SELECT count(*) FROM ar_acl a WHERE a.proname = s.proname) <> 1)
   + (SELECT count(*)::int FROM ar_functions f JOIN ar_spec s ON s.proname = f.proname
       WHERE has_function_privilege(r.oid, f.oid, 'EXECUTE') <> (s.grantee = 'runtime'))
  ) AS "arExecuteViolations",
  ((SELECT count(*)::int FROM ar_present p, ${ALL_TABLE_PRIVS} v(priv)
     WHERE (v.priv <> 'SELECT' AND has_table_privilege(r.oid, p.oid, v.priv))
        OR (v.priv IN ('INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(r.oid, p.oid, v.priv))
        OR has_table_privilege(r.oid, p.oid, v.priv || ' WITH GRANT OPTION'))
   + (SELECT count(*)::int FROM ar_present p JOIN pg_attribute a ON a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped, ${COLUMN_PRIVS} v(priv)
       WHERE has_column_privilege(r.oid, p.oid, a.attnum, v.priv || ' WITH GRANT OPTION'))
  ) AS "arRuntimeGrantViolations",
  ((SELECT count(*)::int FROM ar_tables t LEFT JOIN ar_present p ON p.relname = t.relname
     WHERE p.oid IS NULL OR NOT has_table_privilege(r.oid, p.oid, 'SELECT'))
   + (SELECT count(*)::int FROM ar_spec s WHERE s.grantee = 'runtime'
       AND NOT EXISTS (SELECT 1 FROM ar_functions f WHERE f.proname = s.proname AND has_function_privilege(r.oid, f.oid, 'EXECUTE')))
  ) AS "arRuntimeMissingGrants"`;

/** The ASK-REMOTE facts alone, for the current role. */
export const ASK_REMOTE_READY_SQL = `WITH unused AS (SELECT 1)${ASK_REMOTE_CTES}
  SELECT ${ASK_REMOTE_COLUMNS} FROM pg_roles r WHERE r.rolname = current_user`;

export interface AskRemoteFacts {
  arTableViolations: number; arTriggerViolations: number; arRoutineViolations: number; arOwnerViolations: number;
  arOwnerMissingGrants: number; arExecuteViolations: number; arRuntimeGrantViolations: number; arRuntimeMissingGrants: number;
}
/** Problems of the ASK-REMOTE surface, as fixed reasons (empty = ready). Never echoes catalog values. */
export function askRemoteProblems(facts: AskRemoteFacts | undefined): string[] {
  if (!facts) return ['no ASK-REMOTE facts'];
  const checks: [keyof AskRemoteFacts, string][] = [
    ['arTableViolations', 'ASK-REMOTE tables lack FORCE RLS, their exact workspace policy, contract CHECK or scoped foreign keys'],
    ['arTriggerViolations', 'ASK-REMOTE guard or ledger triggers missing, altered or not ENABLE ALWAYS'],
    ['arRoutineViolations', 'ASK-REMOTE routines are not exactly the confined definer set (PUBLIC, missing, extra or altered); run prisma/roles.sql'],
    ['arOwnerViolations', 'ASK-REMOTE routine owner is not the confined remote definer (attributes, membership or privileges); run prisma/roles.sql'],
    ['arOwnerMissingGrants', 'ASK-REMOTE definer lacks its specified grants; run prisma/roles.sql'],
    ['arExecuteViolations', 'ASK-REMOTE routine EXECUTE is not exactly runtime reserve/settle/pause/reserve_floor and owner provisioning; run prisma/roles.sql'],
    ['arRuntimeGrantViolations', 'runtime holds ASK-REMOTE table write privileges (or grant options); run prisma/roles.sql'],
    ['arRuntimeMissingGrants', 'runtime lacks ASK-REMOTE SELECT or routine EXECUTE; run prisma/roles.sql'],
  ];
  return checks.filter(([key]) => Number(facts[key]) !== 0).map(([, reason]) => reason);
}
