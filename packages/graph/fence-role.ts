/**
 * Readiness facts of the Stage 3 action surface (docs/stage3/03_DATA_AND_CONCURRENCY.md): the privileged authority fence
 * (trigger function, dedicated definer, its policy and triggers) and the exact runtime grants on the action tables.
 * Prisma-free SQL fragments, evaluated for the CURRENT role as `r` — inside the runtime startup check (runtime-role.ts)
 * and again by every fenced action admission (ACTION_FENCE_READY_SQL). Global fence-row completeness is NOT a runtime
 * fact: the runtime sees only its own workspace; prisma/roles.sql counts it as the owner and the fence definer.
 */
export const ACTION_FENCE_FUNCTION = 'atlas_action_authority_fence';
export const ACTION_FENCE_GUARD_FUNCTION = 'atlas_action_fence_guard';
export const ACTION_TABLES: readonly string[] = ['ActionAuthorityFence', 'ActionRequest', 'ActionApproval', 'ActionAttempt', 'ActionVerification', 'ActionMockTicket'];
/**
 * Runtime privileges on the action tables (prisma/roles.sql): SELECT on all; INSERT and column UPDATE exactly as listed.
 * S3-B adds the approval/reservation writes: request and approval lifecycle columns, approval and attempt INSERT.
 * S3-C adds execution/verification: the request's set-once result ID, the attempt's outcome and claim columns, verification
 * INSERT + state/completion/safe code, synthetic ticket INSERT only (the same columns the history triggers let change).
 */
export const ACTION_RUNTIME_PRIVILEGES: Readonly<Record<string, { insert: boolean; update: readonly string[] }>> = Object.freeze({
  ActionAuthorityFence: { insert: false, update: ['workspaceId'] },
  ActionRequest: { insert: true, update: ['state', 'safeErrorCode', 'updatedAt', 'terminalAt', 'resultTicketId'] },
  ActionApproval: { insert: true, update: ['decision', 'consumedAt', 'revokedAt', 'safeErrorCode'] },
  ActionAttempt: { insert: true, update: ['state', 'originalTicketId', 'verifiedTicketId', 'safeErrorCode', 'outcomeAt', 'updatedAt', 'verificationCount',
    'verificationSeq', 'verificationState', 'activeVerificationToken', 'activeVerificationOrdinal', 'activeStartedAt', 'activeDeadlineAt', 'activeCandidateId'] },
  ActionVerification: { insert: true, update: ['state', 'completedAt', 'safeErrorCode'] },
  ActionMockTicket: { insert: true, update: [] },
});
/** The fence definer's only privileges: column level on the fence table. Anything else on any relation is a violation. */
export const FENCE_DEFINER_COLUMN_PRIVILEGES: readonly [column: string, privilege: string][] = [
  ['workspaceId', 'SELECT'], ['version', 'SELECT'], ['workspaceId', 'INSERT'], ['version', 'INSERT'], ['version', 'UPDATE'],
];
/**
 * The only application routines the fence definer may EXECUTE besides its own trigger function: the accepted Stage 1/2
 * SECURITY INVOKER helpers and trigger functions that keep PostgreSQL's default PUBLIC EXECUTE (an invoker routine runs
 * with the caller's own privileges, so it adds no authority). Exact `schema.name(identity arguments)` identities (schema
 * and name as quote_ident renders them; all in public) — a routine of the same name in another schema is not allowed; no generic
 * allowance for invoker, trigger or PUBLIC routines. Any other executable routine (a new PUBLIC function, a SECURITY
 * DEFINER one, or ANY explicit grant to the definer, even on a listed helper) fails readiness; prisma/roles.sql removes
 * explicit grants it can revoke and otherwise refuses. Same list in prisma/roles.sql §4b.
 */
export const FENCE_SHARED_INVOKER_ROUTINES: readonly string[] = [
  'public.atlas_app_actor()', 'public.atlas_app_clients()', 'public.atlas_app_token_hash()', 'public.atlas_app_workspace()',
  'public.atlas_connection_lifecycle()', 'public.atlas_external_entity_system()', 'public.atlas_m365_attempt_completed_with_pointer()',
  'public.atlas_m365_attribute_codes(attributes jsonb)', 'public.atlas_m365_connection_fence(p_workspace text, p_client text, p_connection text, p_version integer)',
  'public.atlas_m365_directory_dto(resource text, dto jsonb)', 'public.atlas_m365_directory_generation()', 'public.atlas_m365_directory_object()',
  'public.atlas_m365_generation_published_with_pointer()', 'public.atlas_m365_reject_truncate()', 'public.atlas_m365_resource_budget()', 'public.atlas_m365_resource_retry()',
  'public.atlas_m365_resource_state()', 'public.atlas_m365_root_job()', 'public.atlas_m365_signin_dto(dto jsonb)', 'public.atlas_m365_signin_evidence()',
  'public.atlas_m365_signin_window()', 'public.atlas_m365_sync_request()', 'public.atlas_m365_window_attempt()', 'public.atlas_m365_window_evidence()',
  'public.atlas_m365_window_leaf()', 'public.atlas_observation_lifecycle()', 'public.atlas_protect_legacy_closure()', 'public.atlas_reject_approval_input_mutation()',
  'public.atlas_reject_audit_mutation()', 'public.atlas_reject_connection_rebinding()', 'public.atlas_require_canonical_conflict_parent()', 'public.atlas_tool_execution_ledger()',
];
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32.
const ROW_BEFORE_IUD = 31; const ROW_BEFORE_UD = 27; const ROW_BEFORE_IU = 23; const ROW_AFTER_I = 5; const STMT_BEFORE_TRUNCATE = 34;
const fence = ACTION_FENCE_FUNCTION; const guard = ACTION_FENCE_GUARD_FUNCTION;
/** Fence triggers fire ALWAYS ('A', also under replica mode); action history triggers must be enabled ('O' or 'A'). */
type TriggerSpec = readonly [table: string, trigger: string, fn: string, tgtype: number, always: boolean];
export const ACTION_TRIGGERS: readonly TriggerSpec[] = [
  ...['Actor', 'ClientMembership', 'ApiToken', 'Connection'].flatMap((t): TriggerSpec[] => [
    [t, `${t}_action_fence`, fence, ROW_BEFORE_IUD, true], [t, `${t}_action_fence_truncate`, guard, STMT_BEFORE_TRUNCATE, true]]),
  ['Workspace', 'Workspace_action_fence_init', fence, ROW_AFTER_I, true],
  ['Workspace', 'Workspace_action_fence_guard', guard, ROW_BEFORE_UD, true],
  ['Workspace', 'Workspace_action_fence_truncate', guard, STMT_BEFORE_TRUNCATE, true],
  ['ActionAuthorityFence', 'ActionAuthorityFence_guard', guard, ROW_BEFORE_IUD, true],
  ['ActionAuthorityFence', 'ActionAuthorityFence_truncate', guard, STMT_BEFORE_TRUNCATE, true],
  ...['ActionRequest', 'ActionApproval', 'ActionAttempt', 'ActionVerification', 'ActionMockTicket'].flatMap((t): TriggerSpec[] => [
    [t, `${t}_history`, 'atlas_action_history_guard', ROW_BEFORE_UD, false], [t, `${t}_truncate`, 'atlas_action_history_guard', STMT_BEFORE_TRUNCATE, false],
    ...(t === 'ActionMockTicket' ? [] : [[t, `${t}_lifecycle`, 'atlas_action_lifecycle_guard', ROW_BEFORE_IU, false] as TriggerSpec])]),
];
const SCOPE_QUAL = '("workspaceId" = atlas_app_workspace())';
const CLIENT_SCOPE_QUAL = '(("workspaceId" = atlas_app_workspace()) AND ("clientId" = ANY (atlas_app_clients())))';
const FENCE_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const rows = (values: readonly (readonly (string | number | boolean)[])[]) =>
  values.map(v => `(${v.map(x => typeof x === 'string' ? q(x) : String(x)).join(',')})`).join(',');
const actionRuntime = rows(Object.entries(ACTION_RUNTIME_PRIVILEGES).map(([t, p]) => [t, p.insert]));
const actionUpdate = rows(Object.entries(ACTION_RUNTIME_PRIVILEGES).flatMap(([t, p]) => p.update.map(c => [t, c])));
const schemaRel = (alias: string) => `JOIN pg_namespace ${alias}n ON ${alias}n.oid = ${alias}.relnamespace AND ${alias}n.nspname = current_schema()`;

/** CTE definitions (each preceded by a comma) to append to a WITH list. */
export const ACTION_FENCE_CTES = `,
  fence_fn AS (SELECT p.oid, p.proowner, p.proacl, p.prosecdef, p.prorettype, p.pronargs, p.proconfig FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema() AND p.proname = ${q(fence)}),
  fence_owner AS (SELECT o.* FROM fence_fn f JOIN pg_roles o ON o.oid = f.proowner),
  fence_rel AS (SELECT c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c ${schemaRel('c')}
                WHERE c.relkind = 'r' AND c.relname = 'ActionAuthorityFence'),
  schema_rels AS (SELECT c.oid, c.relname, c.relkind FROM pg_class c ${schemaRel('c')} WHERE c.relkind IN ('r','p','v','m','f','S')),
  fence_cols(attname, priv) AS (VALUES ${rows(FENCE_DEFINER_COLUMN_PRIVILEGES)}),
  fence_shared(signature) AS (VALUES ${rows(FENCE_SHARED_INVOKER_ROUTINES.map(r => [r]))}),
  app_routines AS (SELECT p.oid, quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
                          p.prosecdef, p.proowner, p.proacl
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND left(n.nspname, 3) <> 'pg_'),
  action_runtime(relname, ins) AS (VALUES ${actionRuntime}),
  action_update(relname, attname) AS (VALUES ${actionUpdate}),
  action_present AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c ${schemaRel('c')}
                     WHERE c.relkind = 'r' AND c.relname IN (SELECT relname FROM action_runtime)),
  action_triggers(relname, tgname, fn, tgtype, always) AS (VALUES ${rows(ACTION_TRIGGERS)})`;

/** Select-list columns over `r` (pg_roles row of the current role). */
export const ACTION_FENCE_COLUMNS = `
  (SELECT count(*)::int FROM fence_fn) AS "actionFenceFunctions",
  (SELECT count(*)::int FROM fence_fn f
    WHERE NOT f.prosecdef OR f.prorettype <> 'pg_catalog.trigger'::regtype OR f.pronargs <> 0
       OR f.proconfig IS DISTINCT FROM ARRAY[${q(FENCE_SEARCH_PATH)}]::text[] OR has_function_privilege(r.oid, f.oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a WHERE a.grantee <> f.proowner)) AS "actionFenceFunctionViolations",
  ((SELECT count(*)::int FROM fence_owner o
     WHERE o.rolsuper OR o.rolbypassrls OR o.rolcanlogin OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication OR o.rolinherit
        OR o.oid = r.oid OR pg_has_role(r.oid, o.oid, 'MEMBER') OR has_schema_privilege(o.oid, current_schema(), 'CREATE')
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = o.oid)
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = o.oid AND (m.inherit_option OR m.member NOT IN (SELECT relowner FROM fence_rel)))
        OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = o.oid)
        OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = o.oid AND p.oid NOT IN (SELECT oid FROM fence_fn)))
   + (SELECT count(*)::int FROM fence_owner o, schema_rels c, (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(priv)
       WHERE c.relkind <> 'S' AND has_table_privilege(o.oid, c.oid, v.priv))
   + (SELECT count(*)::int FROM fence_owner o, schema_rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped,
              (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(priv)
       WHERE c.relkind <> 'S' AND has_column_privilege(o.oid, c.oid, a.attnum, v.priv)
         AND NOT (c.relname = 'ActionAuthorityFence' AND EXISTS (SELECT 1 FROM fence_cols f WHERE f.attname = a.attname AND f.priv = v.priv)))
   + (SELECT count(*)::int FROM fence_owner o, schema_rels c WHERE c.relkind = 'S' AND has_sequence_privilege(o.oid, c.oid, 'USAGE,SELECT,UPDATE'))
  ) AS "actionFenceOwnerViolations",
  ((SELECT count(*)::int FROM fence_owner o CROSS JOIN fence_cols f LEFT JOIN fence_rel t ON true
     WHERE t.oid IS NULL OR NOT has_column_privilege(o.oid, t.oid, f.attname, f.priv))
   + (SELECT count(*)::int FROM fence_owner o WHERE NOT has_schema_privilege(o.oid, current_schema(), 'USAGE'))
   + CASE WHEN EXISTS (SELECT 1 FROM fence_owner) THEN 0 ELSE 1 END) AS "actionFenceMissingGrants",
  (SELECT count(*)::int FROM fence_owner o CROSS JOIN app_routines x
    WHERE x.oid NOT IN (SELECT oid FROM fence_fn) AND has_function_privilege(o.oid, x.oid, 'EXECUTE')
      AND (x.prosecdef OR x.signature NOT IN (SELECT signature FROM fence_shared)
           OR EXISTS (SELECT 1 FROM aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a WHERE a.grantee = o.oid))) AS "actionFenceRoutineViolations",
  ((SELECT count(*)::int FROM fence_rel t JOIN pg_policy p ON p.polrelid = t.oid
     WHERE NOT ((p.polname = 'ActionAuthorityFence_scope' AND p.polpermissive AND p.polcmd = '*' AND p.polroles = ARRAY[0]::oid[]
                 AND pg_get_expr(p.polqual, p.polrelid) = ${q(SCOPE_QUAL)} AND pg_get_expr(p.polwithcheck, p.polrelid) = ${q(SCOPE_QUAL)})
             OR (p.polname = 'ActionAuthorityFence_definer' AND p.polpermissive AND p.polcmd = '*'
                 AND p.polroles = ARRAY[(SELECT f.proowner FROM fence_fn f LIMIT 1)]::oid[]
                 AND pg_get_expr(p.polqual, p.polrelid) = 'true' AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true')))
   + CASE WHEN (SELECT count(*) FROM fence_rel t JOIN pg_policy p ON p.polrelid = t.oid) = 2 THEN 0 ELSE 1 END
   + (SELECT count(*)::int FROM action_present t JOIN pg_policy p ON p.polrelid = t.oid
       WHERE t.relname <> 'ActionAuthorityFence' AND NOT (p.polname = t.relname || '_scope' AND p.polpermissive AND p.polcmd = '*'
             AND p.polroles = ARRAY[0]::oid[] AND pg_get_expr(p.polqual, p.polrelid) = ${q(CLIENT_SCOPE_QUAL)}
             AND pg_get_expr(p.polwithcheck, p.polrelid) = ${q(CLIENT_SCOPE_QUAL)}))
   + (SELECT count(*)::int FROM action_runtime t LEFT JOIN action_present p ON p.relname = t.relname
       WHERE p.oid IS NULL OR NOT p.relrowsecurity OR NOT p.relforcerowsecurity
          OR (t.relname <> 'ActionAuthorityFence' AND (SELECT count(*) FROM pg_policy x WHERE x.polrelid = p.oid) <> 1))
  ) AS "actionPolicyViolations",
  (SELECT count(*)::int FROM action_triggers e
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ${schemaRel('c')}
                        JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = current_schema()
                       WHERE c.relname = e.relname AND t.tgname = e.tgname AND p.proname = e.fn AND t.tgtype = e.tgtype
                         AND NOT t.tgisinternal AND (t.tgenabled = 'A' OR (NOT e.always AND t.tgenabled = 'O')))) AS "actionTriggerViolations",
  ((SELECT count(*)::int FROM action_runtime t JOIN action_present p ON p.relname = t.relname
     WHERE (NOT t.ins AND has_any_column_privilege(r.oid, p.oid, 'INSERT'))
        OR has_any_column_privilege(r.oid, p.oid, 'REFERENCES') OR has_table_privilege(r.oid, p.oid, 'TRIGGER'))
   + (SELECT count(*)::int FROM action_present p JOIN pg_attribute a ON a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE has_column_privilege(r.oid, p.oid, a.attnum, 'UPDATE')
         AND NOT EXISTS (SELECT 1 FROM action_update u WHERE u.relname = p.relname AND u.attname = a.attname))
  ) AS "actionRuntimeGrantViolations",
  ((SELECT count(*)::int FROM action_runtime t LEFT JOIN action_present p ON p.relname = t.relname
     WHERE p.oid IS NULL OR NOT has_table_privilege(r.oid, p.oid, 'SELECT') OR (t.ins AND NOT has_table_privilege(r.oid, p.oid, 'INSERT')))
   + (SELECT count(*)::int FROM action_update u LEFT JOIN action_present p ON p.relname = u.relname
       WHERE p.oid IS NULL OR NOT has_column_privilege(r.oid, p.oid, u.attname, 'UPDATE'))
  ) AS "actionRuntimeMissingGrants"`;

/** The fence/action facts alone, for the current role: re-evaluated by every fenced action admission. */
export const ACTION_FENCE_READY_SQL = `WITH unused AS (SELECT 1)${ACTION_FENCE_CTES}
  SELECT ${ACTION_FENCE_COLUMNS} FROM pg_roles r WHERE r.rolname = current_user`;

export interface ActionFenceFacts {
  actionFenceFunctions: number; actionFenceFunctionViolations: number; actionFenceOwnerViolations: number; actionFenceMissingGrants: number;
  actionFenceRoutineViolations: number;
  actionPolicyViolations: number; actionTriggerViolations: number; actionRuntimeGrantViolations: number; actionRuntimeMissingGrants: number;
}
/** Problems of the action surface, as fixed reasons (empty = ready). Never echoes catalog values. */
export function actionFenceProblems(facts: ActionFenceFacts | undefined): string[] {
  if (!facts) return ['no action fence facts'];
  const problems: string[] = [];
  if (Number(facts.actionFenceFunctions) !== 1) problems.push('action fence function missing');
  if (Number(facts.actionFenceFunctionViolations) !== 0) problems.push('action fence function is not a confined trigger-only SECURITY DEFINER; run prisma/roles.sql');
  if (Number(facts.actionFenceOwnerViolations) !== 0) problems.push('action fence owner is not the confined fence definer; run prisma/roles.sql');
  if (Number(facts.actionFenceMissingGrants) !== 0) problems.push('action fence definer lacks its specified grants; run prisma/roles.sql');
  if (Number(facts.actionFenceRoutineViolations) !== 0) problems.push('action fence definer can execute an unexpected routine; run prisma/roles.sql');
  if (Number(facts.actionPolicyViolations) !== 0) problems.push('action tables lack FORCE RLS or their exact policies; run prisma/roles.sql');
  if (Number(facts.actionTriggerViolations) !== 0) problems.push('action fence or history triggers missing or disabled');
  if (Number(facts.actionRuntimeGrantViolations) !== 0) problems.push('runtime holds action-table privileges outside the allowlist; run prisma/roles.sql');
  if (Number(facts.actionRuntimeMissingGrants) !== 0) problems.push('runtime lacks an action-table grant; run prisma/roles.sql');
  return problems;
}
