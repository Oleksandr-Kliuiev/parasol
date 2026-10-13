import { ASK_LIMITS, UUID_V4, askFailure } from './contracts.ts';

// Ask request input (docs/stage5/ask/02_CONTRACTS.md "Fixed HTTP surface"): route classification, raw header checks and the
// exact AskRequestV1 semantics. Pure functions, no I/O; failures are the fixed ASK_REQUEST_INVALID / ASK_TOO_LARGE codes.

export type AskShape = 'capability' | 'question';
/**
 * What the private boundary does with a request: `intercept` the exact enabled shape (GET capability, POST question),
 * `reject` HEAD/OPTIONS on an Ask path before Express's implicit HEAD→GET/OPTIONS handling, or nothing (null).
 */
export type AskTarget =
  | { action: 'intercept'; shape: AskShape; hasQuery: boolean; clientId: string | null; routePath: string | null }
  | { action: 'reject' };

/** Path of an origin-form or absolute-form request target, as Express routes it (query and fragment cut off). */
function targetPath(url: string): { path: string; suffix: boolean } | null {
  let target = url;
  if (!target.startsWith('/')) {
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(target);
    if (!authority) return null;
    target = target.slice(authority[0].length);
    if (!target.startsWith('/')) target = `/${target}`;
  }
  const cut = target.search(/[?#]/);
  return cut === -1 ? { path: target, suffix: false } : { path: target.slice(0, cut), suffix: true };
}
const decoded = (segment: string): string | null => { try { return decodeURIComponent(segment); } catch { return null; } };
/** Case-insensitive literal, also after percent-decoding: a superset of the raw case-insensitive Express match. */
const literal = (segment: string, word: string): boolean => decoded(segment)?.toLowerCase() === word;

/**
 * Classification independent of scope-ID validity: `/ask/capabilities` and `/clients/<one non-empty segment>/ask`, any
 * letter case, percent-encoded letters, any number of trailing slashes. It is a deliberate superset of what Express routes
 * to an Ask controller (case-insensitive, optional trailing slash, absolute-form targets), so no spelling that reaches a
 * controller can fall through to the generic JSON/urlencoded parsers.
 */
export function askTarget(method: string | undefined, url: string | undefined): AskTarget | null {
  const parsed = targetPath(url ?? '');
  if (!parsed) return null;
  const parts = parsed.path.split('/');
  let end = parts.length;
  while (end > 1 && parts[end - 1] === '') end -= 1;
  const segments = parts.slice(1, end);
  let shape: AskShape | null = null;
  let clientId: string | null = null;
  let routePath: string | null = null;
  if (segments.length === 2 && literal(segments[0]!, 'ask') && literal(segments[1]!, 'capabilities')) shape = 'capability';
  else if (segments.length === 3 && literal(segments[0]!, 'clients') && segments[1] !== '' && literal(segments[2]!, 'ask')) {
    shape = 'question';
    // The Ask-owned client ID: Express's own decoding, or — for an undecodable percent sequence — the raw segment text,
    // which contains '%' and therefore can never satisfy SCOPE_ID_PATTERN (it is always an authenticated scope denial).
    const segment = segments[1]!;
    const value = decoded(segment);
    clientId = value ?? segment;
    if (value === null) routePath = `/clients/${encodeURIComponent(segment)}/ask`;
  }
  if (shape === null) return null;
  if (method === 'HEAD' || method === 'OPTIONS') return { action: 'reject' };
  if ((shape === 'capability' && method === 'GET') || (shape === 'question' && method === 'POST')) {
    return { action: 'intercept', shape, hasQuery: parsed.suffix, clientId, routePath };
  }
  return null;
}

/** Content-Type of the question POST: application/json with at most the parameter charset=utf-8 (any letter case). */
export function jsonContentType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const [type, ...params] = value.split(';').map(part => part.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.length === 0 || (params.length === 1 && /^charset=("?)utf-8\1$/.test(params[0]!));
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const wellFormed = (text: string): boolean => !LONE_SURROGATE.test(text);

/** 1..2000 Unicode code points with a non-whitespace character; no NUL/C0 (except TAB, LF, CR), DEL or lone surrogate. */
export function validQuestion(value: unknown): value is string {
  if (typeof value !== 'string' || CONTROL.test(value) || !wellFormed(value) || !/\S/u.test(value)) return false;
  let points = 0;
  for (const _ of value) if (++points > ASK_LIMITS.questionCodePoints) return false;
  return points >= 1;
}

export interface AskRequestV1 { readonly requestId: string; readonly question: string; readonly observationId: string | null }
const REQUEST_KEYS = ['contractVersion', 'observationId', 'question', 'requestId'];

/** Exact AskRequestV1 semantics: all four keys, nothing else. The question is kept unchanged, never trimmed or truncated. */
export function askRequest(body: unknown): AskRequestV1 {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return askFailure('ASK_REQUEST_INVALID');
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== REQUEST_KEYS.length || keys.some((key, i) => key !== REQUEST_KEYS[i])) return askFailure('ASK_REQUEST_INVALID');
  const { contractVersion, requestId, question, observationId } = input;
  if (contractVersion !== 'AskRequestV1' || typeof requestId !== 'string' || !UUID_V4.test(requestId) || !validQuestion(question)) {
    return askFailure('ASK_REQUEST_INVALID');
  }
  if (observationId !== null && (typeof observationId !== 'string' || observationId.length === 0 || observationId.length > ASK_LIMITS.observationIdLength)) {
    return askFailure('ASK_REQUEST_INVALID');
  }
  return Object.freeze({ requestId, question, observationId });
}

/**
 * An observation ID that can name a stored row: PostgreSQL text holds no NUL, and a lone surrogate would be re-encoded as
 * U+FFFD on the wire and could match a different row. Such an ID is a missing focus, never a query or a near match.
 */
export const storableId = (id: string): boolean => !id.includes('\u0000') && wellFormed(id);
