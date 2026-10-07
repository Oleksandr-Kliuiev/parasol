import { PrismaClient } from '@prisma/client';
import { scope, actor, people, devices, links } from '../fixtures/gasta.ts';
import { BEARER_TOKEN_PATTERN, hashToken } from '../packages/auth/token.ts';
// Runs with the OWNER connection (DATABASE_URL), which bypasses row-level security by design; the application must use
// the confined runtime role instead (prisma/roles.sql, ATLAS_RUNTIME_DATABASE_URL).
// Optional: ATLAS_DEMO_TOKEN (your local random token) lets the synthetic actor call the DB-mode API. Only its SHA-256
// digest is stored; the token itself is never written or printed.
const demoToken = process.env.ATLAS_DEMO_TOKEN || null;
if (demoToken !== null && !BEARER_TOKEN_PATTERN.test(demoToken)) {
  console.error('ATLAS_DEMO_TOKEN must be 20-256 characters of A-Z a-z 0-9 - . _ ~ + / (optionally ending in =).');
  process.exit(2);
}
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
      await tx.connection.upsert({ where: { workspaceId_clientId_id: key }, update: {}, create: { ...key, system: link.system, externalTenantId: `${link.system}-synthetic-gasta`, secretRef: 'fixture://no-credentials', status: 'FIXTURE', boundBy: 'demo-seeder', boundAt: new Date('2026-10-07T07:00:00Z') } });
      const externalKey = { ...scope, id: `${link.system}-external-device` };
      await tx.externalEntity.upsert({ where: { workspaceId_clientId_id: externalKey }, update: {}, create: { ...externalKey, connectionId: link.connectionId, resourceType: link.resourceType, externalId: link.externalId, attributes: { hostname: 'GASTA-LT-07' }, observedAt: new Date('2026-10-07T07:00:00Z') } });
      const linkKey = { ...scope, id: `${link.system}-confirmed-link` };
      await tx.entityLink.upsert({ where: { workspaceId_clientId_id: linkKey }, update: {}, create: { ...linkKey, entityId: link.entityId, externalEntityId: externalKey.id, resourceType: link.resourceType, entityKind: link.entityKind, status: 'CONFIRMED', method: 'FIXTURE', confidence: 1, confirmedBy: 'demo-seeder', confirmedAt: new Date('2026-10-07T07:00:00Z'), createdBy: 'demo-seeder', reviewedBy: 'demo-seeder', reviewedAt: new Date('2026-10-07T07:00:00Z') } });
    }
    // Synthetic technician with the per-client membership of fixtures/gasta.ts (task 1.3)
    await tx.actor.upsert({ where: { workspaceId_id: { workspaceId: actor.workspaceId, id: actor.id } }, update: {},
      create: { workspaceId: actor.workspaceId, id: actor.id, displayName: 'Demo technician (synthetic)', workspacePermissions: actor.workspacePermissions } });
    for (const membership of actor.memberships) {
      const key = { workspaceId: actor.workspaceId, clientId: membership.clientId, actorId: actor.id };
      await tx.clientMembership.upsert({ where: { workspaceId_clientId_actorId: key }, update: {}, create: { ...key, permissions: membership.permissions } });
    }
    if (demoToken !== null) {
      const key = { workspaceId: actor.workspaceId, id: 'demo-technician-local-token' };
      await tx.apiToken.upsert({ where: { workspaceId_id: key }, update: { tokenHash: hashToken(demoToken), revokedAt: null },
        create: { ...key, actorId: actor.id, tokenHash: hashToken(demoToken), label: 'Local synthetic demo token (ATLAS_DEMO_TOKEN)' } });
    }
  });
  console.log(`Synthetic Gasta/Kari/device graph and demo actor seeded without deleting data; ${demoToken !== null
    ? 'API token digest stored for ATLAS_DEMO_TOKEN.' : 'no API token (set ATLAS_DEMO_TOKEN to call the DB-mode API).'}`);
} finally { await db.$disconnect(); }
