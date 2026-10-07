import { PrismaClient } from '@prisma/client';
import { scope, people, devices, links } from '../fixtures/gasta.ts';
// Runs with the OWNER connection (DATABASE_URL), which bypasses row-level security by design; the application must use
// the confined runtime role instead (prisma/roles.sql, ATLAS_RUNTIME_DATABASE_URL).
const db = new PrismaClient();
try {
  // Non-destructive, synthetic local seed. No vendor API calls and no table clearing.
  await db.$transaction(async tx => {
    await tx.workspace.upsert({ where: { id: scope.workspaceId }, update: {}, create: { id: scope.workspaceId, name: 'Vardahei demo' } });
    await tx.client.upsert({ where: { workspaceId_id: { workspaceId: scope.workspaceId, id: scope.clientId } }, update: {}, create: { workspaceId: scope.workspaceId, id: scope.clientId, name: 'Gasta (synthetic)' } });
    for (const person of people) {
      const key = { workspaceId: scope.workspaceId, clientId: scope.clientId, id: person.id };
      await tx.entity.upsert({ where: { workspaceId_clientId_id: key }, update: {}, create: { ...key, kind: 'PERSON' } });
      await tx.person.upsert({ where: { workspaceId_clientId_id: key }, update: {}, create: person });
    }
    for (const device of devices) {
      const key = { workspaceId: scope.workspaceId, clientId: scope.clientId, id: device.id };
      await tx.entity.upsert({ where: { workspaceId_clientId_id: key }, update: {}, create: { ...key, kind: 'DEVICE' } });
      await tx.device.upsert({ where: { workspaceId_clientId_id: key }, update: {}, create: device });
    }
    for (const link of links) {
      const key = { ...scope, id: link.connectionId };
      await tx.connection.upsert({ where: { workspaceId_clientId_id: key }, update: {}, create: { ...key, system: link.system, externalTenantId: `${link.system}-synthetic-gasta`, secretRef: 'fixture://no-credentials', status: 'FIXTURE' } });
      const externalKey = { ...scope, id: `${link.system}-external-device` };
      await tx.externalEntity.upsert({ where: { workspaceId_clientId_id: externalKey }, update: {}, create: { ...externalKey, connectionId: link.connectionId, resourceType: link.resourceType, externalId: link.externalId, attributes: { hostname: 'GASTA-LT-07' }, observedAt: new Date('2026-10-07T07:00:00Z') } });
      const linkKey = { ...scope, id: `${link.system}-confirmed-link` };
      await tx.entityLink.upsert({ where: { workspaceId_clientId_id: linkKey }, update: {}, create: { ...linkKey, entityId: link.entityId, externalEntityId: externalKey.id, status: 'CONFIRMED', method: 'FIXTURE', confidence: 1, confirmedBy: 'demo-seeder', confirmedAt: new Date('2026-10-07T07:00:00Z') } });
    }
  });
  console.log('Synthetic Gasta/Kari/device graph seeded without deleting data.');
} finally { await db.$disconnect(); }
