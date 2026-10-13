import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { AtlasError } from '../packages/core/contracts.ts';
import type { Actor } from '../packages/core/contracts.ts';
import { recordUnlessDenied, withDenialAudit } from '../packages/m365/denial.ts';

// Review RC2-R4 (unit): the M365 sync boundary helper appends exactly one safe workspace denial per invocation, never
// swallows a failed audit write, passes other errors through unaudited, and rethrows a denial of the original operation or
// of its failure recording instead of reporting an outcome as recorded.
const actor: Actor = { id: 'op-1', workspaceId: 'w', workspacePermissions: [], memberships: [{ clientId: 'c1', permissions: ['events:ingest'] }] };
const scope = { workspaceId: 'w', clientId: 'c1' };
const denied = () => new AtlasError('PERMISSION_DENIED', 'SCOPE');
function fakeDb(fail = false) {
  const rows: Record<string, unknown>[] = [];
  const tx = { $queryRaw: async () => [], securityAuditEvent: { create: async (args: { data: Record<string, unknown> }) => { rows.push(args.data); return { id: 'x' }; } } };
  const db = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => { if (fail) throw new Error('database unavailable'); return fn(tx); } };
  return { db: db as unknown as PrismaClient, rows };
}

test('a denial is audited once in the workspace with safe fields only, then rethrown', async () => {
  const { db, rows } = fakeDb();
  await assert.rejects(withDenialAudit(db, actor, scope, 'm365.directory_sync_denied', async () => { throw denied(); }), /PERMISSION_DENIED/);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.deepEqual([row.workspaceId, row.actorId, row.eventType, row.outcome, row.requestedClientId, row.reasonCode, row.metadata],
    ['w', 'op-1', 'm365.directory_sync_denied', 'DENIED', 'c1', 'PERMISSION_DENIED', {}]);
  assert.match(String(row.correlationId), /^[0-9a-f-]{36}$/);
  await assert.rejects(withDenialAudit(db, actor, { workspaceId: 'w', clientId: 'other' }, 'm365.signin_sync_denied', async () => { throw new AtlasError('SCOPE_DENIED', 'SCOPE'); }), /SCOPE_DENIED/);
  assert.deepEqual([rows[1]!.requestedClientId, rows[1]!.reasonCode], ['other', 'SCOPE_DENIED']);
  await assert.rejects(withDenialAudit(db, actor, scope, 'e', async () => { throw new AtlasError('M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT'); }), /UPSTREAM/);
  assert.equal(rows.length, 2, 'other failures are not security denials');
  assert.equal(await withDenialAudit(db, actor, scope, 'e', async () => 42), 42);
});

test('a failed audit write is never swallowed: SECURITY_AUDIT_FAILED instead of a denial that looks recorded', async () => {
  const { db, rows } = fakeDb(true);
  const error = await withDenialAudit(db, actor, scope, 'm365.directory_sync_denied', async () => { throw denied(); }).catch(e => e) as AtlasError;
  assert.deepEqual([error.code, error.kind, error.details.reasonCode, rows.length], ['SECURITY_AUDIT_FAILED', 'PERMANENT', 'PERMISSION_DENIED', 0]);
});

test('failure recording: a denial of the origin or of the recording is rethrown; other recording errors stay honestly unrecorded', async () => {
  const unrecorded = { recorded: false };
  const ok = async () => ({ recorded: true });
  assert.deepEqual(await recordUnlessDenied(new AtlasError('M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT'), ok, unrecorded), { recorded: true });
  await assert.rejects(recordUnlessDenied(denied(), ok, unrecorded), /PERMISSION_DENIED/, 'withdrawn mid-I/O: never reported as a recorded failure');
  await assert.rejects(recordUnlessDenied(denied(), async () => { throw denied(); }, unrecorded), /PERMISSION_DENIED/);
  await assert.rejects(recordUnlessDenied(new AtlasError('M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT'), async () => { throw new AtlasError('SCOPE_DENIED', 'SCOPE'); }, unrecorded),
    /SCOPE_DENIED/, 'withdrawn between the error and its recording');
  assert.deepEqual(await recordUnlessDenied(new AtlasError('M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT'), async () => { throw new Error('db'); }, unrecorded), unrecorded);
});
