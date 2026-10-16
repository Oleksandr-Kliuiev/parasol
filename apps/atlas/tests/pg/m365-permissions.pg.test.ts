import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import type { Actor } from '../../packages/core/contracts.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { confirmLink, listMappingReview, proposeLink, rejectLink, registerExternalEntity } from '../../packages/graph/mapping.ts';
import { resolveConnection } from '../../packages/connections/connections.ts';
import { listClientAudit } from '../../packages/audit/prisma.ts';
import { executeTool } from '../../packages/tools/gateway.ts';
import { PrismaToolLedger, databaseReaders } from '../../packages/tools/prisma-ledger.ts';
import { PrismaAudit, PrismaSecurityAudit } from '../../packages/audit/prisma.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { addMappingFixtures, actors, gasta } from '../support/graph-fixtures.ts';
import { KARI_OBJECT, LAPTOP_OBJECT, M365_TENANT, addM365Fixtures, m365Actors, publishDirectory, startDirectoryAttempt } from '../support/m365-fixtures.ts';

// Stage 2 task 2.3 on PostgreSQL 17 through the runtime role (A3, A3a, C2b's confirmation half): M365 identities stay out
// of every Stage 1 projection; the generic mapping service needs m365:read on the same client for M365 links and confirms
// them only against a fresh published directory generation. Synthetic data only.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
await addMappingFixtures(pgdb.owner);
await addM365Fixtures(pgdb.owner);
await publishDirectory(pgdb.owner, 'm365_user', 'gen-user-1', 1, [{ source: KARI_OBJECT, mirror: 'm365-user-kari' }], 70);
await publishDirectory(pgdb.owner, 'm365_device', 'gen-device-1', 1, [{ source: LAPTOP_OBJECT, mirror: 'm365-device-07' }], 5);
const VENDOR_IDS = new RegExp(`${KARI_OBJECT}|${LAPTOP_OBJECT}|${M365_TENANT}`, 'i');
const M365_TRACE = new RegExp(`m365|microsoft365|${VENDOR_IDS.source}`, 'i');
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const linkStatus = async (id: string) => (await pgdb.owner.query(`SELECT status FROM "EntityLink" WHERE id = $1`, [id])).rows[0]?.status as string;

test('context:read only: no M365 link, connection, resource or ID in ClientContextV1 or the context tool, even after an M365 link is confirmed', async () => {
  await pgdb.owner.query(`UPDATE "EntityLink" SET status = 'CONFIRMED', "confirmedBy" = 'seed', "confirmedAt" = now() WHERE id = 'link-m365-device'`);
  try {
    for (const actor of [m365Actors.reader, m365Actors.m365Reviewer]) {
      const ctx = await getClientContext(db, actor, gasta);
      assert.ok(!M365_TRACE.test(JSON.stringify(ctx)), `${actor.id}: ClientContextV1 excludes M365 for every caller`);
      assert.deepEqual(ctx.links.map(l => l.system).sort(), ['atera', 'huntress'], 'the Stage 1 confirmed links are still there');
      const sinks = { audit: new PrismaAudit(db, actor), securityAudit: new PrismaSecurityAudit(db, actor), ledger: new PrismaToolLedger(db, actor) };
      const tool = await executeTool(actor, gasta, { tool: 'atlas.client.get_context' }, databaseReaders(db, actor, gasta), sinks);
      assert.ok(!M365_TRACE.test(JSON.stringify(tool.result)), `${actor.id}: the context tool excludes M365`);
    }
    const audit = await listClientAudit(db, m365Actors.reader, gasta);
    assert.ok(!M365_TRACE.test(JSON.stringify(audit.map(a => a.metadata))), 'audit metadata carries no M365 identifier');
  } finally {
    await pgdb.owner.query(`UPDATE "EntityLink" SET status = 'CANDIDATE', "confirmedBy" = NULL, "confirmedAt" = NULL WHERE id = 'link-m365-device'`);
  }
});

test('mapping queue: M365 links only with mapping:review + m365:read on the same client; split permissions never combine', async () => {
  const queue = async (actor: Actor) => (await listMappingReview(db, actor, gasta)).map(i => i.linkId).filter(id => id.startsWith('link-m365')).sort();
  assert.deepEqual(await queue(m365Actors.reviewer), [], 'excluded before the query');
  assert.deepEqual(await queue(m365Actors.split), [], 'm365:read on another client does not count');
  assert.deepEqual(await queue(m365Actors.m365Reviewer), ['link-m365-device', 'link-m365-user']);
  const items = await listMappingReview(db, m365Actors.reviewer, gasta);
  assert.ok(!M365_TRACE.test(JSON.stringify(items)), 'the generic queue shows no M365 identifier');
  await assert.rejects(listMappingReview(db, m365Actors.reader, gasta), fails('PERMISSION_DENIED'), 'mapping:review is still required');
});

test('M365 decisions without m365:read are refused with an audited denial carrying no identifier; nothing changes', async () => {
  for (const actor of [m365Actors.reviewer, m365Actors.split]) {
    await assert.rejects(confirmLink(db, actor, gasta, 'link-m365-device'), fails('PERMISSION_DENIED'));
    await assert.rejects(rejectLink(db, actor, gasta, 'link-m365-user'), fails('PERMISSION_DENIED'));
    await assert.rejects(proposeLink(db, actor, gasta, { externalEntityId: 'm365-user-kari', entityId: 'demo-ola' }), fails('PERMISSION_DENIED'));
  }
  assert.deepEqual([await linkStatus('link-m365-device'), await linkStatus('link-m365-user')], ['CANDIDATE', 'CANDIDATE']);
  const denials = (await pgdb.owner.query(`SELECT "actorId", metadata FROM "AuditEvent" WHERE "eventType" = 'mapping.denied' ORDER BY "recordedAt"`)).rows;
  assert.equal(denials.length, 6);
  assert.ok(denials.every(d => JSON.stringify(d.metadata) === '{"safeErrorCode":"PERMISSION_DENIED"}'), 'safe code only: no link, mirror or vendor ID');
  // Stage 1 links still work for the plain reviewer (existing mapping keeps working)
  const ext = await registerExternalEntity(db, actors.sync, await resolveConnection(db, actors.sync, gasta, 'demo-atera-connection', 'sync'),
    { resourceType: 'agent', externalId: 'atera-agent-m365-test', attributes: {}, observedAt: new Date() });
  const proposed = await proposeLink(db, m365Actors.reviewer, gasta, { externalEntityId: ext.id, entityId: 'dev-08' });
  assert.equal((await confirmLink(db, m365Actors.reviewer, gasta, proposed.linkId)).status, 'CONFIRMED');
  // The generic ingest path never creates M365 mirrors (only directory publication does)
  await assert.rejects(registerExternalEntity(db, actors.sync, await resolveConnection(db, actors.sync, gasta, 'demo-atera-connection', 'sync'),
    { resourceType: 'm365_user', externalId: KARI_OBJECT, attributes: {}, observedAt: new Date() }), fails('M365_MIRROR_PUBLICATION_ONLY'));
});

test('new M365 confirmations need fresh current membership: stale (≥60m), newer pending attempt and absent object are refused; fresh confirms', async () => {
  const reviewer = m365Actors.m365Reviewer;
  // The user generation completed 70 minutes ago: retained, but stale — no new confirmation from it
  await assert.rejects(confirmLink(db, reviewer, gasta, 'link-m365-user'), fails('M365_DIRECTORY_NOT_FRESH'));
  // The device generation is fresh, but a newer directory attempt has started since
  await startDirectoryAttempt(pgdb.owner, 'm365_device');
  await assert.rejects(confirmLink(db, reviewer, gasta, 'link-m365-device'), fails('M365_DIRECTORY_NOT_FRESH'));
  // A fresh generation without the object: absence is NOT_CURRENT, never a reassignment
  await publishDirectory(pgdb.owner, 'm365_device', 'gen-device-3', 3, [], 4);
  await assert.rejects(confirmLink(db, reviewer, gasta, 'link-m365-device'), fails('DIRECTORY_OBJECT_NOT_CURRENT'));
  assert.deepEqual([await linkStatus('link-m365-user'), await linkStatus('link-m365-device')], ['CANDIDATE', 'CANDIDATE']);
  // Reappearance of the same opaque object ID in a fresh generation allows the confirmation
  await publishDirectory(pgdb.owner, 'm365_device', 'gen-device-4', 4, [{ source: LAPTOP_OBJECT, mirror: 'm365-device-07' }], 1);
  assert.deepEqual(await confirmLink(db, reviewer, gasta, 'link-m365-device'), { linkId: 'link-m365-device', status: 'CONFIRMED', conflictsWithLinkId: null });
  const audit = (await pgdb.owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = 'mapping.link_confirmed' AND metadata->>'linkId' = 'link-m365-device'`)).rows;
  assert.equal(audit.length, 1);
  assert.ok(!VENDOR_IDS.test(JSON.stringify(audit)), 'the confirmation audit has Atlas IDs only');
  // A second confirmation of the same external object is quarantined, as for Stage 1 links (one confirmed per external)
  const other = await proposeLink(db, reviewer, gasta, { externalEntityId: 'm365-device-07', entityId: 'dev-08' });
  assert.equal((await confirmLink(db, reviewer, gasta, other.linkId)).status, 'QUARANTINED');
  // Revocation needs the same permissions and keeps the history
  assert.equal((await rejectLink(db, reviewer, gasta, 'link-m365-device')).status, 'REJECTED');
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE metadata->>'linkId' = 'link-m365-device'`)).rows[0].n), 2);
});
