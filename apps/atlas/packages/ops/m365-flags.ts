import { AtlasError } from '../core/contracts.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { CURSOR_PATTERN, millisecondInstant } from '../correlation/parameters.ts';
import { parseTimeInput } from '../correlation/time.ts';
import type { Flags } from './commands.ts';

/**
 * Flag rules of the frozen M365 CLI contract (brief RC3), applied at parse time: malformed IDs, unknown resource values,
 * malformed times/limits/cursors and incompatible modes are INVALID_ARGUMENTS before any permission check, service or I/O.
 */
const bad = () => new AtlasError('INVALID_ARGUMENTS', 'VALIDATION');
export const RESOURCE: Readonly<Record<string, 'm365_user' | 'm365_device'>> = Object.freeze({ users: 'm365_user', devices: 'm365_device' });

export function ids(flags: Flags, ...names: string[]): void {
  for (const name of names) if (flags[name] !== undefined && !SCOPE_ID_PATTERN.test(flags[name]!)) throw bad();
}
export function directoryResource(flags: Flags): void {
  if (!Object.hasOwn(RESOURCE, flags.resource ?? '')) throw bad();
}
/** limit 1..100 (decimal) and the shared cursor syntax (≤512 ASCII including the MAC). */
export function paging(flags: Flags): void {
  if (flags.limit !== undefined && (!/^[1-9][0-9]{0,2}$/.test(flags.limit) || Number(flags.limit) > 100)) throw bad();
  if (flags.cursor !== undefined && !CURSOR_PATTERN.test(flags.cursor)) throw bad();
}
export function readInterval(flags: Flags): void {
  if (parseTimeInput(flags.from) === null || parseTimeInput(flags.to) === null) throw bad();
}
/**
 * m365-sync modes: users/devices take no from/to/request; signins create takes from+to (millisecond bounds, sub-ms refused)
 * and no request; signins resume takes request and no from/to.
 */
export function syncMode(flags: Flags): 'directory' | 'create' | 'resume' {
  ids(flags, 'connection', 'request');
  const has = (name: string) => flags[name] !== undefined;
  if (Object.hasOwn(RESOURCE, flags.resource ?? '')) {
    if (has('from') || has('to') || has('request')) throw bad();
    return 'directory';
  }
  if (flags.resource !== 'signins') throw bad();
  if (has('request') && !has('from') && !has('to')) return 'resume';
  if (!has('request') && has('from') && has('to')) {
    millisecondInstant(flags.from, 'from'); millisecondInstant(flags.to, 'to');
    return 'create';
  }
  throw bad();
}
/** Read parameters of correlation/m365-directory as the shared service parser expects them (absent optional flags omitted). */
export function optional(flags: Flags, mapping: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping).filter(([flag]) => flags[flag] !== undefined).map(([flag, key]) => [key, flags[flag]!]));
}
