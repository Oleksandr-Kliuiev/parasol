import type { ObservationData } from '../../packages/ask/contracts.ts';
import type { AskSourceRead, FocusRead, GraphEntity, GraphLink, SourceResource } from '../../packages/ask/source.ts';

// Synthetic validated Ask source reads for the pure projection/planner/compiler tests (tests/ask-compiler.test.ts).
// No real tenant data: every identifier and label is invented.

export function observation(id: string, overrides: Partial<ObservationData> = {}): ObservationData {
  return { observationId: id, source: 'atera', resourceType: 'alert', connectionId: 'atera-a', externalEventId: `ext-${id}`, summary: `Synthetic ${id}`,
    severity: 'MEDIUM', priority: 'NORMAL', route: 'MONITOR', confidence: 0.5, reasonCodes: ['RULES_BASELINE'], status: 'OPEN', entityId: null,
    conflictOfEventKey: null, supersededById: null, occurredAt: '2026-10-10T07:00:00.000Z', createdAt: '2026-10-10T07:00:00.000Z',
    updatedAt: '2026-10-10T07:00:00.000Z', acknowledgedAt: null, resolvedAt: null, ...overrides };
}
export function resource(source: 'atera' | 'huntress', resourceType: string, connectionId: string | null, status = 'OK'): SourceResource {
  return { source, resourceType, connectionId, status, asOf: status === 'OK' || status === 'STALE' || status === 'FIXTURE' ? '2026-10-10T07:00:00.000Z' : null,
    lastSuccessAt: null, truncated: false };
}
export interface SourceSpec {
  page?: ObservationData[]; focus?: FocusRead; truncated?: boolean; resources?: SourceResource[];
  entities?: GraphEntity[]; links?: GraphLink[]; mode?: 'fixture' | 'db';
}
export function source(spec: SourceSpec = {}): AskSourceRead {
  return { mode: spec.mode ?? 'db', page: spec.page ?? [], pageTruncated: spec.truncated ?? false, focus: spec.focus ?? { state: 'NONE' },
    entities: new Map((spec.entities ?? []).map(e => [e.id, e])), links: spec.links ?? [], resources: spec.resources ?? [] };
}
export const found = (o: ObservationData, onPage = true): FocusRead => ({ state: 'FOUND', observation: o, onPage });
