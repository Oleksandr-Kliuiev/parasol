import { randomUUID } from 'node:crypto';
import { answer, compile } from '../../packages/ask/compiler.ts';
import { mockPlan, validatePlan } from '../../packages/ask/planner.ts';
import { project } from '../../packages/ask/projection.ts';
import { fixtureSource } from '../../packages/ask/fixture.ts';
import { OBSERVATION_STATUSES, activePage, graphEntities, graphLinks, observationRecord, uniqueResources } from '../../packages/ask/source.ts';
import type { AskSourceRead, FocusRead, GraphEntity, SourceResource } from '../../packages/ask/source.ts';
import type { AskAnswerV1 } from '../../packages/ask/contracts.ts';
import { fixtureContext } from './operator-fixtures.ts';

// ASK-B browser test support: genuine AskAnswerV1 bodies compiled by the ACCEPTED server modules (packages/ask projection,
// MOCK planner, compiler; imported read-only, never changed) from synthetic source reads, so the browser validator is
// checked against real server output before hostile mutations. Values are synthetic; nothing here exists in any account.

export const AT = '2026-10-10T08:00:00.000Z';
export interface Frame { readonly requestId?: string; readonly correlationId?: string; readonly workspaceId: string; readonly clientId: string }

/** Compiles the MOCK answer to `question` for `source`, exactly as the API would (plan validated as a whole first). */
export function compiledAnswer(source: AskSourceRead, question: string, focusId: string | null, frame: Frame): AskAnswerV1 {
  const projection = project(source);
  const raw = mockPlan({ question, focusRef: projection.focusRef, focusResourceRef: projection.focusResourceRef,
    focusEntityRef: projection.focusEntityRef, bank: projection.descriptors });
  const plan = validatePlan(raw, new Set(projection.bank.map(f => f.ref)));
  return answer({ requestId: frame.requestId ?? randomUUID(), correlationId: frame.correlationId ?? randomUUID(), workspaceId: frame.workspaceId,
    clientId: frame.clientId, sourceMode: source.mode, focusObservationId: focusId, generatedAt: AT }, compile(plan, projection, focusId), projection);
}

/**
 * RC2 (R1): the answer to a VALID empty plan of a supported intent — the accepted compiler's INSUFFICIENT with zero claims,
 * whatever eligible evidence and focus the bank holds (a planner may leave eligible facts uncited). Not a MOCK phrase path.
 */
export function emptyPlanAnswer(source: AskSourceRead, intent: 'SUMMARY' | 'WHY_URGENT' | 'SOURCE_STATE' | 'ENTITY', focusId: string | null, frame: Frame): AskAnswerV1 {
  const projection = project(source);
  const plan = validatePlan({ version: 'AskPlanV1', intent, refs: [] }, new Set(projection.bank.map(f => f.ref)));
  return answer({ requestId: frame.requestId ?? randomUUID(), correlationId: frame.correlationId ?? randomUUID(), workspaceId: frame.workspaceId,
    clientId: frame.clientId, sourceMode: source.mode, focusObservationId: focusId, generatedAt: AT }, compile(plan, projection, focusId), projection);
}

/** The fixture demo context as the fixture API reads it for Ask (validated whole, no repair). */
export async function fixtureRead(focusId: string | null): Promise<AskSourceRead> {
  const context = await fixtureContext();
  return fixtureSource(context, { workspaceId: context.workspaceId, clientId: context.clientId }, focusId);
}

export interface DbRead {
  readonly workspaceId: string; readonly clientId: string;
  /** ObservationSummary-shaped rows of the active page, in server order. */
  readonly page: Record<string, unknown>[];
  readonly truncated?: boolean;
  /** Focus: an ID on the page, an extra row (any lifecycle status) or a missing ID. */
  readonly focus?: { readonly id: string } | { readonly extra: Record<string, unknown> } | { readonly missing: string } | null;
  readonly people?: readonly { id: string; label: string }[];
  readonly devices?: readonly { id: string; label: string }[];
  readonly links?: readonly Record<string, unknown>[];
  readonly resources?: readonly SourceResource[];
}
/** A DB-mode source read built with the accepted source validators (packages/ask/source.ts). */
export function dbRead(read: DbRead): { source: AskSourceRead; focusId: string | null } {
  const scope = { workspaceId: read.workspaceId, clientId: read.clientId };
  const page = activePage(read.page, scope);
  let focus: FocusRead = { state: 'NONE' };
  let focusId: string | null = null;
  const f = read.focus ?? null;
  if (f && 'id' in f) { focusId = f.id; const found = page.find(o => o.observationId === f.id); focus = found ? { state: 'FOUND', observation: found, onPage: true } : { state: 'MISSING' }; }
  else if (f && 'extra' in f) { const o = observationRecord(f.extra, scope, OBSERVATION_STATUSES); focusId = o.observationId; focus = { state: 'FOUND', observation: o, onPage: false }; }
  else if (f && 'missing' in f) { focusId = f.missing; focus = { state: 'MISSING' }; }
  const entity = (kind: 'PERSON' | 'DEVICE') => (e: { id: string; label: string }): GraphEntity => ({ id: e.id, kind, label: e.label });
  const entities = graphEntities((read.people ?? []).map(entity('PERSON')), (read.devices ?? []).map(entity('DEVICE')));
  const links = graphLinks(read.links ?? [], entities);
  return { source: Object.freeze({ mode: 'db' as const, page, pageTruncated: read.truncated ?? false, focus, entities, links,
    resources: uniqueResources(read.resources ?? []) }), focusId };
}

export const resource = (source: 'atera' | 'huntress', resourceType: string, connectionId: string | null, status: string, patch: Partial<SourceResource> = {}): SourceResource =>
  ({ source, resourceType, connectionId, status, asOf: status === 'OK' || status === 'STALE' ? AT : null, lastSuccessAt: status === 'MISSING' ? null : AT, truncated: false, ...patch });
export const link = (entityId: string, entityKind: 'PERSON' | 'DEVICE', system: string, resourceType: string, connectionId: string, externalId: string) =>
  ({ status: 'CONFIRMED', entityId, entityKind, system, resourceType, connectionId, externalId });

/** A JSON round trip plus a mutation: the hostile body the browser receives. */
export function hostile<T>(value: T, change: (copy: any) => void): unknown {
  const copy = JSON.parse(JSON.stringify(value));
  change(copy);
  return copy;
}
/** Response headers of an enabled Ask route: JSON, no-store and the correlation UUID. */
export const askHeaders = (correlationId: string): Headers =>
  new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-atlas-correlation-id': correlationId });
export const askResponse = (body: unknown, status = 200, correlationId = (body as { correlationId?: string })?.correlationId ?? randomUUID()): Response =>
  new Response(JSON.stringify(body), { status, headers: askHeaders(correlationId) });
export const askError = (code: string, status: number, correlationId = randomUUID()): Response =>
  askResponse({ contractVersion: 'AskErrorV1', code, correlationId }, status, correlationId);
export const capabilityResponse = (correlationId = randomUUID()): Response =>
  new Response(JSON.stringify({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 }), { status: 200, headers: askHeaders(correlationId) });
