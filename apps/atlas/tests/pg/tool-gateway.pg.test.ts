import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type { Actor, ObservationPage, ResourceView, Scope, SnapshotItem } from '../../packages/core/contracts.ts';
import { PrismaAudit, PrismaSecurityAudit } from '../../packages/audit/prisma.ts';
import { executeTool, toolInputHash } from '../../packages/tools/gateway.ts';
import { PrismaToolLedger, databaseReaders } from '../../packages/tools/prisma-ledger.ts';
import { connectorFor, syncResource } from '../../packages/sync/snapshots.ts';
import { processPending } from '../../packages/events/worker.ts';
import { withScope } from '../../packages/graph/scoped-db.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta, other } from '../support/graph-fixtures.ts';
import { CountingProvider, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';

// Task 1.9 on PostgreSQL 17 through the runtime role: every execution is a ToolExecution row written with its audit rows;
// denials and rejections are audit rows only; read tools by source ID and the observation list read the scoped database;
// the runtime role cannot rewrite the ledger.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection, io } = await liveHuntressWithConfirmedAgent(db);
assert.equal((await syncResource(db, actors.sync, connection, connectorFor(db, actors.sync, connection, io), 'incident')).status, 'OK');
await processPending(db, actors.sync, gasta, { workerId: 'worker-a', provider: new CountingProvider(), retryDelayMs: () => 0 });
const reader = actors.reader;
const sinks = (actor: Actor) => ({ audit: new PrismaAudit(db, actor), securityAudit: new PrismaSecurityAudit(db, actor), ledger: new PrismaToolLedger(db, actor) });
const call = (tool: string, parameters?: unknown, correlationId?: string, scope: Scope = gasta, actor: Actor = reader) =>
  executeTool(actor, scope, { tool, parameters, correlationId }, databaseReaders(db, actor, scope), sinks(actor));
const executions = async () => (await pgdb.owner.query(`SELECT id, "toolName", "toolVersion", "riskLevel", "sideEffect", "inputHash", status, "correlationId",
  coalesce("safeErrorCode",'-') AS code, "finishedAt" IS NOT NULL AS finished, "actorId" FROM "ToolExecution" ORDER BY "createdAt", id`)).rows;
const auditOf = async (correlationId: string) => (await pgdb.owner.query(`SELECT "eventType"||'|'||coalesce(metadata->>'toolExecutionId','-')||'|'||coalesce(metadata->>'safeErrorCode','-') AS s
  FROM "AuditEvent" WHERE "correlationId" = $1 ORDER BY "recordedAt", "eventType" DESC`, [correlationId])).rows.map(r => r.s);

test('an execution is a ToolExecution row written with its audit rows under one correlation; a failed read is FAILED with its code', async () => {
  // The seeded fixture Huntress connection sits next to the live one: the caller names the live one (see the e2e for the refusal)
  const outcome = await call('huntress.incident.get', { incidentId: '9001', connectionId: 'gasta-huntress' }, 'req-tools-0001');
  const view = outcome.result as ResourceView<SnapshotItem>;
  assert.deepEqual([view.status, view.items?.map(i => i.externalId), view.truncated], ['OK', ['9001'], false]);
  const [row] = await executions();
  assert.deepEqual(row, { id: outcome.executionId, toolName: 'huntress.incident.get', toolVersion: '1', riskLevel: 0, sideEffect: 'NONE',
    inputHash: toolInputHash(gasta, { name: 'huntress.incident.get', version: '1' }, { incidentId: '9001', connectionId: 'gasta-huntress' }), status: 'SUCCEEDED',
    correlationId: 'req-tools-0001',
    code: '-', finished: true, actorId: 'demo-reader' });
  assert.deepEqual(await auditOf('req-tools-0001'), [`tool.started|${outcome.executionId}|-`, `tool.succeeded|${outcome.executionId}|-`]);
  const absent = (await call('huntress.incident.get', { incidentId: '9999', connectionId: 'gasta-huntress' })).result as ResourceView;
  assert.deepEqual([absent.status, absent.items], ['OK', []], 'read completely, and not there');
  const first = (await call('atlas.observation.list', { limit: 1 })).result as ObservationPage;
  const second = (await call('atlas.observation.list', { limit: 1, cursor: first.nextCursor })).result as ObservationPage;
  assert.ok(first.items[0] && second.items[0] && first.items[0].id !== second.items[0].id && first.total === 2, 'the tool pages with the database cursor');
  await assert.rejects(call('atlas.observation.list', { cursor: 'abc' }, 'req-tools-0002'), /INVALID_CURSOR/);
  const failed = (await executions()).at(-1)!;
  assert.deepEqual([failed.status, failed.code, failed.finished], ['FAILED', 'INVALID_CURSOR', true]);
  assert.deepEqual(await auditOf('req-tools-0002'), [`tool.started|${failed.id}|-`, `tool.failed|${failed.id}|INVALID_CURSOR`]);
});

test('denials and rejections are audit rows only, never executions; a scope denial never reaches the target client log', async () => {
  const before = (await executions()).length;
  await assert.rejects(call('atera.ticket.list', {}, 'req-tools-0003', other), /SCOPE_DENIED/);
  assert.deepEqual((await pgdb.owner.query(`SELECT "eventType", "requestedClientId", "reasonCode" FROM "SecurityAuditEvent" WHERE "correlationId" = 'req-tools-0003'`)).rows,
    [{ eventType: 'tool.scope_denied', requestedClientId: 'demo-other', reasonCode: 'SCOPE_DENIED' }]);
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "clientId" = 'demo-other'`)).rows[0].n), 0);
  for (const [tool, code] of [['atera.ticket.create', 'UNKNOWN_TOOL'], ['Atera.Ticket', 'INVALID_TOOL_NAME']] as const) {
    await assert.rejects(call(tool, {}, `req-${code.toLowerCase().replace(/_/g, '-')}`), /TOOL_DENIED/);
    assert.deepEqual(await auditOf(`req-${code.toLowerCase().replace(/_/g, '-')}`), [`tool.denied|-|${code}`]);
  }
  const noPermission: Actor = { ...reader, memberships: [{ clientId: 'demo-gasta', permissions: ['events:ingest'] }] };
  await assert.rejects(call('atera.ticket.list', {}, 'req-tools-0004', gasta, { ...noPermission, id: 'demo-sync' }), /TOOL_DENIED/);
  assert.deepEqual(await auditOf('req-tools-0004'), ['tool.denied|-|PERMISSION_DENIED']);
  await assert.rejects(call('atera.ticket.get', { ticketId: 'x', risk: 4 }, 'req-tools-0005'), /INVALID_TOOL_PARAMETERS/);
  assert.deepEqual((await pgdb.owner.query(`SELECT "eventType", metadata->>'parameter' AS parameter FROM "AuditEvent" WHERE "correlationId" = 'req-tools-0005'`)).rows,
    [{ eventType: 'tool.rejected', parameter: 'unexpected' }], 'a caller cannot pass risk; the undeclared key is not echoed');
  assert.equal((await executions()).length, before, 'no execution for any of them');
});

test('the runtime role cannot rewrite the ledger: an outcome is final, and nothing but a read tool can be recorded', async () => {
  const [row] = await executions();
  await assert.rejects(withScope(db, reader, ['demo-gasta'], tx => tx.toolExecution.updateMany({ where: { ...gasta, id: row!.id }, data: { status: 'FAILED', safeErrorCode: 'X' } })),
    /ledger/);
  await assert.rejects(withScope(db, reader, ['demo-gasta'], tx => tx.toolExecution.create({ data: { ...gasta, id: 'forged', actorId: 'demo-reader', toolName: 'atera.ticket.create',
    toolVersion: '1', riskLevel: 2, sideEffect: 'CREATE', inputHash: 'b'.repeat(64), status: 'STARTED', correlationId: 'req-forged-01' } })), /read_only_check/);
});
