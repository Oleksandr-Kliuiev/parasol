import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import type { Actor } from '../../packages/core/contracts.ts';
import { executeTool } from '../../packages/tools/gateway.ts';
import { atlasTools } from '../../packages/tools/composed-registry.ts';
import { PrismaToolLedger, databaseReaders } from '../../packages/tools/prisma-ledger.ts';
import { PrismaAudit, PrismaSecurityAudit } from '../../packages/audit/prisma.ts';
import { parseToolRequest } from '../../apps/api/src/http-boundary.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { KARI, OTHER_DEVICE, REGISTRATION, addHuntressObservation, addReader, confirmM365Links, publishScenarioDirectory, publishSignIns, readDeps, reader,
  signIn } from '../support/correlation-fixtures.ts';

// The two M365 tools through the PostgreSQL gateway with the ONE composed registry (tests/pg/m365-tools.pg.test.ts):
// policy all-of on one membership (single/split denied → client tool.denied), runtime schema (tool.rejected), execution
// ledger STARTED → SUCCEEDED/FAILED with allowlisted audit only — also when the CURRENT authority is gone after STARTED
// (FAILED + tool.failed alongside exactly one workspace denial), and the maximal parameter set below the 2048 body cap.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
const q = async (sql: string, params: unknown[] = []) => (await pgdb.owner.query(sql, params)).rows;
const mk = (id: string, memberships: Actor['memberships']): Actor => ({ id, workspaceId: WS, workspacePermissions: [], memberships });
const single = mk('demo-tool-single', [{ clientId: 'demo-gasta', permissions: ['context:read'] }]);
const split = mk('demo-tool-split', [{ clientId: 'demo-gasta', permissions: ['context:read'] }, { clientId: 'demo-other', permissions: ['m365:read'] }]);
const lost = mk('demo-tool-lost', reader.memberships); const gone = mk('demo-tool-gone', reader.memberships);
for (const a of [reader, single, split, lost, gone]) await addReader(pgdb.owner, a);
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
await addHuntressObservation(pgdb.owner, 'obs-t');
const R = hourStart(3); const end = new Date(R.getTime() + 3_600_000);
await publishSignIns(db, () => [signIn('t-1', iso(R, 60_000), KARI, OTHER_DEVICE), signIn('t-2', iso(R, 120_000), KARI, REGISTRATION)], R, end);
const params = { connectionId: M365_CONNECTION, observationId: 'obs-t', from: R.toISOString(), to: end.toISOString() };
const call = (actor: Actor, tool: string, parameters: unknown, correlationId: string) => executeTool(actor, gasta, { tool, parameters, correlationId },
  databaseReaders(db, actor, gasta, { cursorKey: readDeps().cursorKey, correlationId }),
  { audit: new PrismaAudit(db, actor), securityAudit: new PrismaSecurityAudit(db, actor), ledger: new PrismaToolLedger(db, actor) }, atlasTools);
const audit = async (correlationId: string) => (await q(`SELECT "eventType", metadata FROM "AuditEvent" WHERE "correlationId" = $1 ORDER BY "recordedAt", "eventType"`,
  [correlationId])).map(r => [r.eventType, r.metadata]);
const ledger = async (correlationId: string) => (await q(`SELECT "toolName", status, "safeErrorCode", "riskLevel", "sideEffect", length("inputHash") AS h FROM "ToolExecution"
  WHERE "correlationId" = $1`, [correlationId]));
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;

test('both permissions on one client: SUCCEEDED ledger with allowlisted audit and the correlation.read audit; result scoped and equal to the service', async () => {
  const out = await call(reader, 'atlas.observation.get_correlation', params, 'corr-tool-ok');
  const result = out.result as { contractVersion: string; total: number; items: { evidenceRef: { sourceId: string } }[] };
  assert.deepEqual([out.tool, out.toolVersion, result.contractVersion, result.total, result.items.map(i => i.evidenceRef.sourceId)],
    ['atlas.observation.get_correlation', '1', 'atlas.correlation.v1', 2, ['t-2', 't-1']]);
  assert.deepEqual(await ledger('corr-tool-ok'), [{ toolName: 'atlas.observation.get_correlation', status: 'SUCCEEDED', safeErrorCode: null, riskLevel: 0, sideEffect: 'NONE', h: 64 }]);
  const rows = await audit('corr-tool-ok');
  assert.deepEqual(rows.map(r => r[0]).sort(), ['correlation.read', 'tool.started', 'tool.succeeded']);
  assert.ok(!JSON.stringify(rows).includes(KARI) && !JSON.stringify(rows).includes('t-1'), 'no vendor ID or result in audit/ledger');
  const list = await call(reader, 'microsoft365.signin.list', { connectionId: M365_CONNECTION, from: params.from, to: params.to }, 'corr-tool-list');
  assert.deepEqual([(list.result as { contractVersion: string }).contractVersion, (await ledger('corr-tool-list'))[0]!.status], ['atlas.m365-signins.v1', 'SUCCEEDED']);
});

test('single permission and split clients: TOOL_DENIED with a client tool.denied row, no execution; schema violation is tool.rejected', async () => {
  for (const [actor, id] of [[single, 'corr-tool-single'], [split, 'corr-tool-split']] as const) {
    await assert.rejects(call(actor, 'atlas.observation.get_correlation', params, id), fails('TOOL_DENIED'));
    assert.deepEqual(await audit(id), [['tool.denied', { tool: 'atlas.observation.get_correlation', safeErrorCode: 'PERMISSION_DENIED' }]]);
    assert.deepEqual(await ledger(id), []);
  }
  await assert.rejects(call(reader, 'microsoft365.signin.list', { ...params }, 'corr-tool-rejected'), fails('INVALID_TOOL_PARAMETERS'));
  assert.deepEqual(await audit('corr-tool-rejected'), [['tool.rejected', { tool: 'microsoft365.signin.list', toolVersion: '1', safeErrorCode: 'INVALID_TOOL_PARAMETERS',
    parameter: 'unexpected' }]]);
  await assert.rejects(call(reader, 'atlas.observation.get_correlation', { ...params, cursor: `${'A'.repeat(469)}.${'A'.repeat(43)}` }, 'corr-tool-long'),
    fails('INVALID_TOOL_PARAMETERS'), 'a 513-character cursor fails the tool schema');
});

test('current authority lost after STARTED (membership changed or removed): FAILED + tool.failed with the safe code only, exactly one workspace denial', async () => {
  await q(`UPDATE "ClientMembership" SET permissions = '{context:read}' WHERE "actorId" = $1`, [lost.id]);
  await q(`DELETE FROM "ClientMembership" WHERE "actorId" = $1`, [gone.id]);
  for (const [actor, id] of [[lost, 'corr-tool-lost'], [gone, 'corr-tool-gone']] as const) {
    await assert.rejects(call(actor, 'atlas.observation.get_correlation', params, id), fails('PERMISSION_DENIED'));
    assert.deepEqual((await ledger(id)).map(r => [r.status, r.safeErrorCode]), [['FAILED', 'PERMISSION_DENIED']]);
    const rows = await audit(id);
    assert.deepEqual(rows.map(r => r[0]).sort(), ['tool.failed', 'tool.started']);
    assert.deepEqual(Object.keys(rows.find(r => r[0] === 'tool.failed')![1] as object).sort(), ['safeErrorCode', 'tool', 'toolExecutionId', 'toolVersion']);
    assert.deepEqual((await q(`SELECT "eventType", "reasonCode", metadata FROM "SecurityAuditEvent" WHERE "actorId" = $1`, [actor.id])),
      [{ eventType: 'correlation.read_denied', reasonCode: 'PERMISSION_DENIED', metadata: {} }]);
  }
});

test('maximal input — 128-character IDs, a 512-character cursor and every other parameter — stays below the 2048 body cap and reaches the MAC check', async () => {
  const long = (c: string) => `${c}${'x'.repeat(127)}`;
  const parameters = { connectionId: long('c'), observationId: long('o'), from: '2026-10-01T00:00:00.0000001Z', to: '2026-10-01T23:59:59.9999999Z', limit: 100,
    cursor: `${'A'.repeat(468)}.${'B'.repeat(43)}` };
  assert.ok(JSON.stringify(parameters).length < 2048);
  const request = parseToolRequest({ clientId: 'demo-gasta', tool: 'atlas.observation.get_correlation', parameters });
  await assert.rejects(call(reader, request.tool, request.parameters, 'corr-tool-max'), fails('CORRELATION_CURSOR_INVALID'));
  assert.deepEqual((await ledger('corr-tool-max')).map(r => [r.status, r.safeErrorCode]), [['FAILED', 'CORRELATION_CURSOR_INVALID']]);
});
