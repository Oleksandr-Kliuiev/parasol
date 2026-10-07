import type { Scope, NormalizedEvent, Severity } from '../../packages/core/contracts.ts';
import { AtlasError, severities } from '../../packages/core/contracts.ts';
// Atlas-owned synthetic DTO for the in-memory reference pipeline and demo. NOT a claim about Huntress field names: the
// verified vendor contract lives in connectors/huntress/contract.ts (task 1.5, connectors/CONTRACTS.md).
export interface HuntressIncidentFixture { id: string; revision: string; agentId: string; at: string; signal: string; severity: Severity }
export function normalizeHuntress(scope: Scope, connectionId: string, input: HuntressIncidentFixture, receivedAt: string): NormalizedEvent {
  if (!input.id || !input.agentId || !input.revision || !Number.isFinite(Date.parse(input.at)) || typeof input.signal !== 'string' ||
      !severities.includes(input.severity)) throw new AtlasError('BAD_EVENT', 'VALIDATION');
  const signal = input.signal.slice(0, 300);
  return { ...scope, source: 'huntress', connectionId, resourceType: 'incident', externalEventId: input.id, revision: input.revision,
    externalDevice: { resourceType: 'agent', externalId: input.agentId }, occurredAt: input.at, receivedAt, kind: 'SECURITY_INCIDENT',
    sourceSeverity: input.severity, summary: signal, facts: { signal } };
}
