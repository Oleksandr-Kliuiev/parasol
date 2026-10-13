import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { POWEROFFICE_READY_SQL } from '../../packages/graph/poweroffice-role.ts';
import type { PowerOfficeFacts } from '../../packages/graph/poweroffice-role.ts';
import { RUNTIME_ROLE_CHECK_SQL } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { readRolesSql, renderRolesSql } from './roles-sql.ts';
import type { RoleNames } from './roles-sql.ts';

/**
 * TEST-ONLY rollback envelope for privilege drift on BUILT-IN or SHARED/cluster-visible catalogs (pg_parameter_acl,
 * pg_database, pg_tablespace, built-in routine/relation ACLs). Such grants are never committed: the owner connection opens
 * one transaction, applies the drift, evaluates readiness on that SAME connection under SET LOCAL ROLE (so it sees the
 * uncommitted ACL) and runs the production prisma/roles.sql BODY — the rendered script with exactly its outer BEGIN/COMMIT
 * removed — under a savepoint; the envelope ALWAYS ends with ROLLBACK. Other sessions never see the drift.
 */
export async function provisioningBody(roles: RoleNames): Promise<string> {
  const rendered = renderRolesSql(await readRolesSql(), roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
  const begins = rendered.match(/^BEGIN;$/gm)?.length ?? 0;
  const commits = rendered.match(/^COMMIT;$/gm)?.length ?? 0;
  if (begins !== 1 || commits !== 1 || !rendered.trimEnd().endsWith('\nCOMMIT;')) throw new Error('prisma/roles.sql changed shape: expected one outer BEGIN/COMMIT');
  const body = rendered.replace(/^BEGIN;$/m, '').replace(/^COMMIT;\s*$/m, '');
  // Exactly one DO $roles$ … $roles$ block and, after it, exactly one inlined R-EVAL DO $reval$ … $reval$ block
  // (prisma/roles/reval.sql); outside them no transaction control may remain (PL/pgSQL BEGIN/END inside is not one).
  const parts = body.split('$roles$');
  if (parts.length !== 3) throw new Error('prisma/roles.sql changed shape: expected one DO $roles$ block');
  const tail = parts[2]!.split('$reval$');
  if (tail.length !== 3) throw new Error('prisma/roles.sql changed shape: expected one DO $reval$ block after $roles$');
  if ([parts[0]!, tail[0]!, tail[2]!].some(t => /^\s*(BEGIN|COMMIT|END|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b/im.test(t))) {
    throw new Error('transaction control left in the roles.sql body');
  }
  return body;
}

/** Runs `fn` inside one owner transaction that is ALWAYS rolled back, whatever happens. */
export async function inRollbackEnvelope<T>(owner: pg.Client, fn: () => Promise<T>): Promise<T> {
  await owner.query('BEGIN');
  try { return await fn(); } finally { await owner.query('ROLLBACK'); }
}

/** Inside the envelope: the production provisioning body under a savepoint; undefined when it succeeded, else its message. */
export async function provisionInEnvelope(owner: pg.Client, body: string): Promise<string | undefined> {
  await owner.query('SAVEPOINT s4a_provision');
  try { await owner.query(body); await owner.query('RELEASE SAVEPOINT s4a_provision'); return undefined; }
  catch (error) { await owner.query('ROLLBACK TO SAVEPOINT s4a_provision'); return (error as Error).message; }
}

/** Inside the envelope: PowerOffice readiness facts evaluated as the runtime role on the same connection. */
export async function factsInEnvelope(owner: pg.Client, runtimeRole: string): Promise<PowerOfficeFacts> {
  await owner.query(`SET LOCAL ROLE "${runtimeRole}"`);
  try {
    // SET LOCAL takes effect only inside a transaction block; outside one the facts would silently be the owner's.
    if ((await owner.query(`SELECT current_user AS u`)).rows[0].u !== runtimeRole) throw new Error('factsInEnvelope needs the rollback envelope');
    return (await owner.query(POWEROFFICE_READY_SQL)).rows[0] as PowerOfficeFacts;
  } finally { await owner.query('RESET ROLE'); }
}

/**
 * Inside the envelope: the FULL runtime startup facts (RUNTIME_ROLE_CHECK_SQL) evaluated with SET LOCAL SESSION
 * AUTHORIZATION to the confined runtime (superuser owner only), so session_user = current_user = runtime as for a login.
 */
export async function runtimeFactsInEnvelope(owner: pg.Client, runtimeRole: string): Promise<RuntimeRoleFacts> {
  await owner.query(`SET LOCAL SESSION AUTHORIZATION "${runtimeRole}"`);
  try {
    const who = (await owner.query(`SELECT session_user AS s, current_user AS u`)).rows[0];
    if (who.s !== runtimeRole || who.u !== runtimeRole) throw new Error('runtimeFactsInEnvelope needs the rollback envelope');
    return (await owner.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as RuntimeRoleFacts;
  } finally { await owner.query('RESET SESSION AUTHORIZATION'); }
}

/** ACL metadata of the shared/built-in objects the envelope tests touch (no credential/password row, no file read). */
export async function sharedAclSnapshot(c: pg.Client): Promise<unknown> {
  return (await c.query(`SELECT
      (SELECT coalesce(json_agg(json_build_object('p', parname, 'acl', paracl::text) ORDER BY parname), '[]'::json) FROM pg_parameter_acl) AS parameters,
      (SELECT datacl::text FROM pg_database WHERE datname = current_database()) AS database,
      (SELECT json_agg(json_build_object('t', spcname, 'acl', spcacl::text) ORDER BY spcname) FROM pg_tablespace) AS tablespaces,
      (SELECT json_agg(json_build_object('o', p.oid::regprocedure::text, 'acl', p.proacl::text) ORDER BY p.oid)
         FROM pg_proc p WHERE p.oid IN ('pg_catalog.pg_read_file(text)'::regprocedure, 'pg_catalog.lower(text)'::regprocedure)) AS routines,
      (SELECT json_agg(json_build_object('r', c.oid::regclass::text, 'acl', c.relacl::text,
                'cols', (SELECT json_agg(a.attacl::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL)) ORDER BY c.oid)
         FROM pg_class c WHERE c.oid IN ('pg_catalog.pg_authid'::regclass, 'information_schema._pg_user_mappings'::regclass,
                                         'information_schema.sql_parts'::regclass, 'information_schema.transforms'::regclass)) AS relations`)).rows[0];
}
