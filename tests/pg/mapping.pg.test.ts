import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { resolveConnection } from '../../packages/connections/connections.ts';
import { registerExternalEntity, suggestDeviceCandidate, proposeLink, confirmLink, rejectLink, listMappingReview } from '../../packages/graph/mapping.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, addMappingFixtures, gasta, other } from '../support/graph-fixtures.ts';

// Task 1.4 on PostgreSQL 17 through the runtime role: candidate → explicit confirmation, ambiguity and cross-client links
// rejected, a conflicting confirmation quarantined (kept, visible, never used), concurrent decisions on two pools.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const db2 = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await db2.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
await addMappingFixtures(pgdb.owner);
const atera = await resolveConnection(db, actors.sync, gasta, 'demo-atera-connection', 'sync');
const otherAtera = await resolveConnection(db, actors.sync, other, 'other-atera', 'sync');

const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 8, minute));
const agent = (externalId: string, attributes: Record<string, string>, minute = 0) =>
  registerExternalEntity(db, actors.sync, atera, { resourceType: 'agent', externalId, attributes, observedAt: at(minute) });
const query = async (sql: string, params: unknown[] = []) => (await pgdb.owner.query(sql, params)).rows;
const linksOf = async (externalEntityId: string) => (await query(
  `SELECT "entityId"||':'||status||':'||method AS s FROM "EntityLink" WHERE "externalEntityId" = $1 ORDER BY 1`, [externalEntityId])).map(r => r.s);
const confirmedInContext = async () => (await getClientContext(db, actors.reviewer, gasta)).links.map(l => `${l.externalId}->${l.entityId}`).sort();
const SEEDED = ['demo-atera-agent-107->demo-device-07', 'demo-huntress-agent-207->demo-device-07'];
const ids: Record<string, string> = {};

test('register: idempotent per connection + type + external ID; newer observations update, older never; other clients keep their own rows', async () => {
  const first = await agent('atera-agent-308', { hostname: 'gasta-lt-08' }, 10);
  ids.a308 = first.id;
  assert.equal(first.created, true);
  assert.deepEqual(await agent('atera-agent-308', { hostname: 'stale-name' }, 5), { id: first.id, created: false });
  await agent('atera-agent-308', { hostname: 'gasta-lt-08', osName: 'Windows 11' }, 20);
  assert.deepEqual((await query(`SELECT attributes FROM "ExternalEntity" WHERE id = $1`, [first.id]))[0].attributes, { hostname: 'gasta-lt-08', osName: 'Windows 11' });
  const theirs = await registerExternalEntity(db, actors.sync, otherAtera, { resourceType: 'agent', externalId: 'atera-agent-308', attributes: {}, observedAt: at(0) });
  ids.their308 = theirs.id;
  assert.notEqual(theirs.id, first.id);
  assert.deepEqual((await query(`SELECT "clientId" AS c FROM "ExternalEntity" WHERE "externalId" = 'atera-agent-308' ORDER BY 1`)).map(r => r.c), ['demo-gasta', 'demo-other']);
  for (const [change, code] of [[{ attributes: { hostname: 'pc\u0000' } }, /INVALID_EXTERNAL_ATTRIBUTES/], [{ attributes: { 'bad key': 'x' } }, /INVALID_EXTERNAL_ATTRIBUTES/],
    [{ resourceType: 'alert' }, /NOT_AN_IDENTITY_RESOURCE/], [{ externalId: 'has space' }, /INVALID_EXTERNAL_ID/]] as const) {
    const base = { resourceType: 'agent', externalId: 'x-1', attributes: {}, observedAt: at(0) };
    await assert.rejects(registerExternalEntity(db, actors.sync, atera, { ...base, ...change } as never), code);
  }
});

test('matcher: one exact hostname in this client gives a CANDIDATE only; ambiguity, missing evidence or no match create nothing', async () => {
  assert.deepEqual(Object.keys(await suggestDeviceCandidate(db, actors.sync, atera, ids.a308!)), ['outcome', 'linkId']);
  assert.deepEqual(await linksOf(ids.a308!), ['dev-08:CANDIDATE:HOSTNAME_EXACT'], "case-insensitive, and never the other client's GASTA-LT-08");
  assert.deepEqual(await confirmedInContext(), SEEDED, 'a candidate is not used');
  const a309 = await agent('atera-agent-309', { hostname: 'GASTA-LT-09' });
  assert.deepEqual(await suggestDeviceCandidate(db, actors.sync, atera, a309.id), { outcome: 'AMBIGUOUS', reasonCode: 'MULTIPLE_DEVICES' });
  const a307b = await agent('atera-agent-307b', { hostname: 'GASTA-LT-07' });
  assert.deepEqual(await suggestDeviceCandidate(db, actors.sync, atera, a307b.id), { outcome: 'AMBIGUOUS', reasonCode: 'DEVICE_ALREADY_CLAIMED' });
  assert.deepEqual([...await linksOf(a309.id), ...await linksOf(a307b.id)], [], 'ambiguity creates no link');
  const ambiguous = await query(`SELECT metadata->>'externalEntityId' AS e, metadata->>'safeErrorCode' AS r FROM "AuditEvent" WHERE "eventType" = 'mapping.suggestion_ambiguous' ORDER BY "recordedAt"`);
  assert.deepEqual(ambiguous.map(r => `${r.e}:${r.r}`), [`${a309.id}:MULTIPLE_DEVICES`, `${a307b.id}:DEVICE_ALREADY_CLAIMED`]);
  assert.deepEqual(await suggestDeviceCandidate(db, actors.sync, atera, (await agent('atera-agent-310', {})).id), { outcome: 'NO_EVIDENCE' });
  assert.deepEqual(await suggestDeviceCandidate(db, actors.sync, atera, (await agent('atera-agent-311', { hostname: 'GASTA_LT_08' })).id), { outcome: 'NO_MATCH' }, "'_' is not a wildcard");
  assert.deepEqual(await suggestDeviceCandidate(db, actors.sync, atera, 'atera-external-device'), { outcome: 'ALREADY_LINKED' });
  await assert.rejects(suggestDeviceCandidate(db, actors.sync, atera, ids.their308!), /EXTERNAL_ENTITY_NOT_FOUND/);
});

test('proposals: only agent→DEVICE and contact→PERSON, only inside one client, idempotent per pair, mapping:review required', async () => {
  const contact = await registerExternalEntity(db, actors.sync, atera, { resourceType: 'contact', externalId: 'atera-contact-5', attributes: { displayName: 'Ola' }, observedAt: at(0) });
  const proposed = await proposeLink(db, actors.reviewer, gasta, { externalEntityId: contact.id, entityId: 'demo-ola' });
  assert.equal(proposed.status, 'CANDIDATE');
  assert.deepEqual(await proposeLink(db, actors.reviewer, gasta, { externalEntityId: contact.id, entityId: 'demo-ola' }), proposed);
  await assert.rejects(proposeLink(db, actors.reviewer, gasta, { externalEntityId: contact.id, entityId: 'dev-08' }), /INCOMPATIBLE_LINK/);
  await assert.rejects(proposeLink(db, actors.reviewer, gasta, { externalEntityId: ids.a308!, entityId: 'demo-kari' }), /INCOMPATIBLE_LINK/);
  await assert.rejects(proposeLink(db, actors.reviewer, gasta, { externalEntityId: ids.a308!, entityId: 'other-dev' }), /ENTITY_NOT_FOUND/, 'a device of another client');
  await assert.rejects(proposeLink(db, actors.reviewer, gasta, { externalEntityId: ids.their308!, entityId: 'dev-08' }), /EXTERNAL_ENTITY_NOT_FOUND/, 'an agent of another client');
  await assert.rejects(proposeLink(db, actors.reader, gasta, { externalEntityId: contact.id, entityId: 'demo-ola' }), /PERMISSION_DENIED/);
  assert.deepEqual(await linksOf(contact.id), ['demo-ola:CANDIDATE:MANUAL']);
});

test('confirm and quarantine: the first confirmation wins; a conflicting one is QUARANTINED with a pointer, kept and never used; revoke, then confirm', async () => {
  const [candidate] = await query(`SELECT id FROM "EntityLink" WHERE "externalEntityId" = $1`, [ids.a308]);
  assert.deepEqual(await confirmLink(db, actors.reviewer, gasta, candidate.id), { linkId: candidate.id, status: 'CONFIRMED', conflictsWithLinkId: null });
  assert.deepEqual(await confirmedInContext(), ['atera-agent-308->dev-08', ...SEEDED]);
  const rival = await proposeLink(db, actors.reviewer, gasta, { externalEntityId: ids.a308!, entityId: 'dev-09a' });
  assert.deepEqual(await confirmLink(db, actors.reviewer, gasta, rival.linkId), { linkId: rival.linkId, status: 'QUARANTINED', conflictsWithLinkId: candidate.id });
  assert.deepEqual(await confirmedInContext(), ['atera-agent-308->dev-08', ...SEEDED], 'the quarantined link is not used');
  const queue = await listMappingReview(db, actors.reviewer, gasta);
  assert.deepEqual([queue[0]?.linkId, queue[0]?.status, queue[0]?.reasonCode, queue[0]?.conflictsWithLinkId, queue[0]?.reviewedBy],
    [rival.linkId, 'QUARANTINED', 'CONFLICTS_WITH_CONFIRMED', candidate.id, 'demo-reviewer'], 'conflicts are first in the review queue');
  assert.ok(queue.some(i => i.status === 'CANDIDATE' && i.resourceType === 'contact' && i.entityKind === 'PERSON'));
  await assert.rejects(listMappingReview(db, actors.reader, gasta), /PERMISSION_DENIED/);
  await assert.rejects(rejectLink(db, actors.reviewer, gasta, candidate.id, 'wrong device, said the customer'), /INVALID_REASON_CODE/);
  assert.equal((await rejectLink(db, actors.reviewer, gasta, candidate.id, 'WRONG_DEVICE')).status, 'REJECTED');
  assert.equal((await confirmLink(db, actors.reviewer, gasta, rival.linkId)).status, 'CONFIRMED');
  assert.deepEqual(await confirmedInContext(), ['atera-agent-308->dev-09a', ...SEEDED]);
  const trail = await query(`SELECT "eventType" AS t FROM "AuditEvent" WHERE metadata->>'linkId' IN ($1, $2) ORDER BY "recordedAt", id`, [candidate.id, rival.linkId]);
  assert.deepEqual(trail.map(r => r.t), ['mapping.link_proposed', 'mapping.link_confirmed', 'mapping.link_proposed', 'mapping.link_quarantined', 'mapping.link_revoked', 'mapping.link_confirmed']);
  await assert.rejects(confirmLink(db, actors.reader, gasta, rival.linkId), /PERMISSION_DENIED/);
});

test('concurrent confirmations of one external object on two pools: exactly one CONFIRMED, the other QUARANTINED pointing at it', async () => {
  for (let round = 0; round < 3; round++) {
    const external = await agent(`atera-agent-race-${round}`, {});
    const a = await proposeLink(db, actors.reviewer, gasta, { externalEntityId: external.id, entityId: 'dev-08' });
    const b = await proposeLink(db, actors.reviewer, gasta, { externalEntityId: external.id, entityId: 'dev-09b' });
    const results = await Promise.all([confirmLink(db, actors.reviewer, gasta, a.linkId), confirmLink(db2, actors.reviewer, gasta, b.linkId)]);
    const winner = results.find(r => r.status === 'CONFIRMED'); const loser = results.find(r => r.status === 'QUARANTINED');
    assert.ok(winner && loser, `round ${round}: ${JSON.stringify(results)}`);
    assert.equal(loser.conflictsWithLinkId, winner.linkId);
    assert.deepEqual((await linksOf(external.id)).map(s => s.split(':')[1]).sort(), ['CONFIRMED', 'QUARANTINED']);
  }
});

test('mapping and binding decisions never write vendor IDs into the client audit', async () => {
  const metadata = JSON.stringify(await query(`SELECT metadata FROM "AuditEvent"`));
  for (const vendorId of ['atera-agent-308', 'atera-contact-5', 'atera-synthetic-gasta', 'demo-atera-agent-107']) assert.ok(!metadata.includes(vendorId), vendorId);
});
