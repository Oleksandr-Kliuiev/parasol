import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { ASK_LIMITS, ASK_SOURCES, askFailure } from './contracts.ts';
import type { AskSource, ObservationData, SourceMode } from './contracts.ts';

// Validated original source read for Ask (docs/stage5/ask/02_CONTRACTS.md "Server evidence bank"). Every selected row and
// item is validated BEFORE any projection, truncation or bank reduction; nothing here repairs a value (no unknown-source
// substitution, empty-summary fallback, malformed-item-to-ERROR or truncation). Malformed → ASK_SOURCE_INVALID (503);
// a count/size cap overflow → ASK_TOO_LARGE (413). The validators mirror the accepted ClientContextV1 field semantics.

export const SYSTEMS = ['atera', 'huntress', 'microsoft365', 'poweroffice'] as const;
export const NON_ASK_SYSTEMS: readonly string[] = ['microsoft365', 'poweroffice'];
export const CONTEXT_RESOURCE_TYPES = ['customer', 'organization', 'agent', 'contact', 'alert', 'ticket', 'incident'] as const;
export const M365_RESOURCE_TYPES: readonly string[] = ['m365_user', 'm365_device', 'm365_signin'];
export const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const PRIORITIES = ['NORMAL', 'URGENT'] as const;
const ROUTES = ['MONITOR', 'INVESTIGATE', 'HUMAN_REVIEW'] as const;
export const EVENT_KINDS = ['DISK_CAPACITY', 'SECURITY_INCIDENT'] as const;
const DOMAINS = ['OPERATIONS', 'SECURITY'] as const;
const PROVIDERS = ['fixture', 'openai', 'rules'] as const;
export const OBSERVATION_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED'] as const;
export const ACTIVE_STATUSES = ['OPEN', 'ACKNOWLEDGED'] as const;
export const ENTITY_KINDS = ['PERSON', 'DEVICE'] as const;

export interface Scope { readonly workspaceId: string; readonly clientId: string }
export interface SourceResource {
  readonly source: AskSource; readonly resourceType: string; readonly connectionId: string | null; readonly status: string;
  readonly asOf: string | null; readonly lastSuccessAt: string | null; readonly truncated: boolean;
}
export interface GraphEntity { readonly id: string; readonly kind: 'PERSON' | 'DEVICE'; readonly label: string }
export interface GraphLink {
  readonly entityId: string; readonly entityKind: 'PERSON' | 'DEVICE'; readonly system: string; readonly resourceType: string;
  readonly connectionId: string; readonly externalId: string;
}
export type FocusRead =
  | { readonly state: 'NONE' }
  | { readonly state: 'MISSING' }
  | { readonly state: 'UNSUPPORTED' }
  | { readonly state: 'FOUND'; readonly observation: ObservationData; readonly onPage: boolean };
/** The whole validated read: no global counts, no claim of an atomic snapshot across its queries. */
export interface AskSourceRead {
  readonly mode: SourceMode;
  readonly page: readonly ObservationData[];
  readonly pageTruncated: boolean;
  readonly focus: FocusRead;
  readonly entities: ReadonlyMap<string, GraphEntity>;
  readonly links: readonly GraphLink[];
  readonly resources: readonly SourceResource[];
}

export function invalid(): never { return askFailure('ASK_SOURCE_INVALID'); }
export function tooLarge(): never { return askFailure('ASK_TOO_LARGE'); }
type Row = Record<string, unknown>;
export function object(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Row;
}
export function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) invalid();
  if ((value as unknown[]).length > max) tooLarge();
  return value as unknown[];
}
export function text(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return value as string;
}
export const nullableText = (value: unknown): string | null => value === null ? null : text(value);
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid();
  return value as T;
}
export const nullableOneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null => value === null ? null : oneOf(value, allowed);
/** Non-empty identifier of at most 256 characters, used unshortened (an overlong identity is invalid, never cut). */
export function identifier(value: unknown): string {
  const id = text(value);
  if (id.length === 0 || id.length > 256) invalid();
  return id;
}
export const nullableIdentifier = (value: unknown): string | null => value === null ? null : identifier(value);
export function scopeId(value: unknown): string {
  const id = text(value);
  if (!SCOPE_ID_PATTERN.test(id)) invalid();
  return id;
}
export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value as boolean;
}
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** An ISO-8601 instant with an explicit zone (strings) or a valid Date (DB values, emitted as UTC toISOString). */
export function time(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalid();
    return value.toISOString();
  }
  const at = text(value);
  if (!ISO_TIME.test(at) || !Number.isFinite(Date.parse(at))) invalid();
  return at;
}
export const nullableTime = (value: unknown): string | null => value === null ? null : time(value);
export function inScope(row: Row, scope: Scope): void {
  if (row.workspaceId !== scope.workspaceId || row.clientId !== scope.clientId) invalid();
}
export const isAskSource = (system: string): system is AskSource => (ASK_SOURCES as readonly string[]).includes(system);

/** Running materialized size of one source read: total decoded/serialized context ≤4 MiB, checked after materialization. */
export class SourceMeter {
  #bytes = 0;
  add(value: unknown): void {
    this.#bytes += Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    if (this.#bytes > ASK_LIMITS.contextBytes) tooLarge();
  }
  get bytes(): number { return this.#bytes; }
}

/**
 * One ObservationSummary-shaped record of the captured scope (fixture summary objects and DB rows alike, after the DB
 * reader has renamed its columns). `statuses` restricts the lifecycle (active page) or allows all (focus). The source must
 * already be known to be Atera/Huntress. Fields not projected into the bank (eventKey, revision, kind, domain, provider,
 * decisionRunId) are validated too: the whole original record, not a minimized subset.
 */
export function observationRecord(raw: unknown, scope: Scope, statuses: readonly string[]): ObservationData {
  const row = object(raw);
  inScope(row, scope);
  const source = oneOf(row.source, ASK_SOURCES);
  identifier(row.eventKey); text(row.revision); nullableIdentifier(row.decisionRunId);
  oneOf(row.kind, EVENT_KINDS); oneOf(row.domain, DOMAINS); oneOf(row.provider, PROVIDERS);
  const confidence = row.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) invalid();
  const reasonCodes = list(row.reasonCodes, ASK_LIMITS.reasonCodes).map(text);
  return {
    observationId: identifier(row.id), source, resourceType: oneOf(row.resourceType, CONTEXT_RESOURCE_TYPES), connectionId: scopeId(row.connectionId),
    externalEventId: identifier(row.externalEventId), summary: text(row.summary), severity: oneOf(row.severity, SEVERITIES),
    priority: oneOf(row.priority, PRIORITIES), route: oneOf(row.route, ROUTES), confidence: confidence as number, reasonCodes,
    status: oneOf(row.status, statuses), entityId: nullableIdentifier(row.entityId), conflictOfEventKey: nullableIdentifier(row.conflictOfEventKey),
    supersededById: nullableIdentifier(row.supersededById), occurredAt: time(row.occurredAt), createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt), acknowledgedAt: nullableTime(row.acknowledgedAt), resolvedAt: nullableTime(row.resolvedAt)
  };
}

/** Source of a record before validation: Atera/Huntress, a known excluded system, or invalid (unknown). */
export function sourceClass(system: unknown): 'ASK' | 'EXCLUDED' {
  const known = oneOf(system, SYSTEMS);
  return isAskSource(known) ? 'ASK' : 'EXCLUDED';
}

/** Active page in server order: at most 100 validated rows, duplicate observation IDs invalidate the whole read. */
export function activePage(rows: readonly unknown[], scope: Scope): ObservationData[] {
  if (rows.length > ASK_LIMITS.observationPage) invalid();
  const page = rows.map(row => observationRecord(row, scope, ACTIVE_STATUSES));
  if (new Set(page.map(o => o.observationId)).size !== page.length) invalid();
  return page;
}

/** Graph identities: unique IDs across people and devices, each kind within its 1000 cap. */
export function graphEntities(people: readonly GraphEntity[], devices: readonly GraphEntity[]): Map<string, GraphEntity> {
  if (people.length > ASK_LIMITS.graphRows || devices.length > ASK_LIMITS.graphRows) tooLarge();
  const entities = new Map<string, GraphEntity>();
  for (const entity of [...people, ...devices]) {
    if (entities.has(entity.id)) invalid();
    entities.set(entity.id, entity);
  }
  return entities;
}

/** CONFIRMED non-M365 links in link order; each names an existing entity of the same kind (no dangling identity). */
export function graphLinks(rows: readonly unknown[], entities: ReadonlyMap<string, GraphEntity>): GraphLink[] {
  if (rows.length > ASK_LIMITS.graphRows) tooLarge();
  return rows.map(raw => {
    const row = object(raw);
    if (row.status !== 'CONFIRMED') invalid();
    const entityId = identifier(row.entityId);
    const entityKind = oneOf(row.entityKind, ENTITY_KINDS);
    if (entities.get(entityId)?.kind !== entityKind) invalid();
    return { entityId, entityKind, system: oneOf(row.system, SYSTEMS), resourceType: oneOf(row.resourceType, CONTEXT_RESOURCE_TYPES),
      connectionId: scopeId(row.connectionId), externalId: identifier(row.externalId) };
  });
}

/** Resource tuples are unique (source, type, connection); a duplicate is ambiguous and invalidates the read. */
export function uniqueResources(resources: readonly SourceResource[]): readonly SourceResource[] {
  if (resources.length > ASK_LIMITS.resources) tooLarge();
  const keys = new Set(resources.map(r => JSON.stringify([r.source, r.resourceType, r.connectionId])));
  if (keys.size !== resources.length) invalid();
  return resources;
}

/** DB SnapshotItem (task 1.5 projection) of one resource: source tuple, identifiers, enums and times; extra keys ignored. */
export function snapshotItem(raw: unknown, source: string, resourceType: string): void {
  const row = object(raw);
  if (row.source !== source || row.resourceType !== resourceType) invalid();
  identifier(row.externalId); text(row.title); text(row.status); nullableOneOf(row.severity, SEVERITIES); nullableText(row.priority);
  if (row.device !== null) {
    const device = object(row.device);
    oneOf(device.resourceType, CONTEXT_RESOURCE_TYPES); identifier(device.externalId);
  }
  nullableTime(row.occurredAt); nullableTime(row.updatedAt);
}
