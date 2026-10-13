import { createHash } from 'node:crypto';
import { canonicalJson } from '../events/identity.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import {
  ACTION_ID_DTO, ACTION_INTENT_DTO, ACTION_MODE, ACTION_PREVIEW_DTO, ACTION_REQUEST_DTO, ACTION_TYPE, DESCRIPTION_MAX, MARKED_TITLE_MAX,
  PREVIEW_FIELDS, TITLE_MAX, actionError,
} from './contracts.ts';
import type { ActionPreviewDocument, NormalizedInput } from './contracts.ts';

/**
 * Deterministic content rules (02_CONTRACTS "Deterministic preview"). Raw Unicode scalars are validated BEFORE NFC and
 * trimming (lone surrogates and the categories Cc/Cf/Cs/Co/Cn are refused; description may contain LF), then the normalized
 * value is revalidated and bounded in scalar values. Hashes are SHA-256 over the shared canonicalJson. Every failure is the
 * fixed ACTION_INPUT_INVALID: no field value is ever echoed.
 */
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export const canonicalHash = (value: unknown): string => sha256(canonicalJson(value));

const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);

/** Every UTF-16 code unit pairs up (no lone surrogate) and no scalar is in a refused category (LF only where allowed). */
export function validScalars(value: string, allowLineFeed: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  for (const ch of value) if (FORBIDDEN.test(ch) && !(allowLineFeed && ch === '\n')) return false;
  return true;
}
export const scalarLength = (value: string): number => { let n = 0; for (const _ of value) n++; return n; };

function normalizedText(raw: unknown, max: number, allowLineFeed: boolean): string {
  if (typeof raw !== 'string' || !validScalars(raw, allowLineFeed)) throw actionError('ACTION_INPUT_INVALID');
  const value = raw.normalize('NFC').trim();
  // Cheap revalidation: normalization cannot introduce a refused scalar, but the stored value is checked, not assumed.
  if (!validScalars(value, allowLineFeed)) throw actionError('ACTION_INPUT_INVALID');
  const length = scalarLength(value);
  if (length < 1 || length > max) throw actionError('ACTION_INPUT_INVALID');
  return value;
}

/** Strict input DTO: exactly connectionId, title, description, idempotencyKey (lower-case UUID). */
export function normalizeInput(raw: unknown): NormalizedInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw actionError('ACTION_INPUT_INVALID');
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== 'connectionId,description,idempotencyKey,title') throw actionError('ACTION_INPUT_INVALID');
  const input = raw as Record<string, unknown>;
  if (typeof input.connectionId !== 'string' || !SCOPE_ID_PATTERN.test(input.connectionId)) throw actionError('ACTION_INPUT_INVALID');
  if (!isUuid(input.idempotencyKey)) throw actionError('ACTION_INPUT_INVALID');
  return { connectionId: input.connectionId, idempotencyKey: input.idempotencyKey,
    title: normalizedText(input.title, TITLE_MAX, false), description: normalizedText(input.description, DESCRIPTION_MAX, true) };
}

/**
 * Request UUID: first 16 bytes of SHA-256(canonicalJson({dto, workspace, client, requester, idempotencyKey})), with the
 * RFC 9562 variant (10xx) and version 8 bits set — 122 hash bits remain.
 */
export function deriveRequestId(workspaceId: string, clientId: string, requesterActorId: string, idempotencyKey: string): string {
  const bytes = createHash('sha256').update(canonicalJson({ dto: ACTION_ID_DTO, workspaceId, clientId, requesterActorId, idempotencyKey }), 'utf8')
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const actionMarker = (requestId: string): string => `[Atlas:${requestId}]`;
export function markedTitle(title: string, requestId: string): string {
  const marked = `${title} ${actionMarker(requestId)}`;
  if (scalarLength(marked) > MARKED_TITLE_MAX || !validScalars(marked, false)) throw actionError('ACTION_INPUT_INVALID');
  return marked;
}
/** The user's intent for idempotency: connection, normalized title and description (not the key, scope or snapshot). */
export const intentHash = (input: NormalizedInput): string =>
  canonicalHash({ dto: ACTION_INTENT_DTO, actionType: ACTION_TYPE, connectionId: input.connectionId, title: input.title, description: input.description });

/** Everything a request is bound to; its canonicalJson SHA-256 is the request hash. No token digest or secret. */
export interface CanonicalRequest {
  dto: typeof ACTION_REQUEST_DTO; requestId: string; workspaceId: string; clientId: string; connectionId: string;
  requesterActorId: string; requesterTokenId: string; requesterTokenExpiresAt: string | null;
  actionType: string; actionVersion: string; policyVersion: string; portVersion: string; mode: typeof ACTION_MODE;
  connectionSystem: string; customerKey: string; lifecycleVersion: number; secretRefDigest: string; authorityEpoch: number;
  title: string; description: string;
}
export const secretRefDigest = (secretRef: string): string => sha256(secretRef);

/** Exact whitelist projection of a request into its private preview document. */
export function previewDocument(kind: ActionPreviewDocument['kind'], request: CanonicalRequest, inputHash: string): ActionPreviewDocument {
  return { kind, dto: ACTION_PREVIEW_DTO, requestId: request.requestId, workspaceId: request.workspaceId, clientId: request.clientId,
    connectionId: request.connectionId, actionType: request.actionType, actionVersion: request.actionVersion, policyVersion: request.policyVersion,
    portVersion: request.portVersion, mode: request.mode, title: request.title, description: request.description,
    marker: actionMarker(request.requestId), inputHash };
}
/** Parsed preview JSON with exactly the whitelist (for S3-B approval comparison); any other shape is refused. */
export function parsePreviewDocument(value: unknown): ActionPreviewDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw actionError('APPROVAL_PREVIEW_MISMATCH');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...PREVIEW_FIELDS].sort().join(',')) throw actionError('APPROVAL_PREVIEW_MISMATCH');
  if (PREVIEW_FIELDS.some(k => typeof record[k] !== 'string')) throw actionError('APPROVAL_PREVIEW_MISMATCH');
  return record as unknown as ActionPreviewDocument;
}
