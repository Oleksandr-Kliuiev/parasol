import { record, list, contractMismatch } from '../dto.ts';
import { M365_MAX_PAGE_ROWS, requiredGuid, optionalGuid, boundedText, optionalBoolean } from './dto-common.ts';
import type { M365Parsed, M365DtoReason } from './dto-common.ts';

/**
 * M365UserV1 / M365DeviceV1 (docs/stage2/02_CONTRACTS.md §2, request fields in 03 §1). The projection is an exact
 * allowlist built field by field: anything else Graph returns (including fields Atlas never selected) is discarded here.
 * Names and UPN are display hints, never identity proof. Missing booleans stay null, never false.
 */
export const M365_USER_TYPES = ['MEMBER', 'GUEST', 'UNKNOWN'] as const;
export type M365UserType = (typeof M365_USER_TYPES)[number];
export const M365_DISPLAY_NAME_MAX = 256;
export const M365_UPN_MAX = 320;
export const M365_OS_MAX = 128;

export interface M365UserV1 {
  /** Directory object ID within the tenant (lower-case GUID). */
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
  /** null when Graph sent none; UNKNOWN (with reason USER_TYPE_UNKNOWN) for a value Atlas does not know. */
  userType: M365UserType | null;
  accountEnabled: boolean | null;
}
export interface M365DeviceV1 {
  /** Directory object key. Distinct from deviceId. */
  id: string;
  /** Device registration alternate key; the value sign-ins report. null when empty. Not assumed unique. */
  deviceId: string | null;
  displayName: string | null;
  accountEnabled: boolean | null;
  operatingSystem: string | null;
}

function userType(value: unknown): { value: M365UserType | null; reasons: M365DtoReason[] } {
  if (value === null || value === undefined) return { value: null, reasons: [] };
  if (typeof value !== 'string') throw contractMismatch('user.userType');
  const known = value.toLowerCase() === 'member' ? 'MEMBER' : value.toLowerCase() === 'guest' ? 'GUEST' : null;
  // The raw string is dropped on purpose: a new vendor value must not reach storage, audit or logs.
  return known ? { value: known, reasons: [] } : { value: 'UNKNOWN', reasons: ['USER_TYPE_UNKNOWN'] };
}

export function parseM365User(value: unknown): M365Parsed<M365UserV1> {
  const u = record(value, 'user');
  const type = userType(u.userType);
  return {
    dto: { id: requiredGuid(u.id, 'user.id'), displayName: boundedText(u.displayName, 'user.displayName', M365_DISPLAY_NAME_MAX),
      userPrincipalName: boundedText(u.userPrincipalName, 'user.userPrincipalName', M365_UPN_MAX), userType: type.value,
      accountEnabled: optionalBoolean(u.accountEnabled, 'user.accountEnabled') },
    reasons: type.reasons,
  };
}
export function parseM365Device(value: unknown): M365Parsed<M365DeviceV1> {
  const d = record(value, 'device');
  return {
    dto: { id: requiredGuid(d.id, 'device.id'), deviceId: optionalGuid(d.deviceId, 'device.deviceId'),
      displayName: boundedText(d.displayName, 'device.displayName', M365_DISPLAY_NAME_MAX),
      accountEnabled: optionalBoolean(d.accountEnabled, 'device.accountEnabled'),
      operatingSystem: boundedText(d.operatingSystem, 'device.operatingSystem', M365_OS_MAX) },
    reasons: [],
  };
}

export interface M365DirectoryPage<T> { items: T[]; reasons: readonly M365DtoReason[] }
/**
 * One Graph collection page body: `value` must be an array of at most 500 rows (the requested $top); a single invalid row
 * invalidates the whole page, and a repeated object ID inside it is a contract violation. Paging links are the HTTP
 * layer's concern and are never read here.
 */
export function parseM365DirectoryPage<T extends { id: string }>(body: unknown, row: (value: unknown) => M365Parsed<T>): M365DirectoryPage<T> {
  const rows = list(record(body, 'root').value, 'value');
  if (rows.length > M365_MAX_PAGE_ROWS) throw contractMismatch('value');
  const seen = new Set<string>();
  const reasons = new Set<M365DtoReason>();
  const items = rows.map(raw => {
    const parsed = row(raw);
    if (seen.has(parsed.dto.id)) throw contractMismatch('value.id');
    seen.add(parsed.dto.id);
    parsed.reasons.forEach(r => reasons.add(r));
    return parsed.dto;
  });
  return { items, reasons: [...reasons] };
}
export const parseM365UserPage = (body: unknown) => parseM365DirectoryPage(body, parseM365User);
export const parseM365DevicePage = (body: unknown) => parseM365DirectoryPage(body, parseM365Device);
