import { createHash, randomBytes } from 'node:crypto';

/**
 * Bearer API tokens (task 1.3). The secret is handed out once and persisted only as its SHA-256 hex digest
 * (ApiToken.tokenHash, CHECK-enforced). A random token of at least 20 characters needs no slow password hash.
 * Format: RFC 6750 b64token, bounded length, so malformed input is rejected before any database work.
 */
export const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]{20,256}={0,2}$/;

/** The token from an `Authorization: Bearer <token>` header, or null when absent or malformed. */
export function parseBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  const token = match?.[1];
  return token !== undefined && BEARER_TOKEN_PATTERN.test(token) ? token : null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): string {
  return `atl_${randomBytes(32).toString('base64url')}`;
}
