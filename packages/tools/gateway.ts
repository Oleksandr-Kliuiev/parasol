import { randomUUID } from 'node:crypto';
import type { Actor, Scope, ClientContextV1, AuditSink, SecurityAuditSink } from '../core/contracts.ts';
import { AtlasError, assertScope, hasClientPermission, findResource, safeErrorCode } from '../core/contracts.ts';

export interface ToolDefinition {
  name: string; version: string; risk: 0 | 1 | 2 | 3 | 4; sideEffect: 'NONE' | 'CREATE' | 'UPDATE' | 'SECURITY' | 'DESTRUCTIVE';
  permission: string;
}
/** Authoritative registry data. Risk and side effect come from here, never from the caller or the model. */
export const stage1Tools: readonly ToolDefinition[] = Object.freeze([
  { name: 'atlas.client.get_context', version: '1', risk: 0, sideEffect: 'NONE', permission: 'context:read' },
  { name: 'atera.alert.list', version: '1', risk: 0, sideEffect: 'NONE', permission: 'context:read' },
  { name: 'atera.ticket.list', version: '1', risk: 0, sideEffect: 'NONE', permission: 'context:read' },
  { name: 'huntress.incident.list', version: '1', risk: 0, sideEffect: 'NONE', permission: 'context:read' }
].map(t => Object.freeze(t) as ToolDefinition));
/** Registry name syntax: lowercase dotted segments. Anything else is denied as INVALID_TOOL_NAME, never looked up. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31}){1,3}$/;

/**
 * Sinks may be synchronous (in-memory reference) or asynchronous (PostgreSQL, packages/audit/prisma.ts). The gateway
 * awaits every append, so a denial is recorded before the caller sees the error, and a failed append fails the call.
 */
export interface GatewaySinks {
  audit: { append(...args: Parameters<AuditSink['append']>): void | Promise<void> };
  securityAudit: { append(...args: Parameters<SecurityAuditSink['append']>): void | Promise<void> };
}

/**
 * Read-only gateway. Order matters: scope first (denial goes to the workspace security audit, never to the target client's
 * log), then registry + permission (denial goes to the client audit), then execution with scope verification of the result.
 */
export async function executeReadTool(actor: Actor, scope: Scope, name: string,
  readContext: () => Promise<ClientContextV1>, sinks: GatewaySinks): Promise<unknown> {
  const correlationId = randomUUID();
  // Bounded by code points, so a surrogate pair is never split; the audit sinks escape what PostgreSQL cannot store.
  const toolLabel = Array.from(String(name)).slice(0, 100).join('');
  try { assertScope(actor, scope); }
  catch (error) {
    await sinks.securityAudit.append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType: 'tool.scope_denied', outcome: 'DENIED',
      requestedClientId: scope.clientId, reasonCode: safeErrorCode(error), correlationId, metadata: { tool: toolLabel } });
    throw error;
  }
  const wellFormed = TOOL_NAME_PATTERN.test(name);
  const tool = wellFormed ? stage1Tools.find(t => t.name === name) : undefined;
  if (!tool || tool.risk !== 0 || tool.sideEffect !== 'NONE' || !hasClientPermission(actor, scope.clientId, tool.permission)) {
    const reason = !wellFormed ? 'INVALID_TOOL_NAME' : tool ? 'TOOL_NOT_ALLOWED' : 'UNKNOWN_TOOL';
    await sinks.audit.append(scope, actor.id, 'tool.denied', correlationId, { tool: toolLabel, safeErrorCode: reason });
    throw new AtlasError('TOOL_DENIED', 'SCOPE');
  }
  await sinks.audit.append(scope, actor.id, 'tool.started', correlationId, { tool: tool.name, toolVersion: tool.version });
  try {
    const ctx = await readContext();
    if (ctx.contractVersion !== 'ClientContextV1') throw new AtlasError('CONTEXT_CONTRACT_MISMATCH', 'PERMANENT');
    if (ctx.workspaceId !== scope.workspaceId || ctx.clientId !== scope.clientId) throw new AtlasError('CONTEXT_SCOPE_MISMATCH', 'PERMANENT');
    const result = tool.name === 'atlas.client.get_context' ? ctx
      : tool.name === 'atera.alert.list' ? findResource(ctx, 'atera', 'alert')
      : tool.name === 'atera.ticket.list' ? findResource(ctx, 'atera', 'ticket')
      : findResource(ctx, 'huntress', 'incident');
    await sinks.audit.append(scope, actor.id, 'tool.succeeded', correlationId, { tool: tool.name, toolVersion: tool.version });
    return result;
  } catch (error) {
    await sinks.audit.append(scope, actor.id, 'tool.failed', correlationId, { tool: tool.name, toolVersion: tool.version, safeErrorCode: safeErrorCode(error) });
    throw error;
  }
}
