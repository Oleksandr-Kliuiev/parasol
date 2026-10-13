import { Prisma } from '@prisma/client';
import { RESOURCE_MAX_AGE_MS, expectedResources } from '../graph/context-mapper.ts';
import type { ResourceType } from '../core/contracts.ts';
import { ASK_LIMITS, askFailure } from './contracts.ts';
import type { ObservationData } from './contracts.ts';
import { storableId } from './input.ts';
import {
  ACTIVE_STATUSES, M365_RESOURCE_TYPES, NON_ASK_SYSTEMS, OBSERVATION_STATUSES, SourceMeter, activePage, flag, graphEntities, graphLinks,
  identifier, inScope, invalid, nullableTime, observationRecord, oneOf, scopeId, snapshotItem, sourceClass, text, time, tooLarge,
  uniqueResources
} from './source.ts';
import type { AskSourceRead, FocusRead, GraphEntity, Scope, SourceResource } from './source.ts';
import type { PhaseSql } from './phase.ts';

/**
 * Focused DB source reader (02 "Server evidence bank"). Runs ONLY inside the already-admitted phase1 transaction (one-client
 * RLS scope set by authority.ts) — no nested withScope/getClientContext transaction, no HTTP loopback, no sync, no Gateway
 * or tool. Explicit column projections: no email, raw payload or facts (only normalized->'summary'/'kind'), no
 * externalDevice/receivedAt/safeErrorCode, no M365/PowerOffice content, no source URL. Graph arrays are fetched with cap+1;
 * snapshot item arrays are sized in SQL first and materialized only within the 4 MiB budget, then validated item by item.
 * Atera/Huntress only; known excluded systems are filtered in SQL, so an unknown system still reaches validation and fails.
 * Every statement goes through the phase runner (phase.ts): run/phase checks before and after each await, so a terminal or
 * expired run starts no further graph/resource/item read; the remaining phase budget bounds each statement.
 */
const EXCLUDED = Prisma.join(NON_ASK_SYSTEMS);
const M365_TYPES = Prisma.join(M365_RESOURCE_TYPES);

const observationColumns = Prisma.sql`
  o."workspaceId", o."clientId", o.id, e."eventKey", c.system AS source, e."connectionId", e."resourceType", e."externalEventId", e.revision,
  o."entityId", o."decisionRunId", e.normalized -> 'kind' AS kind, o.domain, o.severity, o.priority, o.route, o.confidence, o.provider,
  o."reasonCodes", e."conflictOfEventKey", o.status, o."acknowledgedAt", o."resolvedAt", o."supersededById",
  e.normalized -> 'summary' AS summary, e."occurredAt", o."createdAt", o."updatedAt"`;
const observationJoins = Prisma.sql`
  FROM public."Observation" o
  JOIN public."RawEvent" e ON e."workspaceId" = o."workspaceId" AND e."clientId" = o."clientId" AND e.id = o."eventId"
  JOIN public."Connection" c ON c."workspaceId" = e."workspaceId" AND c."clientId" = e."clientId" AND c.id = e."connectionId"`;

const severityRank: Readonly<Record<string, number>> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
/** The accepted context order (context-mapper.ts mapObservationPage) over the DB page: severity, newest, then ID. */
const serverOrder = (a: ObservationData, b: ObservationData) =>
  severityRank[b.severity]! - severityRank[a.severity]! || b.createdAt.localeCompare(a.createdAt) || a.observationId.localeCompare(b.observationId);

async function readPage(sql: PhaseSql, scope: Scope, meter: SourceMeter) {
  const rows = await sql(tx => tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${observationColumns} ${observationJoins}
    WHERE o."workspaceId" = ${scope.workspaceId} AND o."clientId" = ${scope.clientId} AND o.status IN (${Prisma.join(ACTIVE_STATUSES)})
      AND c.system NOT IN (${EXCLUDED})
    ORDER BY o."severityRank" DESC, o."createdAt" DESC, o.id ASC LIMIT ${ASK_LIMITS.observationPage + 1}`));
  const selected = rows.slice(0, ASK_LIMITS.observationPage);
  for (const row of selected) meter.add(row);
  return { page: activePage(selected, scope).sort(serverOrder), truncated: rows.length > ASK_LIMITS.observationPage };
}

async function readFocus(sql: PhaseSql, scope: Scope, focusId: string | null, page: readonly ObservationData[],
  meter: SourceMeter): Promise<FocusRead> {
  if (focusId === null) return { state: 'NONE' };
  const onPage = page.find(o => o.observationId === focusId);
  if (onPage) return { state: 'FOUND', observation: onPage, onPage: true };
  if (!storableId(focusId)) return { state: 'MISSING' };
  const rows = await sql(tx => tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${observationColumns} ${observationJoins}
    WHERE o."workspaceId" = ${scope.workspaceId} AND o."clientId" = ${scope.clientId} AND o.id = ${focusId} LIMIT 2`));
  if (rows.length === 0) return { state: 'MISSING' };
  if (rows.length > 1) invalid();
  meter.add(rows[0]);
  if (sourceClass(rows[0]!.source) === 'EXCLUDED') return { state: 'UNSUPPORTED' };
  const observation = observationRecord(rows[0], scope, OBSERVATION_STATUSES);
  if (observation.observationId !== focusId) invalid();
  return { state: 'FOUND', observation, onPage: false };
}

async function readGraph(sql: PhaseSql, scope: Scope, meter: SourceMeter) {
  const cap = 2 * ASK_LIMITS.graphRows;
  const rows = await sql(tx => tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT e."workspaceId", e."clientId", e.id, e.kind, p.id AS "personId", p."displayName", d.id AS "deviceId", d.hostname
      FROM public."Entity" e
      LEFT JOIN public."Person" p ON p."workspaceId" = e."workspaceId" AND p."clientId" = e."clientId" AND p.id = e.id
      LEFT JOIN public."Device" d ON d."workspaceId" = e."workspaceId" AND d."clientId" = e."clientId" AND d.id = e.id
     WHERE e."workspaceId" = ${scope.workspaceId} AND e."clientId" = ${scope.clientId} ORDER BY e.id LIMIT ${cap + 1}`));
  if (rows.length > cap) tooLarge();
  const people: GraphEntity[] = []; const devices: GraphEntity[] = [];
  for (const row of rows) {
    meter.add(row);
    inScope(row, scope);
    const id = identifier(row.id);
    const kind = oneOf(row.kind, ['PERSON', 'DEVICE'] as const);
    // An entity's kind and its one typed row agree exactly; anything else is a graph kind violation, not a dropped entity.
    if (kind === 'PERSON' && row.personId === id && row.deviceId === null) people.push({ id, kind, label: text(row.displayName) });
    else if (kind === 'DEVICE' && row.deviceId === id && row.personId === null) devices.push({ id, kind, label: text(row.hostname) });
    else invalid();
  }
  const entities = graphEntities(people, devices);
  const links = await sql(tx => tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT l."entityId", l."entityKind", l.status, x."resourceType", x."externalId", x."connectionId", c.system
      FROM public."EntityLink" l
      JOIN public."ExternalEntity" x ON x."workspaceId" = l."workspaceId" AND x."clientId" = l."clientId" AND x.id = l."externalEntityId"
      JOIN public."Connection" c ON c."workspaceId" = x."workspaceId" AND c."clientId" = x."clientId" AND c.id = x."connectionId"
     WHERE l."workspaceId" = ${scope.workspaceId} AND l."clientId" = ${scope.clientId} AND l.status = 'CONFIRMED'
       AND x."resourceType" NOT IN (${M365_TYPES}) AND c.system <> 'microsoft365'
     ORDER BY l.id LIMIT ${ASK_LIMITS.graphRows + 1}`));
  for (const row of links) meter.add(row);
  return { entities, links: graphLinks(links, entities) };
}

interface ResourceKey { connectionId: string; source: 'atera' | 'huntress'; resourceType: string }
/**
 * One resource per Atera/Huntress connection × expected type, in the accepted mapResources order and status semantics
 * (MISSING for no/unavailable/pending sync or no snapshot unless ERROR; OK fresh after a successful refresh; else STALE),
 * evaluated with the phase1 DB clock — except that a non-array snapshot is ASK_SOURCE_INVALID, never an ERROR card, and
 * every existing snapshot of a selected tuple is validated/accounted whatever the projected status.
 */
async function readResources(sql: PhaseSql, scope: Scope, now: Date, meter: SourceMeter): Promise<readonly SourceResource[]> {
  const connections = await sql(tx => tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT "workspaceId", "clientId", id, system FROM public."Connection"
     WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND system NOT IN (${EXCLUDED})
     ORDER BY id LIMIT ${ASK_LIMITS.resources + 1}`));
  const keys: ResourceKey[] = [];
  for (const row of connections) {
    meter.add(row);
    inScope(row, scope);
    const source = oneOf(row.system, ['atera', 'huntress'] as const);
    for (const resourceType of expectedResources[source]) keys.push({ connectionId: scopeId(row.id), source, resourceType });
  }
  if (keys.length > ASK_LIMITS.resources) tooLarge();
  if (keys.length === 0) return [];
  const tuples = Prisma.sql`unnest(${keys.map(k => k.connectionId)}::text[], ${keys.map(k => k.resourceType)}::text[]) AS t(c, r)`;
  const states = await sql(tx => tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT s."connectionId", s."resourceType", s.status, s."lastSuccessAt", n."asOf", n.truncated, (n."connectionId" IS NOT NULL) AS snapshot,
           jsonb_typeof(n.items) AS "itemsType", CASE WHEN jsonb_typeof(n.items) = 'array' THEN jsonb_array_length(n.items) END AS "itemsLength",
           octet_length(n.items::text) AS "itemsBytes"
      FROM public."SyncState" s JOIN ${tuples} ON s."connectionId" = t.c AND s."resourceType" = t.r
      LEFT JOIN public."ResourceSnapshot" n ON n."workspaceId" = s."workspaceId" AND n."clientId" = s."clientId"
           AND n."connectionId" = s."connectionId" AND n."resourceType" = s."resourceType"
     WHERE s."workspaceId" = ${scope.workspaceId} AND s."clientId" = ${scope.clientId}`));
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of states) {
    meter.add(row);
    const key = JSON.stringify([text(row.connectionId), text(row.resourceType)]);
    if (byKey.has(key)) invalid();
    byKey.set(key, row);
  }
  const resources: SourceResource[] = [];
  const withItems: ResourceKey[] = [];
  let itemBytes = 0;
  for (const key of keys) {
    const sync = byKey.get(JSON.stringify([key.connectionId, key.resourceType]));
    const base = { source: key.source, resourceType: key.resourceType, connectionId: key.connectionId };
    const missing = (lastSuccessAt: string | null) => resources.push({ ...base, status: 'MISSING', asOf: null, lastSuccessAt, truncated: false });
    if (!sync) { missing(null); continue; }
    const status = oneOf(sync.status, ['PENDING', 'OK', 'ERROR', 'UNAVAILABLE'] as const);
    const lastSuccessAt = nullableTime(sync.lastSuccessAt);
    // rc2 (R3): an existing original snapshot is validated and accounted BEFORE any status projection — also when the
    // projection below maps PENDING/UNAVAILABLE to MISSING and never shows it. Its items are materialized and checked in readItems.
    let snapshot: { asOf: string; truncated: boolean } | null = null;
    if (sync.snapshot === true) {
      if (sync.itemsType !== 'array') invalid();
      const length = Number(sync.itemsLength);
      if (!Number.isSafeInteger(length) || length < 0) invalid();
      if (length > ASK_LIMITS.resourceItems) tooLarge();
      itemBytes += Number(sync.itemsBytes);
      if (!(itemBytes <= ASK_LIMITS.contextBytes)) tooLarge();
      snapshot = { asOf: time(sync.asOf), truncated: flag(sync.truncated) };
      withItems.push(key);
    }
    if (status === 'UNAVAILABLE' || status === 'PENDING') { missing(lastSuccessAt); continue; }
    if (snapshot === null) {
      if (status === 'ERROR') resources.push({ ...base, status: 'ERROR', asOf: null, lastSuccessAt, truncated: false });
      else missing(lastSuccessAt);
      continue;
    }
    const fresh = now.getTime() - Date.parse(snapshot.asOf) <= (RESOURCE_MAX_AGE_MS[key.resourceType as ResourceType] ?? 0);
    resources.push({ ...base, status: status === 'OK' && fresh ? 'OK' : 'STALE', asOf: snapshot.asOf, lastSuccessAt, truncated: snapshot.truncated });
  }
  if (withItems.length > 0) await readItems(sql, scope, withItems, meter);
  return uniqueResources(resources);
}

/** Materializes and validates every item of every selected original snapshot (counts and sizes were bounded first). */
async function readItems(sql: PhaseSql, scope: Scope, keys: readonly ResourceKey[], meter: SourceMeter): Promise<void> {
  const tuples = Prisma.sql`unnest(${keys.map(k => k.connectionId)}::text[], ${keys.map(k => k.resourceType)}::text[]) AS t(c, r)`;
  const rows = await sql(tx => tx.$queryRaw<{ connectionId: string; resourceType: string; items: unknown }[]>(Prisma.sql`
    SELECT n."connectionId", n."resourceType", n.items FROM public."ResourceSnapshot" n JOIN ${tuples} ON n."connectionId" = t.c AND n."resourceType" = t.r
     WHERE n."workspaceId" = ${scope.workspaceId} AND n."clientId" = ${scope.clientId}`));
  if (rows.length !== keys.length) invalid();
  for (const row of rows) {
    meter.add(row.items);
    const key = keys.find(k => k.connectionId === row.connectionId && k.resourceType === row.resourceType) ?? invalid();
    if (!Array.isArray(row.items)) invalid();
    if ((row.items as unknown[]).length > ASK_LIMITS.resourceItems) tooLarge();
    for (const item of row.items as unknown[]) snapshotItem(item, key.source, key.resourceType);
  }
}

/** The whole Ask source read of one admitted client; the caller already holds the fence and the one-client scope. */
export async function readDbSource(sql: PhaseSql, scope: Scope, focusId: string | null, now: Date): Promise<AskSourceRead> {
  const client = await sql(tx => tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM public."Client" WHERE "workspaceId" = ${scope.workspaceId} AND id = ${scope.clientId}`));
  if (client.length !== 1) return askFailure('ASK_CONTEXT_UNAVAILABLE');
  const meter = new SourceMeter();
  const { page, truncated } = await readPage(sql, scope, meter);
  const focus = await readFocus(sql, scope, focusId, page, meter);
  const { entities, links } = await readGraph(sql, scope, meter);
  const resources = await readResources(sql, scope, now, meter);
  return Object.freeze({ mode: 'db' as const, page, pageTruncated: truncated, focus, entities, links, resources });
}
