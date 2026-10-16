import type { ObservationData } from '../../packages/ask/contracts.ts';
import { activePage, graphEntities, graphLinks, observationRecord, OBSERVATION_STATUSES, uniqueResources } from '../../packages/ask/source.ts';
import type { AskSourceRead, FocusRead, GraphEntity, SourceResource } from '../../packages/ask/source.ts';
import { FIXTURE_FILE, INTENTS, readData } from './dataset.ts';
import type { Intent } from './dataset.ts';

// Frozen synthetic source fixtures (docs/stage5/ask/remote/eval/data/fixtures.json). The declarative rows are expanded into
// the ORIGINAL row shapes and passed through the ACCEPTED source validators (activePage, observationRecord, graphEntities,
// graphLinks, uniqueResources), exactly as the DB reader does, so every fixture is a validated AskSourceRead. Separate
// reachability rules restate the accepted DB reader semantics (packages/ask/read.ts) independently: server page order,
// connection-ID order, the expected resource types per system, CONFIRMED-only links and status/time consistency. The
// expected answers in the file are hand-declared; nothing here calls the projection, selector or compiler.

export interface ExpectedIntentFacts { readonly status: 'ANSWER' | 'INSUFFICIENT' | 'UNSUPPORTED'; readonly claims: readonly (readonly [string, string])[] }
export interface ExpectedFacts {
  readonly bank: readonly string[]; readonly resourceStatus: Readonly<Record<string, string>>; readonly urgent: readonly string[];
  readonly coverage: Readonly<Record<string, number | boolean>>; readonly entity: Readonly<Record<string, unknown>> | null;
  readonly intents: Readonly<Record<Intent, ExpectedIntentFacts>>;
}
export interface FixtureSpec {
  readonly fixtureId: string; readonly scenario: string; readonly hasFocus: boolean; readonly requestedFocus: string | null; readonly purpose: string;
  readonly page?: readonly ObsSpec[]; readonly pageSeries?: readonly SeriesSpec[]; readonly pageTruncated: boolean;
  readonly focus: { readonly state: 'NONE' | 'MISSING' | 'FOUND'; readonly pageId?: string; readonly offPage?: ObsSpec };
  readonly connections: readonly { id: string; system: 'atera' | 'huntress'; states: Readonly<Record<string, StateSpec>> }[];
  readonly entities: readonly GraphEntity[]; readonly links: readonly LinkSpec[]; readonly readerExcludedLinks: readonly LinkSpec[];
  readonly expected: ExpectedFacts;
}
export interface ObsSpec {
  id: string; source: 'atera' | 'huntress'; severity: string; createdAt?: string; status?: string; entityId?: string | null; connectionId?: string;
  acknowledgedAt?: string; resolvedAt?: string;
}
interface SeriesSpec { prefix: string; pad: number; from: number; to: number; source: 'atera' | 'huntress'; severity: string }
interface StateSpec { status: string; asOf: string | null; lastSuccessAt: string | null; truncated: boolean }
interface LinkSpec { entityId: string; entityKind: string; status: string; system: string; resourceType: string; connectionId: string; externalId: string }
export interface FixtureFile { readonly scope: { workspaceId: string; clientId: string }; readonly fixtures: readonly FixtureSpec[] }

/** Restated accepted reader facts (packages/graph/context-mapper.ts expectedResources; read.ts severity order). */
export const EXPECTED_TYPES: Readonly<Record<string, readonly string[]>> = { atera: ['alert', 'ticket'], huntress: ['incident'] };
const OBSERVATION_TYPE: Readonly<Record<string, { resourceType: string; kind: string; domain: string; connectionId: string }>> = {
  atera: { resourceType: 'alert', kind: 'DISK_CAPACITY', domain: 'OPERATIONS', connectionId: 'syn-atera-1' },
  huntress: { resourceType: 'incident', kind: 'SECURITY_INCIDENT', domain: 'SECURITY', connectionId: 'syn-huntress-1' }
};
const RANK: Readonly<Record<string, number>> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const DEFAULT_TIME = '2026-10-10T07:00:00.000Z';
export const SOURCE_MARKER = 'SYNTH-SOURCE-MARKER';

export function loadFixtureFile(read: (name: string) => Buffer = readData): FixtureFile {
  return JSON.parse(read(FIXTURE_FILE).toString('utf8')) as FixtureFile;
}

export function expandPage(spec: FixtureSpec): ObsSpec[] {
  const out: ObsSpec[] = [...(spec.page ?? [])];
  for (const s of spec.pageSeries ?? []) {
    for (let i = s.from; i <= s.to; i += 1) out.push({ id: `${s.prefix}${String(i).padStart(s.pad, '0')}`, source: s.source, severity: s.severity });
  }
  return out;
}

/** The original Observation+RawEvent row shape that observationRecord validates (all fields, not a minimized subset). */
export function originalRow(o: ObsSpec, scope: FixtureFile['scope']): Record<string, unknown> {
  const t = OBSERVATION_TYPE[o.source]!;
  const urgent = o.severity === 'HIGH' || o.severity === 'CRITICAL';
  const created = o.createdAt ?? DEFAULT_TIME;
  return { workspaceId: scope.workspaceId, clientId: scope.clientId, id: o.id, eventKey: `syn-event-${o.id}`, revision: '1', decisionRunId: null,
    kind: t.kind, domain: t.domain, provider: 'rules', confidence: 1, reasonCodes: ['RULES_BASELINE'], source: o.source, resourceType: t.resourceType,
    connectionId: o.connectionId ?? t.connectionId, externalEventId: `syn-ext-${o.id}`, summary: `${SOURCE_MARKER} summary of ${o.id}`,
    severity: o.severity, priority: urgent ? 'URGENT' : 'NORMAL', route: urgent ? 'HUMAN_REVIEW' : 'MONITOR', status: o.status ?? 'OPEN',
    entityId: o.entityId ?? null, conflictOfEventKey: null, supersededById: null, occurredAt: created, createdAt: created, updatedAt: created,
    acknowledgedAt: o.acknowledgedAt ?? null, resolvedAt: o.resolvedAt ?? null };
}

const serverBefore = (a: ObservationData, b: ObservationData): boolean =>
  RANK[a.severity]! > RANK[b.severity]! || (RANK[a.severity] === RANK[b.severity]
    && (a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.observationId < b.observationId)));

/** Reachability issues of one fixture under the accepted DB reader semantics; empty means reachable. */
export function reachabilityIssues(spec: FixtureSpec, page: readonly ObservationData[], resources: readonly SourceResource[]): string[] {
  const issues: string[] = [];
  if (page.length > 100) issues.push('PAGE_OVER_100');
  if (spec.pageTruncated && page.length !== 100) issues.push('TRUNCATED_PAGE_NOT_FULL');
  for (let i = 1; i < page.length; i += 1) if (!serverBefore(page[i - 1]!, page[i]!)) issues.push(`PAGE_ORDER_${i}`);
  const ids = spec.connections.map(c => c.id);
  if (ids.join() !== [...ids].sort().join()) issues.push('CONNECTION_ORDER');
  const connections = new Map(spec.connections.map(c => [c.id, c.system] as const));
  const observations = [...page, ...(spec.focus.state === 'FOUND' && spec.focus.offPage ? [spec.focus.offPage] : [])];
  for (const o of observations) {
    const connectionId = 'observationId' in o ? o.connectionId : (o.connectionId ?? OBSERVATION_TYPE[o.source]!.connectionId);
    if (connections.get(connectionId) !== o.source) issues.push('OBSERVATION_CONNECTION');
  }
  for (const r of resources) {
    if ((r.status === 'OK' || r.status === 'STALE') !== (r.asOf !== null)) issues.push('RESOURCE_AS_OF');
    if (!(r.status === 'OK' || r.status === 'STALE') && r.truncated) issues.push('RESOURCE_TRUNCATED');
    if (!['OK', 'STALE', 'ERROR', 'MISSING'].includes(r.status)) issues.push('RESOURCE_STATUS');
  }
  for (const c of spec.connections) for (const type of Object.keys(c.states)) if (!EXPECTED_TYPES[c.system]!.includes(type)) issues.push('RESOURCE_TYPE');
  if (spec.readerExcludedLinks.some(l => l.status === 'CONFIRMED')) issues.push('EXCLUDED_LINK_CONFIRMED');
  if (spec.focus.state === 'FOUND' && spec.focus.pageId !== undefined && !page.some(o => o.observationId === spec.focus.pageId)) issues.push('FOCUS_NOT_ON_PAGE');
  if (spec.focus.state === 'FOUND' && spec.focus.offPage && page.some(o => o.observationId === spec.focus.offPage!.id)) issues.push('OFF_PAGE_FOCUS_ON_PAGE');
  if (spec.focus.state === 'MISSING' && (spec.requestedFocus === null || page.some(o => o.observationId === spec.requestedFocus))) issues.push('MISSING_FOCUS');
  if (spec.focus.state === 'NONE' && spec.requestedFocus !== null) issues.push('NONE_WITH_REQUEST');
  const focusId = spec.focus.state === 'FOUND' ? (spec.focus.pageId ?? spec.focus.offPage?.id) : undefined;
  if (spec.focus.state === 'FOUND' && focusId !== spec.requestedFocus) issues.push('FOCUS_REQUEST_MISMATCH');
  if (spec.hasFocus !== (spec.focus.state === 'FOUND')) issues.push('HAS_FOCUS_DECLARATION');
  for (const o of observations) {
    const entityId = 'observationId' in o ? o.entityId : (o.entityId ?? null);
    if (entityId !== null && !spec.entities.some(e => e.id === entityId)) issues.push('ENTITY_FK');
  }
  return issues;
}

/** One validated AskSourceRead (db mode) built from the declarative fixture through the accepted validators. */
export function buildSource(spec: FixtureSpec, scope: FixtureFile['scope']): { source: AskSourceRead; reachability: string[] } {
  const page = activePage(expandPage(spec).map(o => originalRow(o, scope)), scope);
  let focus: FocusRead;
  if (spec.focus.state === 'NONE') focus = { state: 'NONE' };
  else if (spec.focus.state === 'MISSING') focus = { state: 'MISSING' };
  else if (spec.focus.offPage) focus = { state: 'FOUND', observation: observationRecord(originalRow(spec.focus.offPage, scope), scope, OBSERVATION_STATUSES), onPage: false };
  else {
    const onPage = page.find(o => o.observationId === spec.focus.pageId);
    if (!onPage) throw new Error(`FIXTURE_FOCUS_NOT_ON_PAGE ${spec.fixtureId}`);
    focus = { state: 'FOUND', observation: onPage, onPage: true };
  }
  const entities = graphEntities(spec.entities.filter(e => e.kind === 'PERSON'), spec.entities.filter(e => e.kind === 'DEVICE'));
  const links = graphLinks(spec.links, entities);
  const resources: SourceResource[] = [];
  for (const c of spec.connections) {
    for (const resourceType of EXPECTED_TYPES[c.system]!) {
      const state = c.states[resourceType] ?? { status: 'MISSING', asOf: null, lastSuccessAt: null, truncated: false };
      resources.push({ source: c.system, resourceType, connectionId: c.id, status: state.status, asOf: state.asOf, lastSuccessAt: state.lastSuccessAt, truncated: state.truncated });
    }
  }
  const source: AskSourceRead = { mode: 'db', page, pageTruncated: spec.pageTruncated, focus, entities, links, resources: uniqueResources(resources) };
  return { source, reachability: reachabilityIssues(spec, page, resources) };
}

/** Structural completeness of the declared expectations (every one of the five intents present). */
export function expectationIssues(spec: FixtureSpec): string[] {
  const issues: string[] = [];
  for (const intent of INTENTS) if (!spec.expected.intents[intent]) issues.push(`EXPECTED_${intent}_MISSING`);
  if (spec.expected.intents.UNSUPPORTED?.status !== 'UNSUPPORTED' || spec.expected.intents.UNSUPPORTED.claims.length !== 0) issues.push('EXPECTED_UNSUPPORTED_SHAPE');
  return issues;
}
