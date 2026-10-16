import { createHash } from 'node:crypto';
import { fixturePlan, ROLES, visibleClients } from './plan.mjs';

const WS = fixturePlan().workspaceId;
const AT = new Date('2026-10-16T12:00:00.000Z');
export const COLLISION_WORKSPACE = 'synthetic-composition-collision';
const ranks = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

async function insert(db, table, row) {
  const columns = Object.keys(row);
  await db.query(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}
async function connection(db, clientId, system) {
  const id = `${clientId}-${system}`;
  await insert(db, 'Connection', { workspaceId: WS, clientId, id, system, externalTenantId: `synthetic-${id}`,
    secretRef: 'fixture://no-credentials', status: 'FIXTURE', boundBy: 'composition-seeder', boundAt: AT });
  return id;
}
async function deviceLink(db, clientId, deviceId, connectionId) {
  const id = `${deviceId}-${connectionId}`;
  await insert(db, 'ExternalEntity', { workspaceId: WS, clientId, id: `external-${id}`, connectionId, resourceType: 'agent', externalId: deviceId,
    attributes: JSON.stringify({ hostname: 'Synthetic bounded source metadata' }), observedAt: AT });
  await insert(db, 'EntityLink', { workspaceId: WS, clientId, id: `link-${id}`, entityId: deviceId, externalEntityId: `external-${id}`,
    resourceType: 'agent', entityKind: 'DEVICE', status: 'CONFIRMED', method: 'FIXTURE', confidence: 1,
    confirmedBy: 'composition-seeder', confirmedAt: AT, createdBy: 'composition-seeder', reviewedBy: 'composition-seeder', reviewedAt: AT });
}
async function observation(db, { clientId, id, severity = 'MEDIUM', summary, source = 'atera', deviceId, status = 'OPEN', createdAt = AT }) {
  const kind = source === 'huntress' ? 'SECURITY_INCIDENT' : 'DISK_CAPACITY';
  const eventId = `event-${id}`; const resourceType = source === 'huntress' ? 'incident' : 'alert';
  await insert(db, 'RawEvent', { workspaceId: WS, clientId, id: eventId, connectionId: `${clientId}-${source}`, resourceType,
    externalEventId: id, revision: '1', eventKey: createHash('sha256').update(`${WS}:${clientId}:${id}`).digest('hex'),
    normalized: JSON.stringify({ kind, summary, syntheticPrivatePayload: 'Synthetic source details never copied to CRM' }),
    payloadHash: createHash('sha256').update(summary).digest('hex'), occurredAt: createdAt, status: 'PROCESSED' });
  const closed = status === 'RESOLVED' || status === 'SUPPRESSED'; const acknowledged = status === 'ACKNOWLEDGED';
  await insert(db, 'Observation', { workspaceId: WS, clientId, id, eventId, entityId: deviceId ?? null,
    domain: source === 'huntress' ? 'SECURITY' : 'OPERATIONS', severity, severityRank: ranks[severity], priority: ranks[severity] >= 3 ? 'URGENT' : 'NORMAL',
    route: 'HUMAN_REVIEW', confidence: 1, provider: 'rules', promptVersion: 'composition-rules-v1', reasonCodes: ['RULES_BASELINE'],
    status, createdAt, updatedAt: AT, resolvedAt: closed ? AT : null, resolvedBy: closed ? 'composition-seeder' : null,
    acknowledgedAt: acknowledged ? AT : null, acknowledgedBy: acknowledged ? 'composition-seeder' : null });
}

export async function seedAtlas(db, employees) {
  if (employees.length !== ROLES.length) throw new Error('Fixture requires three distinct technical employees.');
  const plan = fixturePlan();
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    await insert(db, 'Workspace', { id: WS, name: 'Parasol composition (synthetic)' });
    for (const client of plan.clients) {
      await insert(db, 'Client', { workspaceId: WS, id: client.atlasClientId, name: client.name });
      const atera = await connection(db, client.atlasClientId, 'atera'); const huntress = await connection(db, client.atlasClientId, 'huntress');
      for (const [index, id] of client.deviceIds.entries()) {
        await insert(db, 'Entity', { workspaceId: WS, clientId: client.atlasClientId, id, kind: 'DEVICE' });
        const hostname = client === plan.clients[0] && index < 2 ? plan.target.duplicateHostname : `SYNTHETIC-${id.toUpperCase()}`;
        await insert(db, 'Device', { workspaceId: WS, clientId: client.atlasClientId, id, hostname });
        await deviceLink(db, client.atlasClientId, id, atera);
      }
      if (client === plan.clients[0]) await deviceLink(db, client.atlasClientId, client.deviceIds[0], huntress);
      else await observation(db, { clientId: client.atlasClientId, id: `observation-${client.atlasClientId}`, summary: `Synthetic observation for ${client.name}`, deviceId: client.deviceIds[0] });
    }
    for (const [index, employee] of employees.entries()) {
      const actorId = `composition-actor-${index + 1}`; employee.actorId = actorId; employee.tokenId = `composition-token-${index + 1}`;
      employee.visibleClientIds = visibleClients(employee.role, plan.clients);
      await insert(db, 'Actor', { workspaceId: WS, id: actorId, displayName: `Synthetic source employee ${index + 1}`, workspacePermissions: [] });
      for (const clientId of employee.visibleClientIds) await insert(db, 'ClientMembership', { workspaceId: WS, clientId, actorId, permissions: ['context:read'] });
      await insert(db, 'ApiToken', { workspaceId: WS, id: employee.tokenId, actorId, tokenHash: createHash('sha256').update(employee.token).digest('hex'), label: 'Ephemeral synthetic composition credential' });
    }
    const clientId = plan.target.atlasClientId; const common = { clientId, deviceId: plan.target.confirmedDeviceId };
    await observation(db, { ...common, id: plan.target.criticalObservationId, summary: plan.target.criticalSummary, severity: 'CRITICAL', source: 'huntress', createdAt: new Date('2026-10-01T12:00:00Z') });
    for (let index = 1; index <= 4; index++) await observation(db, { ...common, id: `observation-high-${index}`, summary: `Synthetic high observation ${index}`, severity: 'HIGH' });
    for (let index = 1; index <= 120; index++) await observation(db, { ...common, id: `observation-medium-${String(index).padStart(3, '0')}`,
      summary: index === 1 ? plan.target.unconfirmedSummary : `Synthetic medium observation ${index}`, source: index === 1 ? 'huntress' : 'atera',
      deviceId: index === 1 ? plan.target.unconfirmedDeviceId : common.deviceId, status: index % 10 === 0 ? 'ACKNOWLEDGED' : 'OPEN' });
    await observation(db, { ...common, id: plan.target.observationIdOutsideFirst100, summary: plan.target.observationSummaryOutsideFirst100, severity: 'LOW' });
    await observation(db, { ...common, id: plan.target.resolvedObservationId, summary: plan.target.resolvedSummary, status: 'RESOLVED' });
    await observation(db, { ...common, id: plan.target.suppressedObservationId, summary: plan.target.suppressedSummary, status: 'SUPPRESSED' });
    const old = new Date('2020-01-01T00:00:00Z');
    await insert(db, 'SyncState', { workspaceId: WS, clientId, connectionId: `${clientId}-atera`, resourceType: 'alert', status: 'OK', lastSyncAt: old, lastSuccessAt: old });
    await insert(db, 'ResourceSnapshot', { workspaceId: WS, clientId, connectionId: `${clientId}-atera`, resourceType: 'alert', asOf: old,
      items: JSON.stringify([{ id: 'synthetic-stale-item', privateSourcePayload: 'Synthetic source-only marker' }]), itemCount: 1, truncated: false, contractVersion: 'composition-v1' });
    await insert(db, 'Workspace', { id: COLLISION_WORKSPACE, name: 'Denied foreign workspace (synthetic)' });
    await insert(db, 'Client', { workspaceId: COLLISION_WORKSPACE, id: plan.clients[39].atlasClientId, name: 'Same identifier in foreign workspace (synthetic)' });
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  return plan;
}
