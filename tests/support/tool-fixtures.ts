import type { Actor, ClientContextV1, Scope } from '../../packages/core/contracts.ts';
import { MemoryAudit, MemorySecurityAudit } from '../../packages/audit/memory.ts';
import { executeTool } from '../../packages/tools/gateway.ts';
import { contextReaders } from '../../packages/tools/registry.ts';
import { MemoryToolLedger } from '../../packages/tools/ledger.ts';

/** In-memory gateway sinks (task 1.9): client audit, workspace security audit and the execution ledger on that audit. */
export function memorySinks(audit = new MemoryAudit(), securityAudit = new MemorySecurityAudit()) {
  return { audit, securityAudit, ledger: new MemoryToolLedger(audit) };
}
/** One call through the gateway over an already built context; resolves to the tool's result. */
export async function runTool(actor: Actor, scope: Scope, tool: string, readContext: () => Promise<ClientContextV1>,
  sinks: ReturnType<typeof memorySinks>, parameters?: unknown): Promise<unknown> {
  return (await executeTool(actor, scope, { tool, parameters }, contextReaders(readContext), sinks)).result;
}
