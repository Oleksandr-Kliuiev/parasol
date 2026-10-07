import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope, AuditRecord, SecurityAuditRecord } from '../core/contracts.ts';
import { AtlasError, assertPermission, assertWorkspacePermission } from '../core/contracts.ts';
import { withScope, withWorkspaceScope } from '../graph/scoped-db.ts';
import { auditText, sanitizeAuditMetadata, pickAuditMetadata } from './sanitize.ts';

/**
 * PostgreSQL audit for the API (task 1.2/1.3). Same rules as the in-memory reference: rows are built from an explicit
 * field list, metadata passes the allowlist, untrusted strings are stored as escaped bounded text (sanitize.ts, so NUL or a
 * lone surrogate can never fail the write and erase a denial), denials go to the workspace SecurityAuditEvent and never
 * into a client log.
 * Every append runs as the request's actor through the confined runtime role, so RLS limits the client audit to the
 * actor's member clients and the security audit to the actor's workspace. Both tables are append-only (triggers, grants).
 * The durable event pipeline (task 1.6) writes its audit rows inside its own final transaction instead.
 */
export const AUDIT_PAGE_LIMIT = 100;
const pageSize = (limit: number): number => Math.min(AUDIT_PAGE_LIMIT, Math.max(1, Math.trunc(limit) || AUDIT_PAGE_LIMIT));
const stringFields = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

/** Client audit sink bound to the authenticated actor of one request. */
export class PrismaAudit {
  readonly #db: PrismaClient; readonly #actor: Actor;
  constructor(db: PrismaClient, actor: Actor) { this.#db = db; this.#actor = actor; }
  async append(scope: Scope, actorId: string, eventType: string, correlationId: string, metadata: Record<string, string>): Promise<void> {
    if (actorId !== this.#actor.id) throw new AtlasError('AUDIT_ACTOR_MISMATCH', 'PERMANENT');
    await withScope(this.#db, this.#actor, [scope.clientId], tx => tx.auditEvent.create({
      data: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: randomUUID(), actorId, eventType: auditText(eventType),
        correlationId: auditText(correlationId), metadata: sanitizeAuditMetadata(metadata) },
      select: { id: true } }));
  }
}

/** Workspace security audit sink (denials) bound to the authenticated actor of one request. */
export class PrismaSecurityAudit {
  readonly #db: PrismaClient; readonly #actor: Actor;
  constructor(db: PrismaClient, actor: Actor) { this.#db = db; this.#actor = actor; }
  async append(record: Omit<SecurityAuditRecord, 'id' | 'recordedAt'>): Promise<void> {
    if (record.actorId !== this.#actor.id || record.workspaceId !== this.#actor.workspaceId) throw new AtlasError('AUDIT_ACTOR_MISMATCH', 'PERMANENT');
    await withWorkspaceScope(this.#db, this.#actor, tx => tx.securityAuditEvent.create({
      data: { workspaceId: record.workspaceId, id: randomUUID(), actorId: record.actorId, eventType: auditText(record.eventType), outcome: 'DENIED',
        requestedClientId: record.requestedClientId === null ? null : auditText(String(record.requestedClientId)),
        reasonCode: auditText(record.reasonCode), correlationId: auditText(record.correlationId), metadata: sanitizeAuditMetadata(record.metadata) },
      select: { id: true } }));
  }
}

/** Newest first, bounded. Reading a client's audit needs context:read on that client. */
export async function listClientAudit(db: PrismaClient, actor: Actor, scope: Scope, limit: number = AUDIT_PAGE_LIMIT): Promise<AuditRecord[]> {
  assertPermission(actor, scope, 'context:read');
  return withScope(db, actor, [scope.clientId], async tx => {
    const rows = await tx.auditEvent.findMany({ where: { workspaceId: scope.workspaceId, clientId: scope.clientId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }], take: pageSize(limit) });
    return rows.map(r => ({ workspaceId: r.workspaceId, clientId: r.clientId, id: r.id, actorId: r.actorId, eventType: r.eventType,
      correlationId: r.correlationId, recordedAt: r.recordedAt.toISOString(), metadata: pickAuditMetadata(stringFields(r.metadata)) }));
  });
}

/** Newest first, bounded. Workspace permission security_audit:read (MSP administrators). */
export async function listSecurityAudit(db: PrismaClient, actor: Actor, limit: number = AUDIT_PAGE_LIMIT): Promise<SecurityAuditRecord[]> {
  assertWorkspacePermission(actor, actor.workspaceId, 'security_audit:read');
  return withWorkspaceScope(db, actor, async tx => {
    const rows = await tx.securityAuditEvent.findMany({ where: { workspaceId: actor.workspaceId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }], take: pageSize(limit) });
    return rows.map(r => ({ id: r.id, workspaceId: r.workspaceId, actorId: r.actorId, eventType: r.eventType, outcome: 'DENIED' as const,
      requestedClientId: r.requestedClientId, reasonCode: r.reasonCode, correlationId: r.correlationId,
      recordedAt: r.recordedAt.toISOString(), metadata: pickAuditMetadata(stringFields(r.metadata)) }));
  });
}
