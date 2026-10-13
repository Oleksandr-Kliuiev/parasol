import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AtlasError } from '../core/contracts.ts';
import { canonicalJson } from '../events/identity.ts';
import { CURSOR_MAX_LENGTH, CURSOR_PATTERN, cursorInvalid } from './parameters.ts';
import { floorMs, isTimeKey, keyOfDate } from './time.ts';
import type { DbClock, TimeKey } from './time.ts';

/**
 * Authenticated keyset cursor of the Stage 2 paged reads (02 §5, brief RC3): base64url(JSON claims) '.' base64url(HMAC-SHA256).
 * Claims {v,b,f,p,e}: version, binding digest (actor/workspace/client, all-of permission evaluation, operation, observation,
 * connection, interval, limit, filters), snapshot fingerprint, last position (a local evidence ID, or the SHA-256 hex of a
 * directory source-object key) and expiry in epoch ms. No secret, DTO or vendor ID is in the claims. Nothing is trusted before
 * the MAC verifies (timing-safe); any malformed, tampered or oversized cursor is CORRELATION_CURSOR_INVALID. The key is ONE
 * configured secret shared by every API process: ATLAS_CORRELATION_CURSOR_SECRET_REF=env://NAME, at least 32 UTF-8 bytes.
 * There is no random per-process default; missing or invalid configuration fails closed before any data query.
 */
export const CURSOR_SECRET_REF_VARIABLE = 'ATLAS_CORRELATION_CURSOR_SECRET_REF';
export const CURSOR_KEY_MIN_BYTES = 32;
export const CURSOR_VERSION = 1;
/** Hard upper bound of a cursor's lifetime even when no earlier freshness/retention transition exists. */
export const CURSOR_MAX_LIFETIME_MS = 15 * 60_000;
const POSITION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

const keys = new WeakSet<object>();
/** Opaque key handle; only cursorKey* functions create one. */
export interface CursorKey { readonly mac: (data: string) => Buffer }
export type CursorKeyProvider = () => CursorKey;

export const cursorConfigInvalid = () => new AtlasError('CORRELATION_CURSOR_CONFIG_INVALID', 'PERMANENT');
function keyOf(secret: string): CursorKey {
  if (Buffer.byteLength(secret, 'utf8') < CURSOR_KEY_MIN_BYTES) throw cursorConfigInvalid();
  const material = Buffer.from(secret, 'utf8');
  const key: CursorKey = Object.freeze({ mac: (data: string) => createHmac('sha256', material).update(data, 'utf8').digest() });
  keys.add(key);
  return key;
}
/** The shared configured key, resolved from the environment at service entry (fails closed). */
export function cursorKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): CursorKey {
  const name = /^env:\/\/([A-Z][A-Z0-9_]{0,99})$/.exec(env[CURSOR_SECRET_REF_VARIABLE] ?? '')?.[1];
  const value = name ? env[name] : undefined;
  if (!value) throw cursorConfigInvalid();
  return keyOf(value);
}
/** Explicitly injected key (tests, fixture readers). Same minimum length; never a default. */
export const injectedCursorKey = (secret: string): CursorKey => keyOf(secret);
export const envCursorKey = (env: Readonly<Record<string, string | undefined>> = process.env): CursorKeyProvider => () => cursorKeyFromEnv(env);
/** Validated at the entry of every paged read service, before any data query and also for an untruncated first page. */
export function requireCursorKey(provider: CursorKeyProvider | undefined): CursorKey {
  const key = provider?.();
  if (!key || !keys.has(key)) throw cursorConfigInvalid();
  return key;
}

export interface CursorClaims { v: number; b: string; f: string; p: string; e: number }
/** base64url SHA-256 of the canonical JSON of a value (binding and fingerprint digests, 43 characters). */
export const digestOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('base64url');

const macOf = (key: CursorKey, body: string) => key.mac(`atlas.cursor.v${CURSOR_VERSION}\n${body}`);
export function issueCursor(key: CursorKey, claims: Omit<CursorClaims, 'v'>): string {
  if (!DIGEST.test(claims.b) || !DIGEST.test(claims.f) || !POSITION.test(claims.p) || !Number.isSafeInteger(claims.e)) throw cursorInvalid();
  const body = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, b: claims.b, f: claims.f, p: claims.p, e: claims.e }), 'utf8').toString('base64url');
  const cursor = `${body}.${macOf(key, body).toString('base64url')}`;
  // Issuance guarantees the shared bound; the claims above cannot exceed it (asserted by the tests at maximal sizes).
  if (cursor.length > CURSOR_MAX_LENGTH || !CURSOR_PATTERN.test(cursor)) throw new AtlasError('CORRELATION_CURSOR_TOO_LONG', 'PERMANENT');
  return cursor;
}
/** MAC first (timing-safe), then strict bounded decoding. Every failure is the same CORRELATION_CURSOR_INVALID. */
export function verifyCursor(key: CursorKey, cursor: string): CursorClaims {
  if (typeof cursor !== 'string' || cursor.length > CURSOR_MAX_LENGTH || !CURSOR_PATTERN.test(cursor)) throw cursorInvalid();
  const [body, mac] = cursor.split('.') as [string, string];
  const expected = macOf(key, body);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || given.toString('base64url') !== mac || !timingSafeEqual(given, expected)) throw cursorInvalid();
  let claims: unknown;
  try {
    const raw = Buffer.from(body, 'base64url');
    if (raw.toString('base64url') !== body) throw cursorInvalid();
    claims = JSON.parse(raw.toString('utf8'));
  } catch { throw cursorInvalid(); }
  const c = claims as Partial<CursorClaims> | null;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).sort().join(',') !== 'b,e,f,p,v' || c.v !== CURSOR_VERSION
    || typeof c.b !== 'string' || !DIGEST.test(c.b) || typeof c.f !== 'string' || !DIGEST.test(c.f)
    || typeof c.p !== 'string' || !POSITION.test(c.p) || typeof c.e !== 'number' || !Number.isSafeInteger(c.e) || c.e <= 0) throw cursorInvalid();
  return c as CursorClaims;
}
export const cursorExpired = () => new AtlasError('CORRELATION_CURSOR_EXPIRED', 'CONFLICT');
export const correlationChanged = () => new AtlasError('CORRELATION_CHANGED', 'CONFLICT');

/**
 * Checks a verified cursor against the CURRENT page: expiry against the database clock first, then the binding (input),
 * then the snapshot fingerprint. Called only after the current authority/snapshot has been reloaded.
 */
export function checkCursor(claims: CursorClaims, nowMs: number, binding: string, fingerprint: string): void {
  if (nowMs >= claims.e) throw cursorExpired();
  if (claims.b !== binding || claims.f !== fingerprint) throw correlationChanged();
}
/**
 * One state transition of a page's eligible snapshot, as a seven-digit key. `inclusive`: the new state holds AT the instant
 * (expiresAt <= now, age >= freshness window); `strict`: only AFTER it (input eligibility `from >= now - 7d`, retention clip).
 */
export interface Transition { at: TimeKey; strict?: boolean }
export const transitionAt = (date: Date): Transition => ({ at: keyOfDate(date) });
/**
 * Expiry of a newly issued cursor (epoch ms): the earliest FUTURE transition, never later than 15 minutes. Future-ness is
 * decided on the full seven-digit keys against the snapshot clock key — a transition later within the clock's current
 * millisecond is still future — and only then floored to milliseconds, so the cursor may expire early (even at issue) but
 * never outlives a known transition. Transitions that already happened do not shorten it: already stale data may page.
 */
export function cursorExpiry(clock: DbClock, transitions: readonly Transition[]): number {
  let e = clock.now.getTime() + CURSOR_MAX_LIFETIME_MS;
  for (const t of transitions) {
    if (!isTimeKey(t.at)) throw new AtlasError('CORRELATION_TRANSITION_INVALID', 'PERMANENT');
    const future = t.strict ? t.at >= clock.key : t.at > clock.key;
    if (future) e = Math.min(e, floorMs(t.at));
  }
  return e;
}
