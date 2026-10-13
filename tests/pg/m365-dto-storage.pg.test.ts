import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import pg from 'pg';
import type { Actor } from '../../packages/core/contracts.ts';
import { withScope } from '../../packages/graph/scoped-db.ts';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { seedM365 } from '../m365-sql-invariants.ts';
import { checkM365DtoStorage, maxDevice, maxSignIn, maxUser } from '../m365-dto-storage-invariants.ts';
import { createTestDatabase } from '../support/pg-harness.ts';

// Review S2-A-rc4 on PostgreSQL 17: the largest parser outputs fit the SQL aggregate byte caps. The shared cases run as the
// owner; the production path — generated Prisma client, runtime role with its exact grants, client scope — persists the
// same maximum DTOs.
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
const shared = await createTestDatabase();
const scoped = await createTestDatabase();
const runtime = new PrismaClient({ datasourceUrl: scoped.runtimeUrl });
after(async () => { await runtime.$disconnect(); await shared.drop(); await scoped.drop(); });

test('shared parser → storage invariants on a real server (owner session; constraints apply to every role)', async () => {
  await seedGraph(asRunner(shared.owner));
  await checkM365DtoStorage(asRunner(shared.owner));
});

test('as the runtime role through Prisma: maximum user, device and sign-in DTOs are stored and read back unchanged', async () => {
  await seedGraph(asRunner(scoped.owner));
  await seedM365(asRunner(scoped.owner));
  const c1: Actor = { id: 'dto-probe', workspaceId: 'w', workspacePermissions: [], memberships: [{ clientId: 'c1', permissions: ['events:ingest'] }] };
  const key = { workspaceId: 'w', clientId: 'c1', connectionId: 'm1' };
  const user = maxUser(); const device = maxDevice(); const signIn = maxSignIn();
  const json = (dto: object) => dto as unknown as Prisma.InputJsonObject; // DTO interfaces carry no index signature
  await withScope(runtime, c1, ['c1'], async tx => {
    for (const [resourceType, dto] of [['m365_user', user], ['m365_device', device]] as const) {
      await tx.m365ResourceState.create({ data: { ...key, resourceType, latestStartedSeq: 1 }, select: { status: true } });
      await tx.m365DirectoryGeneration.create({ data: { ...key, resourceType, id: `rt-${resourceType}`, attemptSeq: 1, lifecycleVersion: 1, claimToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 600_000), expiresAt: new Date(Date.now() + 3_600_000) }, select: { id: true } });
      await tx.m365DirectoryObject.create({ data: { ...key, resourceType, generationId: `rt-${resourceType}`, sourceObjectId: dto.id,
        deviceId: 'deviceId' in dto ? dto.deviceId : null, dto: json(dto) }, select: { sourceObjectId: true } });
    }
    await tx.m365SignInEvidence.create({ data: { ...key, id: 'rt-signin', sourceId: signIn.id, contentHash: 'b'.repeat(64), dto: json(signIn),
      occurredAt: new Date(), userId: signIn.userId, deviceId: signIn.deviceId, expiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } });
  });
  const read = await withScope(runtime, c1, ['c1'], async tx => ({
    objects: (await tx.m365DirectoryObject.findMany({ select: { dto: true }, orderBy: { resourceType: 'desc' } })).map(o => o.dto),
    signIn: (await tx.m365SignInEvidence.findUnique({ where: { workspaceId_clientId_connectionId_id: { ...key, id: 'rt-signin' } }, select: { dto: true } }))?.dto }));
  assert.deepEqual(read, { objects: [user, device], signIn });
});
