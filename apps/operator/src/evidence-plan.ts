// Evidence allowlist (docs/stage5/02_CONTRACTS.md, Evidence action allowlist). DOM-free. The selected observation's
// validated source tuple alone decides whether a stored-evidence read exists and which one; nothing comes from form text.
import { EXTERNAL_ID_PATTERN, SCOPE_ID_PATTERN } from './contracts.ts';
import type { ContextMode, EvidenceTool, ObservationItem, ResourceType, System } from './contracts.ts';
import type { EvidenceOperation } from './operations.ts';

/** Why no request is made: fixture Huntress lookup (demo limitation), any other source/type, or a malformed stored reference. */
export type EvidenceUnavailable = 'FIXTURE_HUNTRESS' | 'UNSUPPORTED' | 'INVALID_REFERENCE';

/** The exact read a deliberate click would make, bound to the captured source tuple. */
export interface EvidenceTarget {
  readonly tool: EvidenceTool; readonly mode: ContextMode; readonly clientId: string; readonly observationId: string;
  readonly source: System; readonly resourceType: ResourceType; readonly connectionId: string; readonly sourceId: string;
}
export type EvidencePlan = { readonly kind: 'request'; readonly target: EvidenceTarget } | { readonly kind: 'unavailable'; readonly reason: EvidenceUnavailable };

function toolFor(item: ObservationItem, mode: ContextMode): EvidenceTool | 'FIXTURE_HUNTRESS' | 'UNSUPPORTED' {
  if (item.source === 'atera' && item.resourceType === 'alert') return 'atera.alert.list';
  if (item.source === 'atera' && item.resourceType === 'ticket') return 'atera.ticket.get';
  if (item.source === 'huntress' && item.resourceType === 'incident') return mode === 'db' ? 'huntress.incident.get' : 'FIXTURE_HUNTRESS';
  return 'UNSUPPORTED';
}

export function planEvidence(item: ObservationItem, clientId: string, mode: ContextMode): EvidencePlan {
  const tool = toolFor(item, mode);
  if (tool === 'FIXTURE_HUNTRESS' || tool === 'UNSUPPORTED') return { kind: 'unavailable', reason: tool };
  if (!SCOPE_ID_PATTERN.test(clientId) || !SCOPE_ID_PATTERN.test(item.connectionId) || !EXTERNAL_ID_PATTERN.test(item.externalEventId)) {
    return { kind: 'unavailable', reason: 'INVALID_REFERENCE' };
  }
  return { kind: 'request', target: Object.freeze({ tool, mode, clientId, observationId: item.id, source: item.source, resourceType: item.resourceType,
    connectionId: item.connectionId, sourceId: item.externalEventId }) };
}

/** The closed operation for a target and a fresh request ID; parameter names are fixed per tool. */
export function evidenceOperation(target: EvidenceTarget, requestId: string): EvidenceOperation {
  const base = { clientId: target.clientId, connectionId: target.connectionId, requestId };
  switch (target.tool) {
    case 'atera.alert.list': return { tool: target.tool, ...base };
    case 'atera.ticket.get': return { tool: target.tool, ...base, ticketId: target.sourceId };
    case 'huntress.incident.get': return { tool: target.tool, ...base, incidentId: target.sourceId };
  }
}

/** True while `item` still has exactly the captured source tuple (a completion for another tuple is stale). */
export function sameTarget(target: EvidenceTarget, item: ObservationItem | null, clientId: string | null): boolean {
  return !!item && clientId === target.clientId && item.id === target.observationId && item.source === target.source
    && item.resourceType === target.resourceType && item.connectionId === target.connectionId && item.externalEventId === target.sourceId;
}
