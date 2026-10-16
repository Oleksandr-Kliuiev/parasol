import { AtlasError } from '../core/contracts.ts';
import { ACTION_FENCE_COLUMNS, ACTION_FENCE_CTES, ACTION_TABLES, actionFenceProblems } from './fence-role.ts';
import type { ActionFenceFacts } from './fence-role.ts';
import { POWEROFFICE_COLUMNS, POWEROFFICE_CTES, POWEROFFICE_TABLES, powerOfficeProblems } from './poweroffice-role.ts';
import type { PowerOfficeFacts } from './poweroffice-role.ts';
import { ASK_REMOTE_COLUMNS, ASK_REMOTE_CTES, ASK_REMOTE_TABLES, askRemoteProblems } from './ask-remote-role.ts';
import type { AskRemoteFacts } from './ask-remote-role.ts';
import { REVAL_COLUMNS, REVAL_CTES, REVAL_TABLES, revalProblems } from './reval-role.ts';
import type { RevalFacts } from './reval-role.ts';

/**
 * Startup self-check of the runtime role (API, worker, ops CLI), Prisma-free so the PGlite and PostgreSQL checks run the
 * same statement. It fails closed whenever RLS cannot confine the role or prisma/roles.sql has not (re)applied the Stage 2
 * grants after a migration: an upgraded database keeps the runtime stopped until provisioning passed.
 */

/** Microsoft 365 tables (migrations 202610081000/1100). */
export const M365_TABLES: readonly string[] = [
  'M365ResourceState', 'M365DirectoryGeneration', 'M365DirectoryObject', 'M365SyncRequest', 'M365SyncRootJob',
  'M365SignInWindow', 'M365WindowAttempt', 'M365WindowLeaf', 'M365SignInEvidence', 'M365WindowEvidence'
];
/** Every table protected with row-level security. The runtime check covers all of them. */
export const PROTECTED_TABLES: readonly string[] = [
  'Workspace', 'Client', 'Entity', 'Person', 'Device', 'Connection', 'ExternalEntity', 'EntityLink', 'RawEvent', 'DecisionRun',
  'Observation', 'SyncState', 'ToolExecution', 'AuditEvent', 'SecurityAuditEvent', 'Approval', 'Actor', 'ClientMembership', 'ApiToken',
  'ResourceSnapshot', 'ShadowJob', ...M365_TABLES, ...ACTION_TABLES, ...POWEROFFICE_TABLES, ...ASK_REMOTE_TABLES, ...REVAL_TABLES
];
/**
 * The only M365 columns the runtime may UPDATE (prisma/roles.sql §2): claim, sequence, pointer, status and counter
 * columns. Identity, fixed bounds, DTOs, hashes and memberships are never updatable; any other UPDATE privilege on an M365
 * table (for example from ALTER DEFAULT PRIVILEGES after a migration) fails the check.
 */
export const M365_RUNTIME_UPDATE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  M365ResourceState: ['latestStartedSeq', 'latestRecordedSeq', 'latestPublishedSeq', 'activeGenerationId', 'lastAttemptAt', 'lastSuccessAt', 'status', 'safeErrorCode', 'retryAt', 'attemptsUsed'],
  M365DirectoryGeneration: ['state', 'claimToken', 'leaseExpiresAt', 'completedAt', 'rowCount', 'safeErrorCode', 'expiresAt'],
  M365DirectoryObject: ['externalEntityId'],
  M365SyncRequest: ['totalLeaves', 'totalStagedRows', 'state', 'finishedAt'],
  M365SyncRootJob: ['attemptsUsed', 'retryAt', 'state', 'safeErrorCode', 'updatedAt'],
  M365SignInWindow: ['latestStartedSeq', 'latestRecordedSeq', 'latestPublishedSeq', 'publishedAttemptId', 'status', 'safeErrorCode', 'lastAttemptAt', 'lastSuccessAt'],
  M365WindowAttempt: ['claimToken', 'leaseExpiresAt', 'state', 'completedAt', 'publishedAt', 'safeErrorCode', 'evidenceCount', 'leafCount', 'stagedRows', 'expiresAt'],
  M365WindowLeaf: ['state', 'pagesRead', 'rowCount', 'safeErrorCode'],
  M365SignInEvidence: ['lastSeenAt', 'expiresAt'],
  M365WindowEvidence: [],
});
export const CLEANUP_ROUTINE = 'atlas_m365_cleanup';
/** Tables whose expired rows the definer deletes (SELECT + DELETE, table level). */
export const DEFINER_DELETE_TABLES: readonly string[] = ['M365DirectoryObject', 'M365DirectoryGeneration', 'M365WindowEvidence', 'M365WindowLeaf',
  'M365WindowAttempt', 'M365SignInEvidence'];
/**
 * The cleanup definer's EXACT privileges on protected tables (02_CONTRACTS §6, prisma/roles.sql §3). Every entry is
 * required — the routine cannot lock, read or delete without it — and any other privilege on a protected table is
 * forbidden. Table level: SELECT/DELETE on the payload tables, SELECT on the two pointer-state tables, INSERT on the audit.
 */
export const DEFINER_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...Object.fromEntries(DEFINER_DELETE_TABLES.map(t => [t, ['SELECT', 'DELETE']])),
  M365ResourceState: ['SELECT'], M365SignInWindow: ['SELECT'], AuditEvent: ['INSERT'],
});
/** Column level: Connection SELECT on six columns and UPDATE(id) for the row lock only; UPDATE of current pointer/status. */
export const DEFINER_COLUMN_PRIVILEGES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  Connection: { SELECT: ['id', 'workspaceId', 'clientId', 'system', 'status', 'lifecycleVersion'], UPDATE: ['id'] },
  M365ResourceState: { UPDATE: ['activeGenerationId', 'status', 'safeErrorCode'] },
  M365SignInWindow: { UPDATE: ['publishedAttemptId', 'status', 'safeErrorCode'] },
});
export const DEFINER_CONNECTION_COLUMNS: readonly string[] = DEFINER_COLUMN_PRIVILEGES.Connection!.SELECT!;

const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');
const updatable = Object.entries(M365_RUNTIME_UPDATE_COLUMNS).flatMap(([t, cols]) => cols.map(c => `('${t}','${c}')`)).join(',');
const definerTable = Object.entries(DEFINER_TABLE_PRIVILEGES).flatMap(([t, ps]) => ps.map(p => `('${t}','${p}')`)).join(',');
const definerColumn = Object.entries(DEFINER_COLUMN_PRIVILEGES)
  .flatMap(([t, byPrivilege]) => Object.entries(byPrivilege).flatMap(([p, cols]) => cols.map(c => `('${t}','${p}','${c}')`))).join(',');

/**
 * Facts about the current role and the cleanup routine:
 *   superuser / bypassRls        — policies are skipped entirely;
 *   sessionRoleMismatch          — the check runs under SET ROLE from another session user (who could RESET ROLE);
 *   runtimeAttributeViolations   — not LOGIN NOINHERIT, or CREATEROLE / CREATEDB / REPLICATION (as prisma/roles.sql);
 *   runtimeMemberships           — outgoing memberships: any role the runtime belongs to, directly (and so transitively),
 *                                  with or without INHERIT/SET — a SET ROLE path invisible to the privilege functions;
 *   ownsProtectedTables          — the role owns, directly or through membership, any protected table;
 *   unprotectedTables            — protected tables that are missing or have RLS disabled in the current schema;
 *   cleanupRoutines              — the confined routine exists exactly once;
 *   runtimeCanExecuteCleanup     — the runtime (or PUBLIC) may call it;
 *   deletableTables              — protected tables the runtime may DELETE or TRUNCATE;
 *   unguardedUpdateColumns       — M365 columns the runtime may UPDATE outside the allowlist;
 *   missingUpdateColumns         — allowlisted M365 columns the runtime cannot UPDATE (or that do not exist): after a new
 *                                  migration the runtime stays stopped until prisma/roles.sql granted them again;
 *   cleanupOwnerViolations       — the routine owner is not a confined definer: superuser, BYPASSRLS, LOGIN, CREATEROLE,
 *                                  CREATEDB, REPLICATION, member of any role or of a table owner, having any member other
 *                                  than the table owner (the migration owner may hold SET for the ownership transfer), the
 *                                  runtime itself or a role the runtime belongs to, or holding any privilege on a protected table (table or
 *                                  column level) outside DEFINER_TABLE_PRIVILEGES / DEFINER_COLUMN_PRIVILEGES;
 *   cleanupOwnerMissingGrants    — privileges of that specification the owner does not hold (the routine would fail);
 *   po* (poweroffice-role.ts)    — Stage 4: the PowerOffice tables, policies, triggers, confined cleanup routine/definer/runner
 *                                  and the runtime's exact PowerOffice grants;
 *   ar* (ask-remote-role.ts)     — Stage 5 ASK-REMOTE R-A: the four remote tables (FORCE RLS, policy, FKs, CHECKs), guard/
 *                                  ledger triggers, the eight routines of the confined remote definer, their exact EXECUTE
 *                                  ACLs and the runtime's SELECT-only access (checked in every Ask mode, OFF/MOCK included);
 *   action* (fence-role.ts)      — Stage 3: the fence trigger function, its dedicated definer (attributes, memberships, exact
 *                                  privileges), the fence/action policies and FORCE RLS, enabled fence and history triggers,
 *                                  and the exact runtime grants on the action tables (broad default grants fail);
 *   cleanupExecuteViolations     — the routine ACL (NULL = default PUBLIC EXECUTE) besides the owner is not exactly one
 *                                  grantee holding EXECUTE without grant option that looks like the confined runner: not
 *                                  PUBLIC, LOGIN, NOINHERIT, no SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION, no
 *                                  memberships either way (no SET ROLE path, in particular not from the runtime) except the
 *                                  table owner's ADMIN-only creator link (PostgreSQL 16+, no SET, no INHERIT), owning
 *                                  nothing and holding no privilege on any protected table.
 */
export const RUNTIME_ROLE_CHECK_SQL = `
  WITH protected AS (SELECT unnest(ARRAY[${list(PROTECTED_TABLES)}]) AS relname),
       present AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname IN (SELECT relname FROM protected)),
       updatable(relname, attname) AS (VALUES ${updatable}),
       routine AS (SELECT p.oid, p.proowner, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = current_schema() AND p.proname = '${CLEANUP_ROUTINE}'),
       routine_acl AS (SELECT a.grantee, a.privilege_type, a.is_grantable
                         FROM (SELECT x.proowner, (aclexplode(coalesce(x.proacl, acldefault('f', x.proowner)))).* FROM routine x) a
                        WHERE a.grantee <> a.proowner),
       definer AS (SELECT o.* FROM routine x JOIN pg_roles o ON o.oid = x.proowner),
       definer_table(relname, priv) AS (VALUES ${definerTable}),
       definer_column(relname, priv, attname) AS (VALUES ${definerColumn}),
       table_privs(priv) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
       column_privs(priv) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES'))${ACTION_FENCE_CTES}${POWEROFFICE_CTES}${ASK_REMOTE_CTES}${REVAL_CTES}
  SELECT r.rolsuper AS "superuser", r.rolbypassrls AS "bypassRls",
         (session_user <> current_user) AS "sessionRoleMismatch",
         ((r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit OR NOT r.rolcanlogin)::int) AS "runtimeAttributeViolations",
         (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS "runtimeMemberships",
         EXISTS (SELECT 1 FROM present p WHERE pg_has_role(r.oid, p.relowner, 'MEMBER')) AS "ownsProtectedTables",
         (SELECT count(*)::int FROM protected t LEFT JOIN present p ON p.relname = t.relname WHERE p.relname IS NULL OR NOT p.relrowsecurity) AS "unprotectedTables",
         (SELECT count(*)::int FROM routine) AS "cleanupRoutines",
         EXISTS (SELECT 1 FROM routine x WHERE has_function_privilege(r.oid, x.oid, 'EXECUTE')) AS "runtimeCanExecuteCleanup",
         (SELECT count(*)::int FROM present p WHERE has_table_privilege(r.oid, p.oid, 'DELETE') OR has_table_privilege(r.oid, p.oid, 'TRUNCATE')) AS "deletableTables",
         (SELECT count(*)::int FROM present p JOIN pg_attribute a ON a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped
           WHERE p.relname IN (${list(M365_TABLES)}) AND has_column_privilege(r.oid, p.oid, a.attnum, 'UPDATE')
             AND NOT EXISTS (SELECT 1 FROM updatable u WHERE u.relname = p.relname AND u.attname = a.attname)) AS "unguardedUpdateColumns",
         (SELECT count(*)::int FROM updatable u LEFT JOIN present p ON p.relname = u.relname
           LEFT JOIN pg_attribute a ON a.attrelid = p.oid AND a.attname = u.attname AND NOT a.attisdropped
           WHERE a.attnum IS NULL OR NOT has_column_privilege(r.oid, p.oid, a.attnum, 'UPDATE')) AS "missingUpdateColumns",
         ((SELECT count(*)::int FROM definer o
            WHERE o.rolsuper OR o.rolbypassrls OR o.rolcanlogin OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication
               OR o.oid = r.oid OR pg_has_role(r.oid, o.oid, 'MEMBER')
               OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = o.oid)
               OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = o.oid AND m.member NOT IN (SELECT relowner FROM present))
               OR EXISTS (SELECT 1 FROM present p WHERE pg_has_role(o.oid, p.relowner, 'MEMBER')))
          + (SELECT count(*)::int FROM definer o, present p, table_privs v
              WHERE has_table_privilege(o.oid, p.oid, v.priv)
                AND NOT EXISTS (SELECT 1 FROM definer_table d WHERE d.relname = p.relname AND d.priv = v.priv))
          + (SELECT count(*)::int FROM definer o, present p JOIN pg_attribute a ON a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped, column_privs v
              WHERE has_column_privilege(o.oid, p.oid, a.attnum, v.priv)
                AND NOT EXISTS (SELECT 1 FROM definer_table d WHERE d.relname = p.relname AND d.priv = v.priv)
                AND NOT EXISTS (SELECT 1 FROM definer_column d WHERE d.relname = p.relname AND d.priv = v.priv AND d.attname = a.attname))
         ) AS "cleanupOwnerViolations",
         ((SELECT count(*)::int FROM definer o, definer_table d LEFT JOIN present p ON p.relname = d.relname
            WHERE p.oid IS NULL OR NOT has_table_privilege(o.oid, p.oid, d.priv))
          + (SELECT count(*)::int FROM definer o, definer_column d LEFT JOIN present p ON p.relname = d.relname
              WHERE p.oid IS NULL OR NOT has_column_privilege(o.oid, p.oid, d.attname, d.priv))
         ) AS "cleanupOwnerMissingGrants",
         ((SELECT count(*)::int FROM routine_acl a LEFT JOIN pg_roles g ON g.oid = a.grantee
            WHERE a.grantee = 0 OR g.oid IS NULL OR a.privilege_type <> 'EXECUTE' OR a.is_grantable
               OR g.rolsuper OR g.rolbypassrls OR g.rolcreaterole OR g.rolcreatedb OR g.rolreplication OR g.rolinherit OR NOT g.rolcanlogin
               OR g.oid = r.oid OR pg_has_role(r.oid, g.oid, 'MEMBER')
               OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = g.oid OR (m.roleid = g.oid
                    AND NOT (m.member IN (SELECT relowner FROM present) AND NOT m.set_option AND NOT m.inherit_option)))
               OR EXISTS (SELECT 1 FROM present p WHERE pg_has_role(g.oid, p.relowner, 'MEMBER')
                            OR has_any_column_privilege(g.oid, p.oid, 'SELECT') OR has_any_column_privilege(g.oid, p.oid, 'INSERT')
                            OR has_any_column_privilege(g.oid, p.oid, 'UPDATE') OR has_any_column_privilege(g.oid, p.oid, 'REFERENCES')
                            OR has_table_privilege(g.oid, p.oid, 'DELETE') OR has_table_privilege(g.oid, p.oid, 'TRUNCATE')
                            OR has_table_privilege(g.oid, p.oid, 'TRIGGER')))
          + CASE WHEN (SELECT count(DISTINCT grantee) FROM routine_acl) = 1 THEN 0 ELSE 1 END
         ) AS "cleanupExecuteViolations",${ACTION_FENCE_COLUMNS},${POWEROFFICE_COLUMNS},${ASK_REMOTE_COLUMNS},${REVAL_COLUMNS}
  FROM pg_roles r WHERE r.rolname = current_user`;
export interface RuntimeRoleFacts extends ActionFenceFacts, PowerOfficeFacts, AskRemoteFacts, RevalFacts {
  superuser: boolean; bypassRls: boolean; ownsProtectedTables: boolean; unprotectedTables: number;
  sessionRoleMismatch: boolean; runtimeAttributeViolations: number; runtimeMemberships: number;
  cleanupRoutines: number; runtimeCanExecuteCleanup: boolean; deletableTables: number; unguardedUpdateColumns: number; missingUpdateColumns: number;
  cleanupOwnerViolations: number; cleanupOwnerMissingGrants: number; cleanupExecuteViolations: number;
}
export function assertConfinedRuntimeRole(facts: RuntimeRoleFacts | undefined): void {
  if (!facts) throw new AtlasError('RUNTIME_ROLE_BYPASSES_RLS', 'PERMANENT', { reason: 'no role facts' });
  if (facts.superuser) throw new AtlasError('RUNTIME_ROLE_BYPASSES_RLS', 'PERMANENT', { reason: 'superuser' });
  if (facts.bypassRls) throw new AtlasError('RUNTIME_ROLE_BYPASSES_RLS', 'PERMANENT', { reason: 'BYPASSRLS' });
  if (facts.ownsProtectedTables) throw new AtlasError('RUNTIME_ROLE_BYPASSES_RLS', 'PERMANENT', { reason: 'owns protected tables' });
  if (Number(facts.unprotectedTables) > 0) throw new AtlasError('RLS_NOT_ENABLED', 'PERMANENT', { unprotectedTables: String(facts.unprotectedTables) });
  const notConfined = (reason: string) => new AtlasError('RUNTIME_ROLE_NOT_CONFINED', 'PERMANENT', { reason });
  // The same confinement prisma/roles.sql requires: privileges reachable by SET ROLE (NOINHERIT hides them from the
  // privilege functions) or held by another session user are never acceptable, whatever they grant.
  if (facts.sessionRoleMismatch) throw notConfined('the session user is not the runtime role (SET ROLE from another login)');
  if (Number(facts.runtimeAttributeViolations) > 0) throw notConfined('runtime role must be LOGIN NOINHERIT without CREATEROLE, CREATEDB or REPLICATION');
  if (Number(facts.runtimeMemberships) > 0) throw notConfined('runtime role is a member of another role (a SET ROLE or inheritance path)');
  if (Number(facts.cleanupRoutines) !== 1) throw notConfined('cleanup routine missing');
  if (facts.runtimeCanExecuteCleanup) throw notConfined('runtime can execute the cleanup routine');
  if (Number(facts.deletableTables) > 0) throw notConfined('runtime can delete or truncate protected tables');
  if (Number(facts.unguardedUpdateColumns) > 0) throw notConfined('runtime can update immutable M365 columns; run prisma/roles.sql');
  if (Number(facts.missingUpdateColumns) > 0) throw notConfined('runtime lacks an M365 state-column grant; run prisma/roles.sql');
  if (Number(facts.cleanupOwnerViolations) > 0) throw notConfined('cleanup routine owner is not a confined definer; run prisma/roles.sql');
  if (Number(facts.cleanupOwnerMissingGrants) !== 0) throw notConfined('cleanup definer lacks its specified grants; run prisma/roles.sql');
  if (Number(facts.cleanupExecuteViolations) !== 0) throw notConfined('cleanup routine EXECUTE is not exactly the confined runner; run prisma/roles.sql');
  const fenceProblem = actionFenceProblems(facts)[0];
  if (fenceProblem !== undefined) throw notConfined(fenceProblem);
  const powerOfficeProblem = powerOfficeProblems(facts)[0];
  if (powerOfficeProblem !== undefined) throw notConfined(powerOfficeProblem);
  const askRemoteProblem = askRemoteProblems(facts)[0];
  if (askRemoteProblem !== undefined) throw notConfined(askRemoteProblem);
  const revalProblem = revalProblems(facts)[0];
  if (revalProblem !== undefined) throw notConfined(revalProblem);
}
