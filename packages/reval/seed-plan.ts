import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EXPECTED_TYPES, expandPage, originalRow } from '../../scripts/ask-remote-eval/fixtures.ts';
import type { FixtureFile, FixtureSpec, ObsSpec } from '../../scripts/ask-remote-eval/fixtures.ts';
import { DATASET_MANIFEST_SHA256, isFixtureId, SEED_MAPPING_SHA256, SYNTHETIC_FRESHNESS_AT } from './dataset.ts';
import type { FrozenDataset } from './dataset.ts';
import { parseFrameBody } from './frame.ts';
import { exact, isDigest, isIntIn, isScopeId, isTime, req, shapeFail } from './scalars.ts';

/**
 * Deterministic seed plan (03 "Materialization contract", rs-b brief §2 B1–B4): the frozen manifest + fixtureId → the exact
 * rows of the ten allowlisted source tables, never from a provider answer or production compiler output. Projected values
 * come only from `originalRow` and the fixture declaration; every unprojected schema-required literal and ID template comes
 * from the reviewed seed mapping (`seed-mapping.json`, sha256 pinned below). An unrepresentable declaration throws
 * (returns to dataset/architecture review); nothing is repaired or shifted.
 */
export { SEED_MAPPING_SHA256 };
export const SEED_MAPPING_URL = new URL('./seed-mapping.json', import.meta.url);
export class SeedPlanError extends Error { constructor(step: string) { super(`SEED_PLAN_${step}`); this.name = 'SeedPlanError'; } }
const fail = (step: string): never => { throw new SeedPlanError(step); };
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The ten allowlisted source tables in INSERT order (DELETE runs in reverse); `key` = PK columns after (workspaceId, clientId). */
export const SOURCE_TABLES = [
  { table: 'Connection', key: ['id'] }, { table: 'SyncState', key: ['connectionId', 'resourceType'] },
  { table: 'ResourceSnapshot', key: ['connectionId', 'resourceType'] }, { table: 'Entity', key: ['id'] }, { table: 'Person', key: ['id'] },
  { table: 'Device', key: ['id'] }, { table: 'RawEvent', key: ['id'] }, { table: 'Observation', key: ['id'] },
  { table: 'ExternalEntity', key: ['id'] }, { table: 'EntityLink', key: ['id'] },
] as const;
export type SourceTable = typeof SOURCE_TABLES[number]['table'];
/** jsonb columns are sent as JSON text (node-postgres would turn a JS array into a PostgreSQL array literal). */
export const JSON_COLUMNS: Readonly<Partial<Record<SourceTable, readonly string[]>>> = { RawEvent: ['normalized'], ExternalEntity: ['attributes'], ResourceSnapshot: ['items'] };
export type Cell = string | number | boolean | null | readonly string[] | Readonly<Record<string, unknown>> | readonly unknown[];
export type Row = Readonly<Record<string, Cell>>;
export interface SeedPlan { readonly fixtureId: string; readonly seedMappingSha256: string; readonly rows: Readonly<Record<SourceTable, readonly Row[]>> }

export interface SeedMapping {
  readonly scope: { readonly workspaceId: string; readonly clientId: string };
  readonly connection: { readonly externalTenantIdPrefix: string; readonly secretRef: string; readonly status: 'FIXTURE' };
  readonly rawEvent: { readonly idPrefix: string; readonly eventKeyVersion: string; readonly status: 'PROCESSED'; readonly attempts: number };
  readonly observation: { readonly promptVersion: string; readonly acknowledgedBy: string; readonly resolvedBy: string };
  readonly externalEntity: { readonly idPrefix: string; readonly attributes: Readonly<Record<string, never>>; readonly observedAt: string };
  readonly entityLink: { readonly idPrefix: string; readonly method: 'FIXTURE'; readonly confirmedBy: string; readonly confirmedAt: string; readonly createdAt: string };
  readonly syncState: { readonly safeErrorCode: string; readonly errorLastSyncAt: string; readonly attemptSeq: number; readonly recordedSeq: number };
  readonly resourceSnapshot: { readonly contractVersion: string; readonly itemCountComplete: 0; readonly itemCountTruncated: 1 };
  readonly overflowSentinel: { readonly fixtureId: 'FX08'; readonly id: string; readonly source: 'atera'; readonly severity: 'INFO'; readonly createdAt: string };
  readonly schemaExceptions: readonly SchemaException[];
}
/**
 * rc2 (review B1, owner decision 2026-10-11): an EXACT, owner-approved materialization exception for a declared reader-EXCLUDED
 * (non-CONFIRMED) link whose declared pair violates the accepted EntityLink_type_compat_check. It applies only when the
 * whole declared link at that fixture/list/index equals `declared`; it changes only the stored resourceType of that link and
 * its external entity. The accepted reader selects CONFIRMED links only, so no projection, fact or expectation can observe
 * it; a CONFIRMED link can never be excepted. The frozen fixture bytes are unchanged.
 */
export interface SchemaException {
  readonly fixtureId: string; readonly list: 'readerExcludedLinks'; readonly index: number;
  readonly declared: { readonly entityId: string; readonly entityKind: 'PERSON' | 'DEVICE'; readonly status: 'CANDIDATE'; readonly system: string;
    readonly resourceType: string; readonly connectionId: string; readonly externalId: string };
  readonly materializedResourceType: 'agent' | 'contact'; readonly approval: string;
}
const LINK_KEYS = ['entityId', 'entityKind', 'status', 'system', 'resourceType', 'connectionId', 'externalId'] as const;
const compatible = (resourceType: string, entityKind: string): boolean =>
  (resourceType === 'agent' && entityKind === 'DEVICE') || (resourceType === 'contact' && entityKind === 'PERSON');
const prefix = (v: unknown): string => { if (typeof v !== 'string' || !/^syn-[a-z-]+$/.test(v)) shapeFail(); return v as string; };
/** Closed decoder of the mapping (every key required, no extra key, exact literals where the schema fixes them). */
export function decodeSeedMapping(v: unknown): SeedMapping {
  const o = exact(v, ['contractVersion', 'datasetManifestSha256', 'scope', 'connection', 'rawEvent', 'observation', 'externalEntity', 'entityLink',
    'syncState', 'resourceSnapshot', 'overflowSentinel', 'schemaExceptions']);
  if (o.contractVersion !== 'RevalSeedMappingV1' || req(isDigest, o.datasetManifestSha256) !== DATASET_MANIFEST_SHA256) shapeFail();
  const scope = exact(o.scope, ['workspaceId', 'clientId']); req(isScopeId, scope.workspaceId); req(isScopeId, scope.clientId);
  const c = exact(o.connection, ['externalTenantIdPrefix', 'secretRef', 'status']); prefix(c.externalTenantIdPrefix); req(isScopeId, c.secretRef);
  if (c.status !== 'FIXTURE') shapeFail();
  const r = exact(o.rawEvent, ['idPrefix', 'eventKeyVersion', 'status', 'attempts']); prefix(r.idPrefix);
  if (r.eventKeyVersion !== 'v2' || r.status !== 'PROCESSED' || !isIntIn(r.attempts, 0, 8)) shapeFail();
  const ob = exact(o.observation, ['promptVersion', 'acknowledgedBy', 'resolvedBy']);
  for (const k of ['promptVersion', 'acknowledgedBy', 'resolvedBy']) req(isScopeId, ob[k]);
  const x = exact(o.externalEntity, ['idPrefix', 'attributes', 'observedAt']); prefix(x.idPrefix); exact(x.attributes, []); req(isTime, x.observedAt);
  const l = exact(o.entityLink, ['idPrefix', 'method', 'confirmedBy', 'confirmedAt', 'createdAt']); prefix(l.idPrefix);
  if (l.method !== 'FIXTURE') shapeFail();
  req(isScopeId, l.confirmedBy); req(isTime, l.confirmedAt); req(isTime, l.createdAt);
  const s = exact(o.syncState, ['safeErrorCode', 'errorLastSyncAt', 'attemptSeq', 'recordedSeq']);
  if (typeof s.safeErrorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(s.safeErrorCode)) shapeFail();
  req(isTime, s.errorLastSyncAt);
  if (!isIntIn(s.attemptSeq, 0, 1000) || !isIntIn(s.recordedSeq, 0, s.attemptSeq as number)) shapeFail();
  const n = exact(o.resourceSnapshot, ['contractVersion', 'itemCountComplete', 'itemCountTruncated']); req(isScopeId, n.contractVersion);
  if (n.itemCountComplete !== 0 || n.itemCountTruncated !== 1) shapeFail();
  const z = exact(o.overflowSentinel, ['fixtureId', 'id', 'source', 'severity', 'createdAt']);
  if (z.fixtureId !== 'FX08' || z.source !== 'atera' || z.severity !== 'INFO') shapeFail();
  req(isScopeId, z.id); req(isTime, z.createdAt);
  if (!Array.isArray(o.schemaExceptions) || o.schemaExceptions.length > 4) shapeFail();
  for (const e of o.schemaExceptions as unknown[]) {
    const x = exact(e, ['fixtureId', 'list', 'index', 'declared', 'materializedResourceType', 'approval']);
    if (typeof x.fixtureId !== 'string' || !/^FX(0[1-9]|1[01])$/.test(x.fixtureId) || x.list !== 'readerExcludedLinks' || !isIntIn(x.index, 0, 63)) shapeFail();
    const d = exact(x.declared, [...LINK_KEYS]);
    if (d.status !== 'CANDIDATE' || (d.entityKind !== 'PERSON' && d.entityKind !== 'DEVICE') || !['agent', 'contact'].includes(d.resourceType as string)) shapeFail();
    for (const k of ['entityId', 'system', 'connectionId', 'externalId']) req(isScopeId, d[k]);
    // Only an incompatible declaration may be excepted, and only into the one compatible type for its entity kind.
    if (compatible(d.resourceType as string, d.entityKind as string) || !compatible(x.materializedResourceType as string, d.entityKind as string)) shapeFail();
    if (typeof x.approval !== 'string' || !/^OWNER_APPROVED_[A-Za-z0-9_.:-]{1,96}$/.test(x.approval)) shapeFail();
  }
  return o as unknown as SeedMapping;
}
/** Reads the mapping bytes, checks the pinned hash, decodes strictly (duplicate keys rejected by the 06 strict parser). */
export function loadSeedMapping(read: () => Buffer = () => readFileSync(SEED_MAPPING_URL)): { mapping: SeedMapping; sha256: string } {
  const bytes = read();
  const sha256 = sha(bytes);
  if (sha256 !== SEED_MAPPING_SHA256) fail('MAPPING_HASH');
  return { mapping: decodeSeedMapping(parseFrameBody(bytes)), sha256 };
}

const RANK: Readonly<Record<string, number>> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const pad3 = (i: number): string => String(i).padStart(3, '0');

/** All rows of one fixture. Throws SeedPlanError for anything the schema or the reader could not represent exactly. */
export function seedPlan(dataset: FrozenDataset, fixtureId: string, mapping: SeedMapping, mappingSha256: string): SeedPlan {
  const spec = (isFixtureId(fixtureId) ? dataset.byId.get(fixtureId) : undefined) ?? fail('FIXTURE_ID');
  const scope: FixtureFile['scope'] = dataset.file.scope;
  if (scope.workspaceId !== mapping.scope.workspaceId || scope.clientId !== mapping.scope.clientId) fail('SCOPE');
  const ws = { workspaceId: scope.workspaceId, clientId: scope.clientId };
  const systems = new Map<string, 'atera' | 'huntress'>();
  const connections: Row[] = []; const syncStates: Row[] = []; const snapshots: Row[] = [];
  for (const c of spec.connections) {
    if (systems.has(c.id) || !isScopeId(c.id)) fail('CONNECTION_ID');
    systems.set(c.id, c.system);
    connections.push({ ...ws, id: c.id, system: c.system, externalTenantId: mapping.connection.externalTenantIdPrefix + c.id,
      secretRef: mapping.connection.secretRef, status: mapping.connection.status, boundBy: null, boundAt: null });
    for (const [resourceType, state] of Object.entries(c.states)) {
      if (!EXPECTED_TYPES[c.system]!.includes(resourceType)) fail('RESOURCE_TYPE');
      if (state.status === 'MISSING') { if (state.asOf !== null || state.lastSuccessAt !== null || state.truncated) fail('MISSING_STATE'); continue; }
      const key = { ...ws, connectionId: c.id, resourceType };
      if (state.status === 'OK' || state.status === 'STALE') {
        if (!isTime(state.asOf) || !isTime(state.lastSuccessAt)) fail('SNAPSHOT_TIME');
        syncStates.push({ ...key, cursor: null, lastSyncAt: state.lastSuccessAt, lastSuccessAt: state.lastSuccessAt, status: 'OK', safeErrorCode: null,
          attemptSeq: mapping.syncState.attemptSeq, recordedSeq: mapping.syncState.recordedSeq });
        snapshots.push({ ...key, asOf: state.asOf, items: [], truncated: state.truncated,
          itemCount: state.truncated ? mapping.resourceSnapshot.itemCountTruncated : mapping.resourceSnapshot.itemCountComplete,
          contractVersion: mapping.resourceSnapshot.contractVersion });
      } else if (state.status === 'ERROR') {
        if (state.asOf !== null || state.truncated || (state.lastSuccessAt !== null && !isTime(state.lastSuccessAt))) fail('ERROR_STATE');
        if (state.lastSuccessAt !== null && state.lastSuccessAt > mapping.syncState.errorLastSyncAt) fail('ERROR_ORDER');
        syncStates.push({ ...key, cursor: null, lastSyncAt: mapping.syncState.errorLastSyncAt, lastSuccessAt: state.lastSuccessAt, status: 'ERROR',
          safeErrorCode: mapping.syncState.safeErrorCode, attemptSeq: mapping.syncState.attemptSeq, recordedSeq: mapping.syncState.recordedSeq });
      } else fail('STATE_STATUS');
    }
  }
  const entities: Row[] = []; const people: Row[] = []; const devices: Row[] = [];
  for (const e of spec.entities) {
    if (!isScopeId(e.id) || entities.some(x => x.id === e.id)) fail('ENTITY_ID');
    entities.push({ ...ws, id: e.id, kind: e.kind });
    if (e.kind === 'PERSON') people.push({ ...ws, id: e.id, displayName: e.label, email: null });
    else if (e.kind === 'DEVICE') devices.push({ ...ws, id: e.id, hostname: e.label, personId: null });
    else fail('ENTITY_KIND');
  }
  const obs: ObsSpec[] = [...expandPage(spec), ...(spec.focus.offPage ? [spec.focus.offPage] : [])];
  const sentinel = mapping.overflowSentinel;
  if (spec.pageTruncated !== (fixtureId === sentinel.fixtureId)) fail('TRUNCATION_SENTINEL');
  if (fixtureId === sentinel.fixtureId) {
    // The sentinel sorts strictly after every declared row in the reader's order (severityRank DESC, createdAt DESC, id ASC).
    const after = (o: ObsSpec): boolean => {
      const r = originalRow(o, scope); const rank = RANK[r.severity as string]!;
      return rank > RANK[sentinel.severity]! || (rank === RANK[sentinel.severity] && ((r.createdAt as string) > sentinel.createdAt
        || (r.createdAt === sentinel.createdAt && o.id < sentinel.id)));
    };
    if (spec.requestedFocus === sentinel.id || obs.some(o => o.id === sentinel.id || !after(o))) fail('SENTINEL_ORDER');
    obs.push({ id: sentinel.id, source: sentinel.source, severity: sentinel.severity, createdAt: sentinel.createdAt });
  }
  const rawEvents: Row[] = []; const observations: Row[] = [];
  for (const o of obs) {
    const row = originalRow(o, scope);
    const id = row.id as string;
    if (!isScopeId(id) || observations.some(x => x.id === id)) fail('OBSERVATION_ID');
    if (systems.get(row.connectionId as string) !== o.source) fail('OBSERVATION_CONNECTION');
    if (row.entityId !== null && !entities.some(e => e.id === row.entityId)) fail('ENTITY_FK');
    const normalized = { kind: row.kind, summary: row.summary };
    const rawId = mapping.rawEvent.idPrefix + id;
    rawEvents.push({ ...ws, id: rawId, connectionId: row.connectionId as string, resourceType: row.resourceType as string,
      externalEventId: row.externalEventId as string, revision: row.revision as string, eventKey: row.eventKey as string,
      eventKeyVersion: mapping.rawEvent.eventKeyVersion, normalized, payloadHash: sha(JSON.stringify(normalized)), occurredAt: row.occurredAt as string,
      receivedAt: row.occurredAt as string, status: mapping.rawEvent.status, attempts: mapping.rawEvent.attempts, lastErrorCode: null,
      nextAttemptAt: row.occurredAt as string, leaseOwner: null, leaseExpiresAt: null, claimToken: null, preparedDecision: null, conflictOfEventKey: null });
    const status = row.status as string;
    if ((status === 'ACKNOWLEDGED') !== (row.acknowledgedAt !== null) || ((status === 'RESOLVED' || status === 'SUPPRESSED') !== (row.resolvedAt !== null))) fail('LIFECYCLE');
    observations.push({ ...ws, id, eventId: rawId, entityId: row.entityId as string | null, decisionRunId: null, decisionApplied: true,
      domain: row.domain as string, severity: row.severity as string, severityRank: RANK[row.severity as string] ?? fail('SEVERITY'),
      priority: row.priority as string, route: row.route as string, confidence: row.confidence as number, provider: row.provider as string,
      promptVersion: mapping.observation.promptVersion, reasonCodes: row.reasonCodes as string[], status, createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string, resolvedAt: row.resolvedAt as string | null,
      resolvedBy: row.resolvedAt === null ? null : mapping.observation.resolvedBy, legacyClosure: false,
      acknowledgedAt: row.acknowledgedAt as string | null, acknowledgedBy: row.acknowledgedAt === null ? null : mapping.observation.acknowledgedBy,
      supersededById: null });
  }
  const externals: Row[] = []; const links: Row[] = [];
  const declared = [...spec.links, ...spec.readerExcludedLinks];
  const used = new Set<SchemaException>();
  declared.forEach((l, i) => {
    if (systems.get(l.connectionId) !== l.system || !['CONFIRMED', 'CANDIDATE'].includes(l.status)) fail('LINK');
    if (!entities.some(e => e.id === l.entityId && e.kind === l.entityKind)) fail('LINK_ENTITY');
    // Accepted schema rule EntityLink_type_compat_check: agent↔DEVICE, contact↔PERSON only. A declaration outside it is
    // unrepresentable (03: returns to dataset review; never weaken SQL or alter the declared link) unless the reviewed
    // mapping carries the owner-approved exact exception for THIS excluded link (rc2, B1).
    const excludedIndex = i - spec.links.length;
    const exception = excludedIndex < 0 ? undefined : mapping.schemaExceptions.find(e => e.fixtureId === fixtureId && e.list === 'readerExcludedLinks'
      && e.index === excludedIndex && LINK_KEYS.every(k => (e.declared as Record<string, unknown>)[k] === (l as unknown as Record<string, unknown>)[k]));
    if (exception) used.add(exception);
    const resourceType = exception ? exception.materializedResourceType : l.resourceType;
    if (!compatible(resourceType, l.entityKind)) fail('LINK_TYPE_INCOMPATIBLE');
    let ext = externals.find(x => x.connectionId === l.connectionId && x.resourceType === resourceType && x.externalId === l.externalId);
    if (!ext) {
      ext = { ...ws, id: mapping.externalEntity.idPrefix + pad3(externals.length + 1), connectionId: l.connectionId, resourceType,
        externalId: l.externalId, attributes: mapping.externalEntity.attributes, observedAt: mapping.externalEntity.observedAt };
      externals.push(ext);
    }
    const confirmed = l.status === 'CONFIRMED';
    links.push({ ...ws, id: mapping.entityLink.idPrefix + pad3(i + 1), entityId: l.entityId, externalEntityId: ext.id as string, resourceType,
      entityKind: l.entityKind, status: l.status, method: mapping.entityLink.method, confidence: null,
      confirmedBy: confirmed ? mapping.entityLink.confirmedBy : null, confirmedAt: confirmed ? mapping.entityLink.confirmedAt : null,
      createdAt: mapping.entityLink.createdAt, createdBy: null, reviewedBy: null, reviewedAt: null, reasonCode: null, conflictsWithLinkId: null });
  });
  if (spec.links.some(l => l.status !== 'CONFIRMED') || spec.readerExcludedLinks.some(l => l.status === 'CONFIRMED')) fail('LINK_CLASS');
  // Every exception of this fixture must have matched its exact declaration (a stale exception is a mapping error).
  if (mapping.schemaExceptions.some(e => e.fixtureId === fixtureId && !used.has(e))) fail('SCHEMA_EXCEPTION_UNUSED');
  return { fixtureId, seedMappingSha256: mappingSha256, rows: { Connection: connections, SyncState: syncStates, ResourceSnapshot: snapshots,
    Entity: entities, Person: people, Device: devices, RawEvent: rawEvents, Observation: observations, ExternalEntity: externals, EntityLink: links } };
}
/** Canonical identity keys per table (sorted `k1\u0000k2`) — the row-identity proof compares the DB to exactly these. */
export function planKeys(plan: SeedPlan): Record<SourceTable, string[]> {
  const out = {} as Record<SourceTable, string[]>;
  for (const t of SOURCE_TABLES) out[t.table] = plan.rows[t.table].map(r => t.key.map(k => String(r[k])).join('\u0000')).sort();
  return out;
}
/** The binding values a materialized plan carries (03: pinned reference, frozen dataset digest). */
export const bindingValues = (plan: SeedPlan) => ({ fixtureId: plan.fixtureId, syntheticFreshnessAt: SYNTHETIC_FRESHNESS_AT, datasetManifestSha256: DATASET_MANIFEST_SHA256 });
export type { FixtureSpec };
