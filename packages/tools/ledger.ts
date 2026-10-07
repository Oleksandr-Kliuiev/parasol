import type { Scope } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';

/**
 * Ledger of executed tools (task 1.9). An execution is STARTED before the read and ends SUCCEEDED or FAILED with a safe
 * code; each step is written together with its client audit row (tool.started, tool.succeeded, tool.failed). Denied and
 * rejected calls are not executions: they are audit rows only (the gateway writes them).
 */
export interface ToolExecutionRecord {
  id: string; scope: Scope; actorId: string; toolName: string; toolVersion: string; riskLevel: number; sideEffect: string;
  /** SHA-256 of the canonical validated input (workspace, client, tool and version, parameters). */
  inputHash: string; correlationId: string;
}
export type ToolExecutionOutcome = { status: 'SUCCEEDED' } | { status: 'FAILED'; safeErrorCode: string };
export interface ToolLedger {
  started(execution: ToolExecutionRecord): void | Promise<void>;
  finished(execution: ToolExecutionRecord, outcome: ToolExecutionOutcome): void | Promise<void>;
}
export const auditOfExecution = (e: ToolExecutionRecord) => ({ tool: e.toolName, toolVersion: e.toolVersion, toolExecutionId: e.id });

interface AuditAppender { append(scope: Scope, actorId: string, eventType: string, correlationId: string, metadata: Record<string, string>): void }
export interface MemoryExecutionRow extends ToolExecutionRecord { status: 'STARTED' | 'SUCCEEDED' | 'FAILED'; safeErrorCode: string | null }

/** In-memory ledger of the reference and fixture API, appending to the same in-memory client audit. */
export class MemoryToolLedger implements ToolLedger {
  readonly #rows = new Map<string, MemoryExecutionRow>();
  readonly #audit: AuditAppender;
  constructor(audit: AuditAppender) { this.#audit = audit; }
  started(e: ToolExecutionRecord): void {
    if (this.#rows.has(e.id)) throw new AtlasError('TOOL_EXECUTION_EXISTS', 'PERMANENT');
    this.#rows.set(e.id, { ...e, status: 'STARTED', safeErrorCode: null });
    this.#audit.append(e.scope, e.actorId, 'tool.started', e.correlationId, auditOfExecution(e));
  }
  finished(e: ToolExecutionRecord, outcome: ToolExecutionOutcome): void {
    const row = this.#rows.get(e.id);
    if (!row || row.status !== 'STARTED') throw new AtlasError('TOOL_EXECUTION_NOT_STARTED', 'PERMANENT');
    row.status = outcome.status; row.safeErrorCode = outcome.status === 'FAILED' ? outcome.safeErrorCode : null;
    this.#audit.append(e.scope, e.actorId, outcome.status === 'SUCCEEDED' ? 'tool.succeeded' : 'tool.failed', e.correlationId,
      { ...auditOfExecution(e), ...(outcome.status === 'FAILED' ? { safeErrorCode: outcome.safeErrorCode } : {}) });
  }
  list(scope: Scope): MemoryExecutionRow[] {
    return [...this.#rows.values()].filter(r => r.scope.workspaceId === scope.workspaceId && r.scope.clientId === scope.clientId).map(r => ({ ...r }));
  }
}
