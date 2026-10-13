import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import type { Actor } from '../../packages/core/contracts.ts';
import { withScope } from '../../packages/graph/scoped-db.ts';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { checkM365Structure, guid } from '../m365-sql-invariants.ts';
import { createTestDatabase } from '../support/pg-harness.ts';

// Stage 2 A2 on PostgreSQL 17: the SQL invariants of migrations 202610081000/1100 on a real server, then the same
// composite keys through the generated Prisma client and the runtime role (relations, typed FKs, column-limited UPDATE).
const pgdb = await createTestDatabase();
const runtime = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await runtime.$disconnect(); await pgdb.drop(); });
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
const c1: Actor = { id: 'schema-probe', workspaceId: 'w', workspacePermissions: [], memberships: [{ clientId: 'c1', permissions: ['events:ingest'] }] };
const inC1 = <T>(fn: Parameters<typeof withScope<T>>[3]) => withScope(runtime, c1, ['c1'], fn);
const key = { workspaceId: 'w', clientId: 'c1' };
const USER = guid('a'); const DEVICE = guid('b');
const deviceDto = { id: DEVICE, deviceId: guid('c'), displayName: 'GASTA-LT-07', accountEnabled: true, operatingSystem: 'Windows' };
const fk = /Foreign key constraint|foreign key|P2003/;

test('owner-level SQL invariants on a real server: scope FKs, typed mirrors/links, fence, immutability, retention, leaf partitions', async () => {
  await seedGraph(asRunner(pgdb.owner));
  await checkM365Structure(asRunner(pgdb.owner)); // tenants m1, m1b (c1) and m2 (c2); mirrors xu1/xd1 on m1, xu1b on m1b
});

test('generated Prisma client + runtime role: composite keys pin client, connection, generation and type; the same vendor ID in two tenants stays distinct', async () => {
  const twins = await inC1(tx => tx.externalEntity.findMany({ where: { externalId: USER }, select: { id: true, connectionId: true, resourceType: true }, orderBy: { id: 'asc' } }));
  assert.deepEqual(twins, [{ id: 'xu1', connectionId: 'm1', resourceType: 'm365_user' }, { id: 'xu1b', connectionId: 'm1b', resourceType: 'm365_user' }]);
  const gen = { ...key, connectionId: 'm1b', resourceType: 'm365_device', id: 'pg-gen-1' };
  await inC1(async tx => {
    await tx.m365ResourceState.create({ data: { ...key, connectionId: 'm1b', resourceType: 'm365_device', latestStartedSeq: 1 }, select: { status: true } });
    await tx.m365DirectoryGeneration.create({ data: { ...gen, attemptSeq: 1, lifecycleVersion: 1, claimToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 600_000), expiresAt: new Date(Date.now() + 3_600_000) }, select: { id: true } });
    await tx.externalEntity.create({ data: { ...key, id: 'xd1b', connectionId: 'm1b', resourceType: 'm365_device', externalId: DEVICE, attributes: {}, observedAt: new Date() },
      select: { id: true } });
  });
  const object = (mirror: string | null, over: Record<string, string> = {}) => inC1(tx => tx.m365DirectoryObject.create({ data: { ...key, connectionId: 'm1b',
    resourceType: 'm365_device', generationId: 'pg-gen-1', sourceObjectId: DEVICE, externalEntityId: mirror, deviceId: deviceDto.deviceId, dto: deviceDto, ...over },
    select: { sourceObjectId: true } }));
  await assert.rejects(object('xu1b'), fk, 'a user mirror for a device object');
  await assert.rejects(object('xd1'), fk, 'the mirror of the same object ID in another tenant');
  // A parent that is not visible (another connection's state, another client) is refused as a missing prerequisite
  const missingGeneration = /needs its STAGING generation to exist first/;
  await assert.rejects(object('xd1b', { generationId: 'g3' }), missingGeneration, "a generation of another connection's state");
  await assert.rejects(object('xd1b', { clientId: 'c2' }), missingGeneration, 'another client: its generation is invisible under this scope');
  await object('xd1b');
  // Publication and pointer through Prisma; the relations navigate the same composite keys
  await inC1(async tx => {
    await tx.m365DirectoryGeneration.update({ where: { workspaceId_clientId_connectionId_resourceType_id: gen }, select: { id: true },
      data: { state: 'PUBLISHED', completedAt: new Date(), claimToken: null, leaseExpiresAt: null, rowCount: 1, expiresAt: new Date(Date.now() + 23 * 3_600_000) } });
    await tx.m365ResourceState.update({ where: { workspaceId_clientId_connectionId_resourceType: { ...key, connectionId: 'm1b', resourceType: 'm365_device' } },
      data: { activeGenerationId: 'pg-gen-1', latestPublishedSeq: 1, latestRecordedSeq: 1, status: 'OK', lastAttemptAt: new Date(), lastSuccessAt: new Date() }, select: { status: true } });
  });
  const state = await inC1(tx => tx.m365ResourceState.findUnique({ where: { workspaceId_clientId_connectionId_resourceType: { ...key, connectionId: 'm1b', resourceType: 'm365_device' } },
    select: { status: true, activeGeneration: { select: { state: true, objects: { select: { sourceObjectId: true, mirror: { select: { id: true, connectionId: true } } } } } } } }));
  assert.deepEqual(state, { status: 'OK', activeGeneration: { state: 'PUBLISHED', objects: [{ sourceObjectId: DEVICE, mirror: { id: 'xd1b', connectionId: 'm1b' } }] } });
  // Column-limited UPDATE: identity and payload columns are not updatable by the runtime role at all
  await assert.rejects(inC1(tx => tx.m365DirectoryGeneration.update({ where: { workspaceId_clientId_connectionId_resourceType_id: gen }, data: { attemptSeq: 9 }, select: { id: true } })),
    /permission denied|42501/);
  await assert.rejects(inC1(tx => tx.m365DirectoryObject.updateMany({ where: { generationId: 'pg-gen-1' }, data: { sourceObjectId: USER } })), /permission denied|42501/);
  // A sign-in attempt cannot reference the root of another connection
  await assert.rejects(inC1(tx => tx.m365WindowAttempt.create({ data: { ...key, connectionId: 'm1b', windowId: 'win1', id: 'att-x', rootFrom: new Date('2026-10-01T10:00:00Z'),
    requestId: 'req1', attemptSeq: 1, lifecycleVersion: 1, coveredFrom: new Date('2026-10-01T10:00:00Z'), coveredTo: new Date('2026-10-01T11:00:00Z'), configVersion: 'm365-sync.1',
    claimToken: crypto.randomUUID(), leaseExpiresAt: new Date(Date.now() + 600_000), deadlineAt: new Date(Date.now() + 600_000), expiresAt: new Date(Date.now() + 3_600_000) },
    select: { id: true } })), /needs its window to exist first/);
});
