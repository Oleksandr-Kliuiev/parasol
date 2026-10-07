import { PrismaClient } from '@prisma/client';
import { scope, actor, operator, people, devices, links } from '../fixtures/gasta.ts';
import { BEARER_TOKEN_PATTERN, hashToken } from '../packages/auth/token.ts';
// Runs with the OWNER connection (DATABASE_URL), which bypasses row-level security by design; the application must use
// the confined runtime role instead (prisma/roles.sql, ATLAS_RUNTIME_DATABASE_URL).
// Optional: ATLAS_DEMO_TOKEN (your local random token) lets the synthetic technician call the DB-mode API;
// ATLAS_OPERATOR_TOKEN (another one) lets the synthetic operator run the ops CLI (docs/RUNBOOK.md). Only their SHA-256
// digests are stored; the tokens themselves are never written or printed.
const seeded = [
  { actor, displayName: 'Demo technician (synthetic)', variable: 'ATLAS_DEMO_TOKEN', tokenId: 'demo-technician-local-token', label: 'Local synthetic demo token (ATLAS_DEMO_TOKEN)' },
  { actor: operator, displayName: 'Demo operator (synthetic)', variable: 'ATLAS_OPERATOR_TOKEN', tokenId: 'demo-operator-local-token', label: 'Local synthetic operator token (ATLAS_OPERATOR_TOKEN)' },
].map(s => ({ ...s, token: process.env[s.variable] || null }));
for (const s of seeded) {
  if (s.token !== null && !BEARER_TOKEN_PATTERN.test(s.token)) {
    console.error(`${s.variable} must be 20-256 characters of A-Z a-z 0-9 - . _ ~ + / (optionally ending in =).`);
    process.exit(2);
  }
}
if (seeded[0]!.token !== null && seeded[0]!.token === seeded[1]!.token) {
  console.error('ATLAS_DEMO_TOKEN and ATLAS_OPERATOR_TOKEN must differ: one token identifies one actor.');
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
    // Synthetic technician (task 1.3) and operator (task 1.10) with the per-client memberships of fixtures/gasta.ts
    for (const s of seeded) {
      await tx.actor.upsert({ where: { workspaceId_id: { workspaceId: s.actor.workspaceId, id: s.actor.id } }, update: {},
        create: { workspaceId: s.actor.workspaceId, id: s.actor.id, displayName: s.displayName, workspacePermissions: s.actor.workspacePermissions } });
      for (const membership of s.actor.memberships) {
        const key = { workspaceId: s.actor.workspaceId, clientId: membership.clientId, actorId: s.actor.id };
        await tx.clientMembership.upsert({ where: { workspaceId_clientId_actorId: key }, update: {}, create: { ...key, permissions: membership.permissions } });
      }
      if (s.token !== null) {
        const key = { workspaceId: s.actor.workspaceId, id: s.tokenId };
        await tx.apiToken.upsert({ where: { workspaceId_id: key }, update: { tokenHash: hashToken(s.token), revokedAt: null },
          create: { ...key, actorId: s.actor.id, tokenHash: hashToken(s.token), label: s.label } });
      }
    }
  });
  const stored = seeded.filter(s => s.token !== null).map(s => s.variable);
  console.log(`Synthetic Gasta/Kari/device graph, demo technician and demo operator seeded without deleting data; ${stored.length > 0
    ? `API token digests stored for ${stored.join(', ')}.` : 'no API token (set ATLAS_DEMO_TOKEN / ATLAS_OPERATOR_TOKEN to call the DB-mode API / ops CLI).'}`);
} finally { await db.$disconnect(); }
