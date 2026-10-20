import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../packages/core/contracts.ts';
import type { DbObservationRow } from '../packages/graph/context-mapper.ts';
import { assertObservationId, getObservationSummary } from '../packages/graph/prisma-context.ts';
import { observationSelect } from '../packages/observations/query.ts';
import { actor, scope } from '../fixtures/gasta.ts';

test('exact observation IDs accept the stored lifecycle vocabulary and reject unbounded/control/path input', () => {
  for (const id of ['obs-1', 'A_b.c:d', 'a'.repeat(100)]) assert.doesNotThrow(() => assertObservationId(id));
  for (const id of ['', ' ', 'a'.repeat(101), '../observation', 'x/y', 'x\u0000y', 'x\ny', 'ä', null, 12])
    assert.throws(() => assertObservationId(id as string), /INVALID_OBSERVATION_ID/);
});

test('the exact reader checks permission and input before opening a scoped transaction', async () => {
  const db = { $transaction: () => { throw new Error('database must not be read'); } } as unknown as PrismaClient;
  const noRead: Actor = { ...actor, memberships: [{ clientId: scope.clientId, permissions: ['events:ingest'] }] };
  await assert.rejects(getObservationSummary(db, noRead, scope, 'obs-1'), /PERMISSION_DENIED/);
  await assert.rejects(getObservationSummary(db, actor, { ...scope, clientId: 'other-client' }, 'obs-1'), /SCOPE_DENIED/);
  await assert.rejects(getObservationSummary(db, actor, { ...scope, workspaceId: 'other-workspace' }, 'obs-1'), /SCOPE_DENIED/);
  await assert.rejects(getObservationSummary(db, actor, scope, 'bad/id'), /INVALID_OBSERVATION_ID/);
});

test('the exact query uses the complete scoped key and the same allowlisted projection as observation pages', async () => {
  const calls: string[] = [];
  let row: DbObservationRow | null = {
    id: 'obs-1', eventId: 'raw-1', entityId: null, decisionRunId: null, domain: 'SECURITY', severity: 'CRITICAL', priority: 'URGENT',
    route: 'MONITOR', confidence: 1, provider: 'rules', reasonCodes: ['SOURCE_URGENCY_FLOOR'], status: 'RESOLVED',
    acknowledgedAt: null, resolvedAt: new Date('2026-10-16T12:00:00Z'), supersededById: null,
    createdAt: new Date('2026-10-15T12:00:00Z'), updatedAt: new Date('2026-10-16T12:00:00Z'),
    event: { eventKey: 'event-1', conflictOfEventKey: null, connectionId: 'connection-1', resourceType: 'incident', externalEventId: 'incident-1',
      revision: '1', occurredAt: new Date('2026-10-15T11:00:00Z'), normalized: { kind: 'SECURITY_INCIDENT', summary: 'Synthetic closed incident',
        secret: 'must not be projected' }, connection: { system: 'huntress' } },
  };
  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, workspace: string, clients: string) => {
      calls.push('scope'); assert.deepEqual([workspace, clients], [scope.workspaceId, scope.clientId]);
    },
    observation: { findUnique: async (query: unknown) => {
      calls.push('read'); assert.deepEqual(query, { where: { workspaceId_clientId_id: { ...scope, id: 'obs-1' } }, select: observationSelect });
      return row;
    } },
  };
  const db = { $transaction: async (read: (value: typeof tx) => Promise<unknown>) => read(tx) } as unknown as PrismaClient;
  const result = await getObservationSummary(db, actor, scope, 'obs-1');
  assert.deepEqual(calls, ['scope', 'read']);
  assert.deepEqual([result?.workspaceId, result?.clientId, result?.id, result?.status, result?.summary, result?.priority],
    [scope.workspaceId, scope.clientId, 'obs-1', 'RESOLVED', 'Synthetic closed incident', 'URGENT']);
  assert.ok(!JSON.stringify(result).includes('must not be projected'));
  row = null;
  assert.equal(await getObservationSummary(db, actor, scope, 'obs-1'), null, 'missing is distinct from a fabricated empty observation');
});
