import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope } from '../graph/scoped-db.ts';
import { getClientContext, getObservationPage } from '../graph/prisma-context.ts';
import type { ToolExecutionOutcome, ToolExecutionRecord, ToolLedger } from './ledger.ts';
import { auditOfExecution } from './ledger.ts';
import type { ToolReaders } from './registry.ts';

/**
 * ToolExecution ledger in PostgreSQL (task 1.9), bound to the authenticated actor of one request: each step writes the
 * execution row and its client audit row in ONE scoped transaction through the runtime role. The database keeps the
 * ledger honest — read tools only, and a STARTED row only records its outcome (migration 202610080000).
 */
export class PrismaToolLedger implements ToolLedger {
  readonly #db: PrismaClient; readonly #actor: Actor;
  constructor(db: PrismaClient, actor: Actor) { this.#db = db; this.#actor = actor; }
  async started(e: ToolExecutionRecord): Promise<void> {
    if (e.actorId !== this.#actor.id) throw new AtlasError('AUDIT_ACTOR_MISMATCH', 'PERMANENT');
    await withScope(this.#db, this.#actor, [e.scope.clientId], async tx => {
      await tx.toolExecution.create({ data: { workspaceId: e.scope.workspaceId, clientId: e.scope.clientId, id: e.id, actorId: e.actorId, toolName: e.toolName,
        toolVersion: e.toolVersion, riskLevel: e.riskLevel, sideEffect: e.sideEffect, inputHash: e.inputHash, status: 'STARTED', correlationId: e.correlationId },
        select: { id: true } });
      await tx.auditEvent.create({ data: clientAuditData(e.scope, e.actorId, 'tool.started', e.correlationId, auditOfExecution(e)), select: { id: true } });
    });
  }
  async finished(e: ToolExecutionRecord, outcome: ToolExecutionOutcome): Promise<void> {
    const failed = outcome.status === 'FAILED' ? outcome.safeErrorCode : null;
    await withScope(this.#db, this.#actor, [e.scope.clientId], async tx => {
      const updated = await tx.toolExecution.updateMany({ where: { workspaceId: e.scope.workspaceId, clientId: e.scope.clientId, id: e.id, status: 'STARTED' },
        data: { status: outcome.status, safeErrorCode: failed, finishedAt: new Date() } });
      if (updated.count !== 1) throw new AtlasError('TOOL_EXECUTION_NOT_STARTED', 'PERMANENT');
      await tx.auditEvent.create({ data: clientAuditData(e.scope, e.actorId, failed === null ? 'tool.succeeded' : 'tool.failed', e.correlationId,
        { ...auditOfExecution(e), ...(failed === null ? {} : { safeErrorCode: failed }) }), select: { id: true } });
    });
  }
}

/** What the tools read in DB mode: the scoped context and observation pages through the runtime role. */
export function databaseReaders(db: PrismaClient, actor: Actor, scope: Scope): ToolReaders {
  return { context: () => getClientContext(db, actor, scope), observations: query => getObservationPage(db, actor, scope, query) };
}
