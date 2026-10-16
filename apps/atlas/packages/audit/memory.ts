import { randomUUID } from 'node:crypto';
import type { Scope, AuditRecord, AuditSink, SecurityAuditRecord, SecurityAuditSink } from '../core/contracts.ts';
import { auditText, sanitizeAuditMetadata } from './sanitize.ts';

/**
 * In-memory reference. The record is built from an explicit field list; `scope` may be any object that carries a scope.
 * Same text rules as the PostgreSQL sinks (sanitize.ts), so both store identical representations.
 */
export class MemoryAudit implements AuditSink {
  #records: AuditRecord[] = [];
  append(scope: Scope, actorId: string, eventType: string, correlationId: string, metadata: Record<string, string>): void {
    this.#records.push({ workspaceId: scope.workspaceId, clientId: scope.clientId, id: randomUUID(), actorId, eventType: auditText(eventType),
      correlationId: auditText(correlationId), metadata: sanitizeAuditMetadata(metadata), recordedAt: new Date().toISOString() });
  }
  list(scope: Scope): AuditRecord[] {
    return structuredClone(this.#records.filter(r => r.workspaceId === scope.workspaceId && r.clientId === scope.clientId));
  }
}
/** Workspace-level denial log. Readable by MSP administrators; never written into a client's audit. */
export class MemorySecurityAudit implements SecurityAuditSink {
  #records: SecurityAuditRecord[] = [];
  append(record: Omit<SecurityAuditRecord, 'id' | 'recordedAt'>): void {
    this.#records.push({ id: randomUUID(), workspaceId: record.workspaceId, actorId: record.actorId, eventType: auditText(record.eventType),
      outcome: 'DENIED', requestedClientId: record.requestedClientId === null ? null : auditText(String(record.requestedClientId)),
      reasonCode: auditText(record.reasonCode), correlationId: auditText(record.correlationId), metadata: sanitizeAuditMetadata(record.metadata),
      recordedAt: new Date().toISOString() });
  }
  list(workspaceId: string): SecurityAuditRecord[] {
    return structuredClone(this.#records.filter(r => r.workspaceId === workspaceId));
  }
}
