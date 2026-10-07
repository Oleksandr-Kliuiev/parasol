/**
 * Audit text rules shared by the in-memory reference (memory.ts) and the PostgreSQL sinks (prisma.ts).
 *
 * Client audit metadata is an allowlist, never a spread of a payload. Every untrusted string that reaches an audit row is
 * stored as a bounded, unambiguous text representation (review R1): PostgreSQL text and jsonb reject NUL, and a lone
 * UTF-16 surrogate cannot be encoded at all, so such input would otherwise fail the audit write and erase the denial.
 * Backslash, C0 controls, DEL and lone surrogates are written as escapes, so the stored value still tells `ghost<NUL>client`
 * apart from the literal text `ghost\u0000client` (stored as `ghost\\u0000client`). Values are escaped once, when written.
 */
export const auditMetadataAllowlist: readonly string[] = [
  'observationId', 'eventKey', 'conflictOfEventKey', 'route', 'priority', 'provider', 'reasonCodes', 'tool', 'toolVersion', 'inboxStatus', 'safeErrorCode', 'attempts', 'decisionRunId',
  // Mapping workflow (task 1.4): Atlas row identifiers only. Vendor IDs (externalId, externalTenantId) never enter the audit.
  'linkId', 'conflictsWithLinkId', 'linkStatus', 'method', 'externalEntityId', 'connectionId', 'system',
  // Observation lifecycle (task 1.8): statuses and the Atlas ID of the superseding observation
  'previousStatus', 'observationStatus', 'supersededById',
  // Tool gateway (task 1.9): the execution row an audit entry belongs to, and the declared parameter a rejection names
  'toolExecutionId', 'parameter',
  // Operator CLI (task 1.10): the command a refused call named (one of a fixed set)
  'command'
];
export const AUDIT_TEXT_LIMIT = 200;

/** Escaped, bounded representation. The bound never splits an escape sequence or a surrogate pair. */
export function auditText(value: string, max: number = AUDIT_TEXT_LIMIT): string {
  let out = '';
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0) ?? 0;
    const piece = ch === '\\' ? '\\\\'
      : cp < 0x20 || cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff) ? `\\u${cp.toString(16).padStart(4, '0')}`
      : ch;
    if (out.length + piece.length > max) break;
    out += piece;
  }
  return out;
}

/** Write path: allowlisted keys with string values, each stored as auditText. */
export function sanitizeAuditMetadata(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of auditMetadataAllowlist) {
    const value = metadata[key];
    if (typeof value === 'string') out[key] = auditText(value);
  }
  return out;
}

/** Read path: stored values were escaped and bounded when written, so only the allowlist applies (no second escaping). */
export function pickAuditMetadata(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of auditMetadataAllowlist) {
    const value = metadata[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
