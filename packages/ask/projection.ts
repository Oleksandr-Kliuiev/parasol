import { ASK_LIMITS } from './contracts.ts';
import type { AskCoverage, BankFact, EntityData, ObservationData, ResourceData } from './contracts.ts';
import { isAskSource } from './source.ts';
import type { AskSourceRead, SourceResource } from './source.ts';

/**
 * Evidence bank of one admitted read (docs/stage5/ask/02_CONTRACTS.md "Server evidence bank"). Runs only on the whole
 * validated source read. ≤32 facts: ≤24 observations (focus first, deduplicated by exact ID, then source order), ≤7
 * resource-state facts (accepted context order, the exact focus tuple promoted first), 1 focus entity fact. Refs E1..E32
 * are assigned consecutively in that order. Every fact is a fresh explicit projection; display strings are capped.
 * The planner descriptors carry known enums only — no names, summaries, reason codes, identifiers or times.
 */
export interface AskDescriptor {
  readonly ref: string; readonly kind: BankFact['kind']; readonly source: string; readonly type: string;
  readonly severity?: string; readonly route?: string; readonly status?: string; readonly entityState?: string;
}
export interface AskProjection {
  readonly bank: readonly BankFact[];
  readonly coverage: AskCoverage;
  readonly focusRef: string | null;
  readonly focusResourceRef: string | null;
  readonly focusEntityRef: string | null;
  readonly descriptors: readonly AskDescriptor[];
}

export const DISPLAY_MARKER = '…';
/** At most 4000 code points; a longer display string keeps 3999 and ends with the marker. Identifiers never pass here. */
export function displayText(value: string): string {
  const points = Array.from(value);
  return points.length <= ASK_LIMITS.displayCodePoints ? value : points.slice(0, ASK_LIMITS.displayCodePoints - 1).join('') + DISPLAY_MARKER;
}
export const isUrgent = (severity: string): boolean => severity === 'HIGH' || severity === 'CRITICAL';

function observationData(o: ObservationData): ObservationData {
  return { observationId: o.observationId, source: o.source, resourceType: o.resourceType, connectionId: o.connectionId,
    externalEventId: o.externalEventId, summary: displayText(o.summary), severity: o.severity, priority: o.priority, route: o.route,
    confidence: o.confidence, reasonCodes: o.reasonCodes.map(displayText), status: o.status, entityId: o.entityId,
    conflictOfEventKey: o.conflictOfEventKey, supersededById: o.supersededById, occurredAt: o.occurredAt, createdAt: o.createdAt,
    updatedAt: o.updatedAt, acknowledgedAt: o.acknowledgedAt, resolvedAt: o.resolvedAt };
}
function resourceData(r: SourceResource & { connectionId: string }): ResourceData {
  return { source: r.source, resourceType: r.resourceType, connectionId: r.connectionId, status: r.status, asOf: r.asOf,
    lastSuccessAt: r.lastSuccessAt, truncated: r.truncated };
}
const sameTuple = (r: SourceResource, o: ObservationData): boolean =>
  r.connectionId !== null && r.source === o.source && r.resourceType === o.resourceType && r.connectionId === o.connectionId;

/** Exact graph ID + kind + one CONFIRMED Atera/Huntress link of the same entity and kind (first in link order). Never a name. */
function entityData(source: AskSourceRead, focus: ObservationData): EntityData {
  const none = { entityKind: null, displayName: null, confirmation: null };
  if (focus.entityId === null) return { observationId: focus.observationId, entityId: null, state: 'UNRESOLVED', ...none };
  const entity = source.entities.get(focus.entityId);
  if (!entity) return { observationId: focus.observationId, entityId: focus.entityId, state: 'UNAVAILABLE', ...none };
  const link = source.links.find(l => l.entityId === entity.id && l.entityKind === entity.kind && isAskSource(l.system));
  if (!link || !isAskSource(link.system)) return { observationId: focus.observationId, entityId: entity.id, state: 'UNRESOLVED', ...none };
  return { observationId: focus.observationId, entityId: entity.id, state: 'CONFIRMED', entityKind: entity.kind, displayName: displayText(entity.label),
    confirmation: { source: link.system, resourceType: link.resourceType, connectionId: link.connectionId, externalId: link.externalId } };
}

export function project(source: AskSourceRead): AskProjection {
  const focus = source.focus.state === 'FOUND' ? source.focus.observation : null;
  const candidates = focus ? [focus, ...source.page.filter(o => o.observationId !== focus.observationId)] : [...source.page];
  const observations = candidates.slice(0, ASK_LIMITS.bankObservations);
  const omittedObservations = candidates.slice(ASK_LIMITS.bankObservations);

  const eligible = source.resources.filter((r): r is SourceResource & { connectionId: string } => r.connectionId !== null);
  const promoted = focus ? eligible.findIndex(r => sameTuple(r, focus)) : -1;
  const ordered = promoted === -1 ? eligible : [eligible[promoted]!, ...eligible.filter((_, i) => i !== promoted)];
  const resources = ordered.slice(0, ASK_LIMITS.bankResources);

  const bank: BankFact[] = [];
  const ref = () => `E${bank.length + 1}`;
  for (const o of observations) bank.push({ ref: ref(), kind: 'OBSERVATION', data: observationData(o) });
  for (const r of resources) bank.push({ ref: ref(), kind: 'RESOURCE_STATE', data: resourceData(r) });
  if (focus) bank.push({ ref: ref(), kind: 'ENTITY', data: entityData(source, focus) });

  const focusRef = focus ? bank[0]!.ref : null;
  const focusResource = focus && promoted !== -1 ? bank.find(f => f.kind === 'RESOURCE_STATE') : undefined;
  const focusResourceRef = focusResource && focusResource.kind === 'RESOURCE_STATE' && sameTuple(focusResource.data, focus!) ? focusResource.ref : null;
  const focusEntityRef = focus ? bank[bank.length - 1]!.ref : null;
  const coverage: AskCoverage = {
    observationLimit: 100, bankLimit: 32, observationsRead: source.page.length, observationPageTruncated: source.pageTruncated,
    focusExtra: source.focus.state === 'FOUND' && !source.focus.onPage, observationFactsOmitted: omittedObservations.length > 0,
    urgentFactsOmitted: omittedObservations.some(o => isUrgent(o.severity)), resourcesRead: source.resources.length,
    resourceFactsOmitted: eligible.length !== source.resources.length || ordered.length > resources.length, fixture: source.mode === 'fixture'
  };
  const descriptors = bank.map((fact): AskDescriptor => {
    if (fact.kind === 'OBSERVATION') return { ref: fact.ref, kind: fact.kind, source: fact.data.source, type: fact.data.resourceType,
      severity: fact.data.severity, route: fact.data.route, status: fact.data.status };
    if (fact.kind === 'RESOURCE_STATE') return { ref: fact.ref, kind: fact.kind, source: fact.data.source, type: fact.data.resourceType, status: fact.data.status };
    return { ref: fact.ref, kind: fact.kind, source: focus!.source, type: focus!.resourceType, entityState: fact.data.state };
  });
  return Object.freeze({ bank: Object.freeze(bank), coverage, focusRef, focusResourceRef, focusEntityRef, descriptors: Object.freeze(descriptors) });
}
