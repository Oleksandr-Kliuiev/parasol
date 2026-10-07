import type { Scope, NormalizedEvent, Severity } from '../../packages/core/contracts.ts';
import { AtlasError, severities } from '../../packages/core/contracts.ts';
// Atlas-owned synthetic DTO. NOT a claim about Atera webhook field names. Task 1.5 replaces it with the validated vendor DTO.
// `severity` stands for the severity the source reports; a disk-usage threshold is an Atlas policy, not a source fact,
// and therefore lives in versioned configuration (see docs/04), never in the normalizer.
export interface AteraAlertFixture { id: string; revision: string; agentId: string; at: string; diskPercent: number; severity: Severity }
export function normalizeAtera(scope: Scope, connectionId: string, input: AteraAlertFixture, receivedAt: string): NormalizedEvent {
  if (!Number.isFinite(input.diskPercent) || input.diskPercent < 0 || input.diskPercent > 100) throw new AtlasError('BAD_DISK_PERCENT', 'VALIDATION');
  if (!input.id || !input.agentId || !input.revision || !Number.isFinite(Date.parse(input.at)) || !severities.includes(input.severity)) {
    throw new AtlasError('BAD_EVENT', 'VALIDATION');
  }
  return { ...scope, source: 'atera', connectionId, resourceType: 'alert', externalEventId: input.id, revision: input.revision,
    externalDevice: { resourceType: 'agent', externalId: input.agentId }, occurredAt: input.at, receivedAt, kind: 'DISK_CAPACITY',
    sourceSeverity: input.severity, summary: `Disk capacity used: ${input.diskPercent}%`, facts: { diskPercent: input.diskPercent } };
}
