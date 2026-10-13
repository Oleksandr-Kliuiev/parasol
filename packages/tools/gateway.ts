import { createHash, randomUUID } from 'node:crypto';
import type { Actor, Scope, AuditSink, SecurityAuditSink } from '../core/contracts.ts';
import { AtlasError, errorDetails, safeErrorCode } from '../core/contracts.ts';
import { decideToolCall } from '../policy/tool-policy.ts';
import { canonicalJson } from '../events/identity.ts';
import { validateParameters } from './parameters.ts';
import type { Parameters } from './parameters.ts';
import type { ToolDefinition, ToolReaders } from './registry.ts';
import { stage1Tools } from './registry.ts';
import type { ToolExecutionRecord, ToolLedger } from './ledger.ts';

/**
 * Sinks may be synchronous (in-memory reference) or asynchronous (PostgreSQL). The gateway awaits every write, so a denial
 * is recorded before the caller sees the error, and a failed write fails the call. The ledger writes each execution step
 * together with its audit row.
 */
export interface GatewaySinks {
  audit: { append(...args: Parameters_<AuditSink['append']>): void | Promise<void> };
  securityAudit: { append(...args: Parameters_<SecurityAuditSink['append']>): void | Promise<void> };
  ledger: ToolLedger;
}
type Parameters_<F> = F extends (...args: infer A) => unknown ? A : never;

/** One call of the versioned tool DTO (v1): the tool name, its parameters and the request correlation. */
export interface ToolCall { tool: string; parameters?: unknown; correlationId?: string }
export interface ToolOutcome { tool: string; toolVersion: string; correlationId: string; executionId: string; result: unknown }

/** SHA-256 of the canonical validated input — the basis a future approval binds to (docs/02). */
export function toolInputHash(scope: Scope, tool: Pick<ToolDefinition, 'name' | 'version'>, parameters: Parameters): string {
  return createHash('sha256').update(canonicalJson({ dto: '1', workspaceId: scope.workspaceId, clientId: scope.clientId, tool: tool.name,
    toolVersion: tool.version, parameters })).digest('hex');
}

/**
 * Read tool gateway (task 1.9). Order matters:
 *   1. policy — a scope denial goes to the workspace security audit, never to the target client's log, before any read;
 *      a tool denial (malformed name, unknown, write, no permission) to the client audit (tool.denied);
 *   2. runtime schema of the parameters — a violation is tool.rejected naming the parameter, never its value;
 *   3. execution — ToolExecution STARTED → SUCCEEDED | FAILED, each step with its audit row; the result's scope is verified.
 */
export async function executeTool(actor: Actor, scope: Scope, call: ToolCall, readers: ToolReaders, sinks: GatewaySinks,
  registry: readonly ToolDefinition[] = stage1Tools): Promise<ToolOutcome> {
  const correlationId = call.correlationId ?? randomUUID();
  // Bounded by code points, so a surrogate pair is never split; the audit sinks escape what PostgreSQL cannot store.
  const toolLabel = Array.from(String(call.tool)).slice(0, 100).join('');
  // The same registry as discovery: a tool is executed only through the policy over the registry that advertised it.
  const decision = decideToolCall(actor, scope, call.tool, registry);
  if (decision.effect === 'DENY_SCOPE') {
    await sinks.securityAudit.append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType: 'tool.scope_denied', outcome: 'DENIED',
      requestedClientId: scope.clientId, reasonCode: decision.reasonCode, correlationId, metadata: { tool: toolLabel } });
    throw new AtlasError(decision.reasonCode, 'SCOPE');
  }
  if (decision.effect === 'DENY_TOOL') {
    await sinks.audit.append(scope, actor.id, 'tool.denied', correlationId, { tool: toolLabel, safeErrorCode: decision.reasonCode });
    throw new AtlasError('TOOL_DENIED', 'SCOPE');
  }
  const { tool } = decision;
  let parameters: Parameters;
  try { parameters = validateParameters(tool.parameters, call.parameters); }
  catch (error) {
    await sinks.audit.append(scope, actor.id, 'tool.rejected', correlationId, { tool: tool.name, toolVersion: tool.version, safeErrorCode: safeErrorCode(error),
      parameter: errorDetails(error).parameter ?? 'parameters' });
    throw error;
  }
  const execution: ToolExecutionRecord = { id: randomUUID(), scope, actorId: actor.id, toolName: tool.name, toolVersion: tool.version, riskLevel: tool.risk,
    sideEffect: tool.sideEffect, inputHash: toolInputHash(scope, tool, parameters), correlationId };
  await sinks.ledger.started(execution);
  try {
    const result = await tool.run(readers, parameters, scope);
    await sinks.ledger.finished(execution, { status: 'SUCCEEDED' });
    return { tool: tool.name, toolVersion: tool.version, correlationId, executionId: execution.id, result };
  } catch (error) {
    await sinks.ledger.finished(execution, { status: 'FAILED', safeErrorCode: safeErrorCode(error) });
    throw error;
  }
}
