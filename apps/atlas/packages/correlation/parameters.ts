import { AtlasError } from '../core/contracts.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { floorMs, parseTimeInput, keyPlusMs, UTC_INPUT_PATTERN } from './time.ts';
import type { TimeKey } from './time.ts';

/**
 * Strict input of the Stage 2 paged reads, one parser for HTTP, tools and CLI (brief RC3 "API, tools, fixtures and operator
 * surfaces"). Input is a plain object of declared scalar keys only: an unknown, repeated (array), nested or non-scalar
 * value, a tenant/client/workspace override, a malformed ID, from >= to, a duration over 24h or a malformed cursor is a
 * VALIDATION error naming the parameter only. The time bounds that depend on the database clock (future end, older than
 * seven days) are checked by the service inside its snapshot; nothing is silently clipped or widened.
 */
export const READ_LIMIT_DEFAULT = 50;
export const READ_LIMIT_MAX = 100;
export const MAX_READ_INTERVAL_MS = 24 * 60 * 60_000;
/** One shared bound for every surface: at most 512 ASCII characters including the MAC (base64url claims '.' base64url MAC). */
export const CURSOR_MAX_LENGTH = 512;
export const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,468}\.[A-Za-z0-9_-]{43}$/;
/** Tool-parameter form of the same limit: a decimal integer 1..100. */
const LIMIT_TEXT = /^[1-9][0-9]{0,2}$/;

export type DirectoryResourceType = 'm365_user' | 'm365_device';
export interface IntervalInput { from: TimeKey; to: TimeKey }
export interface PageInput { limit: number; cursor: string | null }
export interface SignInListInput extends IntervalInput, PageInput { connectionId: string }
export interface CorrelationInput extends SignInListInput { observationId: string }
export interface DirectoryListInput extends PageInput { connectionId: string; resourceType: DirectoryResourceType }

const invalid = (parameter: string) => new AtlasError('INVALID_READ_PARAMETERS', 'VALIDATION', { parameter });
export const cursorInvalid = () => new AtlasError('CORRELATION_CURSOR_INVALID', 'VALIDATION');

function plain(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid('parameters');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid('unexpected');
  return input;
}
function id(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || !SCOPE_ID_PATTERN.test(value)) throw invalid(name);
  return value;
}
function time(input: Record<string, unknown>, name: string): TimeKey {
  const key = parseTimeInput(input[name]);
  if (key === null) throw invalid(name);
  return key;
}
function page(input: Record<string, unknown>): PageInput {
  const raw = input.limit;
  let limit = READ_LIMIT_DEFAULT;
  if (raw !== undefined) {
    if (typeof raw === 'number' && Number.isInteger(raw)) limit = raw;
    else if (typeof raw === 'string' && LIMIT_TEXT.test(raw)) limit = Number(raw);
    else throw invalid('limit');
    if (limit < 1 || limit > READ_LIMIT_MAX) throw invalid('limit');
  }
  const cursor = input.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > CURSOR_MAX_LENGTH || !CURSOR_PATTERN.test(cursor))) throw cursorInvalid();
  return { limit, cursor: (cursor as string | undefined) ?? null };
}
/** from < to and to − from ≤ 24h, compared on the fixed-width keys. */
export function interval(input: Record<string, unknown>): IntervalInput {
  const from = time(input, 'from'); const to = time(input, 'to');
  if (from >= to) throw invalid('to');
  if (keyPlusMs(from, MAX_READ_INTERVAL_MS) < to) throw invalid('to');
  return { from, to };
}

export function parseSignInListInput(raw: unknown): SignInListInput {
  const input = plain(raw, ['connectionId', 'from', 'to', 'limit', 'cursor']);
  return { connectionId: id(input, 'connectionId'), ...interval(input), ...page(input) };
}
export function parseCorrelationInput(raw: unknown): CorrelationInput {
  const input = plain(raw, ['connectionId', 'observationId', 'from', 'to', 'limit', 'cursor']);
  return { connectionId: id(input, 'connectionId'), observationId: id(input, 'observationId'), ...interval(input), ...page(input) };
}
export function parseDirectoryListInput(raw: unknown): DirectoryListInput {
  const input = plain(raw, ['connectionId', 'resourceType', 'limit', 'cursor']);
  const resourceType = input.resourceType;
  if (resourceType !== 'm365_user' && resourceType !== 'm365_device') throw invalid('resourceType');
  return { connectionId: id(input, 'connectionId'), resourceType, ...page(input) };
}

/** Sign-in sync creation keeps S2-B millisecond Date bounds: sub-millisecond input is refused, never truncated. */
export function millisecondInstant(value: unknown, parameter: string): Date {
  const key = parseTimeInput(value);
  if (key === null || key.slice(23, 27) !== '0000') throw invalid(parameter);
  return new Date(floorMs(key));
}
export { UTC_INPUT_PATTERN };
