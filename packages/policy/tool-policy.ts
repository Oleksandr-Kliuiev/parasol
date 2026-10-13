import type { Actor, Scope } from '../core/contracts.ts';
import { assertScope, hasClientPermissions, safeErrorCode } from '../core/contracts.ts';
import type { ToolDefinition } from '../tools/registry.ts';
import { stage1Tools, TOOL_NAME_PATTERN } from '../tools/registry.ts';

/**
 * Deterministic tool policy (task 1.9, docs/02 PolicyModule): the same actor, scope and tool name always give the same
 * decision, taken from authoritative data only — the actor's verified memberships and the registry. Nothing a caller or a
 * model sends (risk, side effect, permission, actor) takes part, and nothing is asked of an AI. Order:
 *   1. scope — a denial belongs to the workspace security audit and comes before any read;
 *   2. tool name syntax, 3. registry entry, 4. read-only (Stage 1 executes risk 0 without side effect, ADR-003),
 *   5. every permission of the tool on this client (all-of, one membership) — denials 2–5 belong to the client audit.
 */
export type ToolDenial = 'INVALID_TOOL_NAME' | 'UNKNOWN_TOOL' | 'WRITE_TOOL_NOT_ALLOWED' | 'PERMISSION_DENIED';
export type ToolPolicyDecision =
  | { effect: 'ALLOW'; tool: ToolDefinition }
  | { effect: 'DENY_SCOPE'; reasonCode: string }
  | { effect: 'DENY_TOOL'; reasonCode: ToolDenial };

export function decideToolCall(actor: Actor, scope: Scope, name: string, registry: readonly ToolDefinition[] = stage1Tools): ToolPolicyDecision {
  try { assertScope(actor, scope); } catch (error) { return { effect: 'DENY_SCOPE', reasonCode: safeErrorCode(error) }; }
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) return { effect: 'DENY_TOOL', reasonCode: 'INVALID_TOOL_NAME' };
  const tool = registry.find(t => t.name === name);
  if (!tool) return { effect: 'DENY_TOOL', reasonCode: 'UNKNOWN_TOOL' };
  if (tool.risk !== 0 || tool.sideEffect !== 'NONE') return { effect: 'DENY_TOOL', reasonCode: 'WRITE_TOOL_NOT_ALLOWED' };
  if (!hasClientPermissions(actor, scope.clientId, tool.permissions)) return { effect: 'DENY_TOOL', reasonCode: 'PERMISSION_DENIED' };
  return { effect: 'ALLOW', tool };
}

/**
 * The registry entries an actor may call on at least one of its clients (GET /tools): one membership must hold ALL of a
 * tool's permissions — context:read on client A and m365:read on client B never add up to a tool needing both.
 */
export function toolsAvailableTo(actor: Actor, registry: readonly ToolDefinition[] = stage1Tools): ToolDefinition[] {
  return registry.filter(tool => tool.risk === 0 && tool.sideEffect === 'NONE'
    && actor.memberships.some(m => hasClientPermissions(actor, m.clientId, tool.permissions)));
}
