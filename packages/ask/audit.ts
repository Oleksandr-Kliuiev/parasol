import { ASK_AUDIT } from './contracts.ts';
import type { AskErrorCode, AskStatus } from './contracts.ts';

/**
 * Final client audit of one admitted Ask (03 "Current bearer and client authority"): exactly one `ask.completed` or
 * `ask.failed` row with existing allowlisted keys only — provider, ruleVersion, itemCount (bank size), outcome (fixed status)
 * and safeErrorCode (fixed failure only). Never the question, plan, answer, source IDs, names, raw text, hash or length.
 * The workspace denial `ask.scope_denied` carries empty metadata.
 */
export type AskAuditOutcome =
  | { readonly event: 'completed'; readonly status: AskStatus; readonly itemCount: number }
  | { readonly event: 'failed'; readonly code: AskErrorCode; readonly itemCount: number };

export function askAuditRecord(outcome: AskAuditOutcome): { eventType: string; metadata: Record<string, string> } {
  const metadata: Record<string, string> = { provider: ASK_AUDIT.provider, ruleVersion: ASK_AUDIT.ruleVersion, itemCount: String(outcome.itemCount) };
  if (outcome.event === 'completed') return { eventType: ASK_AUDIT.completed, metadata: { ...metadata, outcome: outcome.status } };
  return { eventType: ASK_AUDIT.failed, metadata: { ...metadata, outcome: 'FAILED', safeErrorCode: outcome.code } };
}
