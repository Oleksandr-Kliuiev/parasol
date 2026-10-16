import { createHash, timingSafeEqual } from 'node:crypto';
import { hashToken, parseBearerToken } from '../auth/token.ts';

/**
 * Ask-private opaque credential (docs/stage5/ask/03_SECURITY_AND_STATE.md "Current bearer and client authority"): request
 * memory keeps only a SHA-256 digest, in a module-private WeakMap — no property, no bearer text. DB mode reuses the accepted
 * bearer syntax and token digest (packages/auth/token.ts); fixture mode keeps the digest of the whole Authorization header,
 * compared with the accepted equality rule `Bearer <ATLAS_DEMO_TOKEN>` (apps/api/src/atlas.module.ts FixtureAuthGuard).
 * The shared ApiTokenGuard/authenticateToken path is not used and not changed.
 */
export interface AskCredential { readonly kind: 'AskCredential' }
const digests = new WeakMap<AskCredential, string>();

function credential(digest: string): AskCredential {
  const value: AskCredential = Object.freeze({ kind: 'AskCredential' as const });
  digests.set(value, digest);
  return value;
}
/** The stored digest; a credential not issued here has none and authenticates nobody. */
export const credentialDigest = (value: AskCredential): string | null => digests.get(value) ?? null;

/** DB: accepted `Authorization: Bearer <b64token>` syntax → token digest; malformed or absent → null (401, no DB work). */
export function bearerCredential(authorization: unknown): AskCredential | null {
  const token = parseBearerToken(authorization);
  return token === null ? null : credential(hashToken(token));
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
/** Fixture: digest of the exact header text (absent → ''), as the accepted fixture guard compares the whole header. */
export const fixtureCredential = (authorization: unknown): AskCredential => credential(sha256(typeof authorization === 'string' ? authorization : ''));

/** Accepted fixture equality: ATLAS_DEMO_TOKEN of ≥20 characters and a constant-time digest comparison. */
export function fixtureTokenMatches(value: AskCredential, demoToken: string | undefined): boolean {
  const digest = credentialDigest(value);
  if (digest === null || !demoToken || demoToken.length < 20) return false;
  return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(sha256(`Bearer ${demoToken}`), 'hex'));
}
