import { record, list, contractMismatch } from '../dto.ts';
import { M365_MAX_PAGE_ROWS, optionalGuid, requiredOpaqueId, requiredUtcTime, optionalBoolean } from './dto-common.ts';

/**
 * M365SignInV1 (docs/stage2/02_CONTRACTS.md §2). Graph signIns has no documented $select, so the response is received
 * whole and projected here at once: no IP address, location, sign-in user name/UPN, authentication details, conditional
 * access, risk, free-text failure reason or token ever leaves this function. userId/deviceId/appId are evidence
 * references, not verified ownership. errorCode is a status, never a severity; absent status stays null, not success.
 */
export const M365_SIGNIN_ID_MAX = 256;
export interface M365SignInV1 {
  /** Opaque Graph sign-in ID, exact as sent. */
  id: string;
  /** Strict UTC instant, canonical ISO text. */
  createdDateTime: string;
  userId: string | null;
  /** deviceDetail.deviceId: compares to the directory device's deviceId, never to its id. */
  deviceId: string | null;
  appId: string | null;
  errorCode: number | null;
  isInteractive: boolean | null;
}

function errorCode(status: unknown): number | null {
  if (status === null || status === undefined) return null;
  const code = record(status, 'signIn.status').errorCode;
  if (code === null || code === undefined) return null;
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 0) throw contractMismatch('signIn.status.errorCode');
  return code;
}

export function parseM365SignIn(value: unknown): M365SignInV1 {
  const s = record(value, 'signIn');
  const detail = s.deviceDetail === null || s.deviceDetail === undefined ? null : record(s.deviceDetail, 'signIn.deviceDetail');
  return {
    id: requiredOpaqueId(s.id, 'signIn.id', M365_SIGNIN_ID_MAX), createdDateTime: requiredUtcTime(s.createdDateTime, 'signIn.createdDateTime'),
    userId: optionalGuid(s.userId, 'signIn.userId'), deviceId: optionalGuid(detail?.deviceId, 'signIn.deviceDetail.deviceId'),
    appId: optionalGuid(s.appId, 'signIn.appId'), errorCode: errorCode(s.status), isInteractive: optionalBoolean(s.isInteractive, 'signIn.isInteractive'),
  };
}

/** One signIns page body: at most 500 rows; one invalid row fails the page. Duplicate IDs are not rejected here: a
 * repeated ID with other content is a conflict version for the evidence store (03 §5), not a malformed page. */
export function parseM365SignInPage(body: unknown): M365SignInV1[] {
  const rows = list(record(body, 'root').value, 'value');
  if (rows.length > M365_MAX_PAGE_ROWS) throw contractMismatch('value');
  return rows.map(parseM365SignIn);
}
