import type { Prisma } from '@prisma/client';
import type { Priority, Route, Scope, Severity } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import { EXTERNAL_ID_PATTERN } from '../graph/mapping.ts';
import { DIRECTORY_FRESH_MS } from '../m365/status.ts';
import type { CorrelationReasonCode, CorrelationResolutionState, CorrelationResource } from './contracts.ts';
import type { DbClock } from './time.ts';
import { transitionAt } from './cursor.ts';
import type { Transition } from './cursor.ts';

/**
 * Deterministic resolution of one Huntress observation against the selected M365 connection (02 §4, brief RC3), no model,
 * no names. Loads read the current snapshot; resolve() is pure.
 *   source  Observation → scoped RawEvent → validated normalized.externalDevice {resourceType:'agent', externalId} → that
 *           Huntress connection's agent ExternalEntity → its current CONFIRMED DEVICE link. Observation.entityId is never a
 *           fallback; a missing/invalid reference or mapping leaves BOTH paths unresolved.
 *   (a)     the DEVICE's one confirmed m365_device link of the selected connection → the object in the active unexpired
 *           device generation → its deviceId (the registration key sign-ins report; never directory device.id), unique there.
 *   (b)     DEVICE.personId → that person's one confirmed m365_user link of the selected connection → the object (user.id)
 *           in the active unexpired user generation. Independent of (a): (b) may resolve while (a) is missing.
 * Retained membership of a stale generation (≥60m or a newer attempt) still resolves, with DIRECTORY_STALE; at the
 * generation's expiresAt (≤ completedAt + 24h) the DTO is hidden and the path is UNRESOLVED/DIRECTORY_EXPIRED.
 */
type DirectoryResource = 'm365_user' | 'm365_device';
export interface DirectoryState {
  resourceType: DirectoryResource; status: string; safeErrorCode: string | null; activeGenerationId: string | null;
  started: number; published: number; recorded: number; lastSuccessAt: Date | null; latestState: string | null;
  generation: { id: string; completedAt: Date | null; expiresAt: Date } | null;
}
export interface LinkRow { id: string; status: string; entityId: string; externalEntityId: string; externalId: string }
export interface SourceFacts {
  observationId: string; source: { eventKey: string; severity: Severity; priority: Priority; route: Route };
  sourceConnection: { id: string; status: string; lifecycleVersion: number };
  reference: { kind: 'MISSING' } | { kind: 'INVALID' } | { kind: 'AGENT'; externalId: string };
  agentEntityId: string | null; sourceLinks: LinkRow[]; device: { id: string; personId: string | null } | null;
}
export interface MappingFacts {
  deviceLinks: LinkRow[]; personLinks: LinkRow[];
  directory: Record<DirectoryResource, DirectoryState | null>;
  deviceObject: { deviceId: string | null; duplicates: number } | null; userObject: { sourceObjectId: string } | null;
}
export interface PathProof { linkIds: string[]; linkStatuses: string[]; directoryGenerationIds: string[] }
export interface Resolution {
  device: CorrelationResolutionState; person: CorrelationResolutionState; reasonCodes: CorrelationReasonCode[];
  /** Route (a): the registration deviceId; route (b): the assigned person's directory user ID. null unless that path RESOLVED. */
  deviceRef: string | null; userRef: string | null;
  deviceProof: PathProof | null; personProof: PathProof | null;
}
export const SOURCE_SYSTEM = 'huntress';

/** The observation and its source reference. Not Huntress / not in scope → safe validation/not-found, nothing else. */
export async function loadSource(tx: Prisma.TransactionClient, scope: Scope, observationId: string): Promise<SourceFacts> {
  const o = await tx.observation.findUnique({ where: { workspaceId_clientId_id: { ...scope, id: observationId } },
    select: { id: true, severity: true, priority: true, route: true, event: { select: { eventKey: true, connectionId: true, normalized: true,
      connection: { select: { id: true, system: true, status: true, lifecycleVersion: true } } } } } });
  if (!o) throw new AtlasError('OBSERVATION_NOT_FOUND', 'VALIDATION');
  const normalized = o.event.normalized as { source?: unknown; externalDevice?: unknown } | null;
  if (o.event.connection.system !== SOURCE_SYSTEM || normalized?.source !== SOURCE_SYSTEM) throw new AtlasError('CORRELATION_SOURCE_UNSUPPORTED', 'VALIDATION');
  const ref = normalized.externalDevice as { resourceType?: unknown; externalId?: unknown } | null | undefined;
  const reference: SourceFacts['reference'] = ref === null || ref === undefined ? { kind: 'MISSING' }
    : typeof ref === 'object' && !Array.isArray(ref) && ref.resourceType === 'agent' && typeof ref.externalId === 'string' && EXTERNAL_ID_PATTERN.test(ref.externalId)
      ? { kind: 'AGENT', externalId: ref.externalId } : { kind: 'INVALID' };
  const facts: SourceFacts = { observationId: o.id, source: { eventKey: o.event.eventKey, severity: o.severity as Severity, priority: o.priority as Priority,
    route: o.route as Route }, sourceConnection: { id: o.event.connection.id, status: o.event.connection.status, lifecycleVersion: Number(o.event.connection.lifecycleVersion) },
    reference, agentEntityId: null, sourceLinks: [], device: null };
  if (reference.kind !== 'AGENT') return facts;
  const agent = await tx.externalEntity.findUnique({ where: { workspaceId_clientId_connectionId_resourceType_externalId: { ...scope, connectionId: o.event.connectionId,
    resourceType: 'agent', externalId: reference.externalId } }, select: { id: true, links: { where: { status: 'CONFIRMED', entityKind: 'DEVICE' },
    select: { id: true, status: true, entityId: true }, orderBy: { id: 'asc' } } } });
  if (!agent) return facts;
  facts.agentEntityId = agent.id;
  facts.sourceLinks = agent.links.map(l => ({ ...l, externalEntityId: agent.id, externalId: reference.externalId }));
  if (facts.sourceLinks.length === 1) {
    facts.device = await tx.device.findUnique({ where: { workspaceId_clientId_id: { ...scope, id: facts.sourceLinks[0]!.entityId } }, select: { id: true, personId: true } });
  }
  return facts;
}

async function links(tx: Prisma.TransactionClient, scope: Scope, connectionId: string, entityId: string, resourceType: DirectoryResource): Promise<LinkRow[]> {
  const rows = await tx.entityLink.findMany({ where: { ...scope, entityId, resourceType, status: 'CONFIRMED', external: { connectionId } },
    select: { id: true, status: true, entityId: true, externalEntityId: true, external: { select: { externalId: true } } }, orderBy: { id: 'asc' } });
  return rows.map(r => ({ id: r.id, status: r.status, entityId: r.entityId, externalEntityId: r.externalEntityId, externalId: r.external.externalId }));
}
/** Directory pointer, active generation and the state of the newest started attempt of both resources. */
export async function loadDirectory(tx: Prisma.TransactionClient, scope: Scope, connectionId: string): Promise<Record<DirectoryResource, DirectoryState | null>> {
  const rows = await tx.m365ResourceState.findMany({ where: { ...scope, connectionId, resourceType: { in: ['m365_user', 'm365_device'] } },
    select: { resourceType: true, status: true, safeErrorCode: true, activeGenerationId: true, latestStartedSeq: true, latestPublishedSeq: true,
      latestRecordedSeq: true, lastSuccessAt: true, activeGeneration: { select: { id: true, completedAt: true, expiresAt: true } } } });
  const latest = rows.length === 0 ? [] : await tx.m365DirectoryGeneration.findMany({ where: { ...scope, connectionId,
    OR: rows.map(r => ({ resourceType: r.resourceType, attemptSeq: r.latestStartedSeq })) }, select: { resourceType: true, state: true } });
  const out: Record<DirectoryResource, DirectoryState | null> = { m365_user: null, m365_device: null };
  for (const r of rows) {
    out[r.resourceType as DirectoryResource] = { resourceType: r.resourceType as DirectoryResource, status: r.status, safeErrorCode: r.safeErrorCode,
      activeGenerationId: r.activeGenerationId, started: Number(r.latestStartedSeq), published: Number(r.latestPublishedSeq), recorded: Number(r.latestRecordedSeq),
      lastSuccessAt: r.lastSuccessAt, latestState: latest.find(l => l.resourceType === r.resourceType)?.state ?? null, generation: r.activeGeneration };
  }
  return out;
}
/** The generation is usable (unexpired at the snapshot clock); stale when ≥60m old or a newer attempt has started. */
export function directoryUsability(state: DirectoryState | null, clock: DbClock): 'MISSING' | 'EXPIRED' | 'STALE' | 'FRESH' {
  const g = state?.generation;
  if (!state?.activeGenerationId || !g || !g.completedAt) return 'MISSING';
  if (clock.now.getTime() >= g.expiresAt.getTime()) return 'EXPIRED';
  return state.started > state.published || clock.now.getTime() - g.completedAt.getTime() >= DIRECTORY_FRESH_MS ? 'STALE' : 'FRESH';
}

export async function loadMappings(tx: Prisma.TransactionClient, scope: Scope, connectionId: string, source: SourceFacts, clock: DbClock): Promise<MappingFacts> {
  const directory = await loadDirectory(tx, scope, connectionId);
  const facts: MappingFacts = { deviceLinks: [], personLinks: [], directory, deviceObject: null, userObject: null };
  if (!source.device) return facts;
  facts.deviceLinks = await links(tx, scope, connectionId, source.device.id, 'm365_device');
  if (source.device.personId) facts.personLinks = await links(tx, scope, connectionId, source.device.personId, 'm365_user');
  const usableGen = (r: DirectoryResource) => { const u = directoryUsability(directory[r], clock); return u === 'FRESH' || u === 'STALE' ? directory[r]!.activeGenerationId! : null; };
  const deviceGen = usableGen('m365_device'); const userGen = usableGen('m365_user');
  if (facts.deviceLinks.length === 1 && deviceGen) {
    const l = facts.deviceLinks[0]!;
    const o = await tx.m365DirectoryObject.findFirst({ where: { ...scope, connectionId, resourceType: 'm365_device', generationId: deviceGen,
      sourceObjectId: l.externalId, externalEntityId: l.externalEntityId }, select: { deviceId: true } });
    if (o) facts.deviceObject = { deviceId: o.deviceId, duplicates: o.deviceId === null ? 0 : await tx.m365DirectoryObject.count({ where: { ...scope, connectionId,
      resourceType: 'm365_device', generationId: deviceGen, deviceId: o.deviceId } }) };
  }
  if (facts.personLinks.length === 1 && userGen) {
    const l = facts.personLinks[0]!;
    const o = await tx.m365DirectoryObject.findFirst({ where: { ...scope, connectionId, resourceType: 'm365_user', generationId: userGen,
      sourceObjectId: l.externalId, externalEntityId: l.externalEntityId }, select: { sourceObjectId: true } });
    if (o) facts.userObject = { sourceObjectId: o.sourceObjectId };
  }
  return facts;
}

const sorted = (codes: Iterable<CorrelationReasonCode>): CorrelationReasonCode[] => [...new Set(codes)].sort();
export function resolve(source: SourceFacts, mapping: MappingFacts, clock: DbClock): Resolution {
  const codes = new Set<CorrelationReasonCode>();
  if (source.sourceConnection.status === 'DISABLED') codes.add('SOURCE_CONNECTION_DISABLED');
  const none = (state: CorrelationResolutionState, code: CorrelationReasonCode): Resolution => {
    codes.add(code);
    return { device: state, person: state, reasonCodes: sorted(codes), deviceRef: null, userRef: null, deviceProof: null, personProof: null };
  };
  if (source.reference.kind === 'MISSING') return none('UNRESOLVED', 'SOURCE_DEVICE_REFERENCE_MISSING');
  if (source.reference.kind === 'INVALID') return none('UNRESOLVED', 'SOURCE_DEVICE_REFERENCE_INVALID');
  if (source.sourceLinks.length > 1) return none('AMBIGUOUS', 'SOURCE_DEVICE_MAPPING_AMBIGUOUS');
  if (source.sourceLinks.length === 0 || !source.device) return none('UNRESOLVED', 'SOURCE_DEVICE_MAPPING_MISSING');
  const sourceLink = source.sourceLinks[0]!;
  const path = (resource: DirectoryResource, mapped: LinkRow[], missing: CorrelationReasonCode, ambiguous: CorrelationReasonCode,
    member: boolean): { state: CorrelationResolutionState; proof: PathProof | null } => {
    if (mapped.length === 0) { codes.add(missing); return { state: 'UNRESOLVED', proof: null }; }
    if (mapped.length > 1) { codes.add(ambiguous); return { state: 'AMBIGUOUS', proof: null }; }
    const usability = directoryUsability(mapping.directory[resource], clock);
    if (usability === 'MISSING') { codes.add('DIRECTORY_MISSING'); return { state: 'UNRESOLVED', proof: null }; }
    if (usability === 'EXPIRED') { codes.add('DIRECTORY_EXPIRED'); return { state: 'UNRESOLVED', proof: null }; }
    if (usability === 'STALE') codes.add('DIRECTORY_STALE');
    if (!member) { codes.add('DIRECTORY_OBJECT_NOT_CURRENT'); return { state: 'UNRESOLVED', proof: null }; }
    const link = mapped[0]!;
    return { state: 'RESOLVED', proof: { linkIds: [sourceLink.id, link.id], linkStatuses: [sourceLink.status, link.status],
      directoryGenerationIds: [mapping.directory[resource]!.activeGenerationId!] } };
  };
  let device = path('m365_device', mapping.deviceLinks, 'M365_DEVICE_MAPPING_MISSING', 'M365_DEVICE_MAPPING_AMBIGUOUS', mapping.deviceObject !== null);
  let deviceRef: string | null = null;
  if (device.state === 'RESOLVED') {
    const object = mapping.deviceObject!;
    if (object.deviceId === null) { codes.add('M365_DEVICE_REFERENCE_MISSING'); device = { state: 'UNRESOLVED', proof: null }; }
    else if (object.duplicates > 1) { codes.add('M365_DEVICE_REFERENCE_AMBIGUOUS'); device = { state: 'AMBIGUOUS', proof: null }; }
    else deviceRef = object.deviceId;
  }
  let person: { state: CorrelationResolutionState; proof: PathProof | null } = { state: 'UNRESOLVED', proof: null };
  if (source.device.personId === null) codes.add('ASSIGNED_PERSON_MISSING');
  else person = path('m365_user', mapping.personLinks, 'ASSIGNED_PERSON_MAPPING_MISSING', 'ASSIGNED_PERSON_MAPPING_AMBIGUOUS', mapping.userObject !== null);
  return { device: device.state, person: person.state, reasonCodes: sorted(codes), deviceRef, userRef: person.state === 'RESOLVED' ? mapping.userObject!.sourceObjectId : null,
    deviceProof: device.proof, personProof: person.proof };
}

/** Directory resource view of the correlation/directory reads: normative statuses, truthful codes, no DTO. */
export function directoryResource(resourceType: DirectoryResource, state: DirectoryState | null, clock: DbClock): CorrelationResource {
  const usability = directoryUsability(state, clock);
  const base = { resourceType, lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null };
  if (usability === 'MISSING') {
    const error = state?.status === 'ERROR';
    return { ...base, status: error ? 'ERROR' : 'MISSING', asOf: null, safeErrorCode: state?.safeErrorCode ?? 'DIRECTORY_MISSING', coverage: 'UNAVAILABLE' };
  }
  const g = state!.generation!;
  if (usability === 'EXPIRED') return { ...base, status: 'MISSING', asOf: null, safeErrorCode: 'DIRECTORY_EXPIRED', coverage: 'UNAVAILABLE' };
  return { ...base, status: usability === 'FRESH' ? 'OK' : 'STALE', asOf: g.completedAt!.toISOString(), generationId: g.id,
    safeErrorCode: usability === 'FRESH' ? null : state!.status === 'ERROR' && state!.safeErrorCode ? state!.safeErrorCode : 'DIRECTORY_STALE', coverage: 'COMPLETE' };
}
/** Freshness/retention transitions of a usable generation (both hold AT their instant; cursor.ts keeps future ones). */
export function directoryTransitions(state: DirectoryState | null, clock: DbClock): Transition[] {
  const usability = directoryUsability(state, clock);
  if (usability !== 'FRESH' && usability !== 'STALE') return [];
  const g = state!.generation!;
  return usability === 'FRESH' ? [transitionAt(g.expiresAt), transitionAt(new Date(g.completedAt!.getTime() + DIRECTORY_FRESH_MS))] : [transitionAt(g.expiresAt)];
}
export const directoryFingerprint = (s: DirectoryState | null) => s && [s.status, s.safeErrorCode, s.activeGenerationId, s.started, s.published, s.recorded,
  s.latestState, s.generation ? [s.generation.id, s.generation.completedAt?.getTime() ?? null, s.generation.expiresAt.getTime()] : null];
