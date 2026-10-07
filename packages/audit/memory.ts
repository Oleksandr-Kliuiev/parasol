import { randomUUID } from 'node:crypto';
import type { Scope, AuditRecord, AuditSink, SecurityAuditRecord, SecurityAuditSink } from '../core/contracts.ts';

/** Only these metadata keys may reach the client audit. Values are bounded strings; payload fields are never accepted. */
export const auditMetadataAllowlist: readonly string[] = [
  'observationId', 'eventKey', 'conflictOfEventKey', 'route', 'priority', 'provider', 'reasonCodes', 'tool', 'toolVersion', 'inboxStatus', 'safeErrorCode', 'attempts', 'decisionRunId'
];
export function sanitizeAuditMetadata(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of auditMetadataAllowlist) {
    const value = metadata[key];
    if (typeof value === 'string') out[key] = value.slice(0, 200);
  }
  return out;
}
/** In-memory reference. The record is built from an explicit field list; `scope` may be any object that carries a scope. */
export class MemoryAudit implements AuditSink {
  #records: AuditRecord[] = [];
  append(scope: Scope, actorId: string, eventType: string, correlationId: string, metadata: Record<string, string>): void {
    this.#records.push({ workspaceId: scope.workspaceId, clientId: scope.clientId, id: randomUUID(), actorId, eventType,
      correlationId, metadata: sanitizeAuditMetadata(metadata), recordedAt: new Date().toISOString() });
  }
  list(scope: Scope): AuditRecord[] {
    return structuredClone(this.#records.filter(r => r.workspaceId === scope.workspaceId && r.clientId === scope.clientId));
  }
}
/** Workspace-level denial log. Readable by MSP administrators; never written into a client's audit. */
export class MemorySecurityAudit implements SecurityAuditSink {
  #records: SecurityAuditRecord[] = [];
  append(record: Omit<SecurityAuditRecord, 'id' | 'recordedAt'>): void {
    this.#records.push({ id: randomUUID(), workspaceId: record.workspaceId, actorId: record.actorId, eventType: record.eventType,
      outcome: 'DENIED', requestedClientId: record.requestedClientId === null ? null : String(record.requestedClientId).slice(0, 200),
      reasonCode: record.reasonCode, correlationId: record.correlationId, metadata: sanitizeAuditMetadata(record.metadata),
      recordedAt: new Date().toISOString() });
  }
  list(workspaceId: string): SecurityAuditRecord[] {
    return structuredClone(this.#records.filter(r => r.workspaceId === workspaceId));
  }
}
