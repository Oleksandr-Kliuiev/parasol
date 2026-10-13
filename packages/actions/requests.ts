import type { Prisma, PrismaClient } from '@prisma/client';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import {
  ACTION_MODE, ACTION_POLICY_VERSION, ACTION_PORT_VERSION, ACTION_REQUEST_DTO, ACTION_TYPE, ACTION_VERSION, INPUT_MAX_BYTES, LIST_DEFAULT,
  LIST_MAX, PREVIEW_PERMISSIONS, READ_PERMISSIONS, REQUEST_PERMISSIONS, actionError,
} from './contracts.ts';
import type {
  ActionListPage, ActionPreviewDocument, ActionPreviewResult, ActionRequestResult, ActionRequestSummary, NormalizedInput, RequestState,
} from './contracts.ts';
import {
  actionMarker, canonicalHash, deriveRequestId, intentHash, isHash, isUuid, markedTitle, normalizeInput, previewDocument, secretRefDigest,
} from './canonical.ts';
import type { CanonicalRequest } from './canonical.ts';
import { assertActionConnection } from './policy.ts';
import type { ActionComposition } from './policy.ts';
import { clientAudit, validityHint, withFencedAdmission } from './authority.ts';
import type { ActionCredential, Admission, AdmissionOutcome } from './authority.ts';
import { readProtectedJson, writeProtectedFile } from './private-file.ts';

/**
 * Preview, request and safe reads (02_CONTRACTS "Deterministic preview, intent and request ordering"). Ordering for
 * preview and request: syntax validation → fenced current authority → same-requester idempotency lookup → user-intent
 * comparison. An existing key with the same intent is RETRIEVAL: the original immutable request, its stored hash and state,
 * idempotent:true and a validity hint — never a new snapshot, state change, renewal or rebinding. Only a missing key
 * evaluates the current binding/epoch/policy. Private content leaves only through a protected preview file.
 */
type RequestRow = Prisma.ActionRequestGetPayload<{}>;

/** Only the exact trusted MOCK composition (deployed policy/port versions) reaches an action service. */
export function assertComposition(composition: ActionComposition): void {
  if (composition?.mode !== ACTION_MODE || composition.policyVersion !== ACTION_POLICY_VERSION || composition.portVersion !== ACTION_PORT_VERSION) {
    throw actionError('ACTION_MODE_REFUSED');
  }
}
async function readInput(inputFile: string): Promise<NormalizedInput> {
  return normalizeInput(await readProtectedJson(inputFile, INPUT_MAX_BYTES));
}

function summary(row: RequestRow, admission: Admission): ActionRequestSummary {
  return { requestId: row.id, state: row.state as RequestState, actionType: row.actionType, actionVersion: row.actionVersion,
    policyVersion: row.policyVersion, portVersion: row.portVersion, mode: ACTION_MODE, inputHash: row.inputHash, authorityEpoch: row.authorityEpoch,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    validity: validityHint(row.state, row.authorityEpoch, admission.epoch, row.requesterTokenExpiresAt, admission.now), synthetic: true };
}
/** STORED_ACTION_PREVIEW from the immutable row (never from caller content or a supplied file). */
export function storedPreview(row: RequestRow): ActionPreviewDocument {
  return { kind: 'STORED_ACTION_PREVIEW', dto: 'atlas-action-preview/1', requestId: row.id, workspaceId: row.workspaceId, clientId: row.clientId,
    connectionId: row.connectionId, actionType: row.actionType, actionVersion: row.actionVersion, policyVersion: row.policyVersion,
    portVersion: row.portVersion, mode: ACTION_MODE, title: row.markedTitle, description: row.description, marker: row.marker, inputHash: row.inputHash };
}
const previewJson = (doc: ActionPreviewDocument): string => `${JSON.stringify(doc, null, 2)}\n`;

type Lookup = { existing: RequestRow } | { fresh: CanonicalRequest; inputHash: string };
/** Steps after authority: idempotency lookup, intent comparison, then (missing key only) binding/policy and the snapshot. */
async function lookupOrSnapshot(tx: Prisma.TransactionClient, admission: Admission, input: NormalizedInput, refusedEvent: string):
  Promise<AdmissionOutcome<Lookup>> {
  const scope = { workspaceId: admission.workspaceId, clientId: admission.clientId };
  const existing = await tx.actionRequest.findUnique({ where: { workspaceId_clientId_requesterActorId_idempotencyKey: {
    ...scope, requesterActorId: admission.actor.id, idempotencyKey: input.idempotencyKey } } });
  if (existing) {
    if (existing.intentHash !== intentHash(input)) {
      await clientAudit(tx, admission, refusedEvent, { actionRequestId: existing.id, safeErrorCode: 'IDEMPOTENCY_CONFLICT' });
      return { refused: 'IDEMPOTENCY_CONFLICT' };
    }
    return { ok: { existing } };
  }
  const connection = SCOPE_ID_PATTERN.test(input.connectionId) ? await tx.connection.findUnique({
    where: { workspaceId_clientId_id: { ...scope, id: input.connectionId } },
    select: { system: true, status: true, externalTenantId: true, secretRef: true, lifecycleVersion: true } }) : null;
  try { assertActionConnection(connection); } catch {
    await clientAudit(tx, admission, refusedEvent, { connectionId: input.connectionId, safeErrorCode: 'ACTION_CONNECTION_REFUSED' });
    return { refused: 'ACTION_CONNECTION_REFUSED' };
  }
  const requestId = deriveRequestId(admission.workspaceId, admission.clientId, admission.actor.id, input.idempotencyKey);
  const fresh: CanonicalRequest = { dto: ACTION_REQUEST_DTO, requestId, ...scope, connectionId: input.connectionId,
    requesterActorId: admission.signer.actorId, requesterTokenId: admission.signer.tokenId,
    requesterTokenExpiresAt: admission.signer.tokenExpiresAt?.toISOString() ?? null,
    actionType: ACTION_TYPE, actionVersion: ACTION_VERSION, policyVersion: ACTION_POLICY_VERSION, portVersion: ACTION_PORT_VERSION, mode: ACTION_MODE,
    connectionSystem: connection.system, customerKey: connection.externalTenantId, lifecycleVersion: connection.lifecycleVersion,
    secretRefDigest: secretRefDigest(connection.secretRef), authorityEpoch: admission.epoch,
    title: markedTitle(input.title, requestId), description: input.description };
  return { ok: { fresh, inputHash: canonicalHash(fresh) } };
}

/** action-preview: non-persisting admission; writes the private preview file (stored content for an existing intent). */
export async function previewAction(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  inputFile: string, previewFile: string): Promise<ActionPreviewResult> {
  assertComposition(composition);
  const input = await readInput(inputFile);
  const result = await withFencedAdmission(db, credential, clientId, { permissions: PREVIEW_PERMISSIONS, deniedEvent: 'action.preview_denied' },
    async (tx, admission): Promise<AdmissionOutcome<{ doc: ActionPreviewDocument; result: ActionPreviewResult }>> => {
      const found = await lookupOrSnapshot(tx, admission, input, 'action.preview_refused');
      if ('refused' in found) return found;
      if ('existing' in found.ok) {
        const row = found.ok.existing;
        return { ok: { doc: storedPreview(row), result: { requestId: row.id, inputHash: row.inputHash, idempotent: true,
          validity: validityHint(row.state, row.authorityEpoch, admission.epoch, row.requesterTokenExpiresAt, admission.now), synthetic: true } } };
      }
      const { fresh, inputHash } = found.ok;
      return { ok: { doc: previewDocument('ACTION_INPUT_PREVIEW', fresh, inputHash),
        result: { requestId: fresh.requestId, inputHash, idempotent: false, validity: 'CURRENT', synthetic: true } } };
    });
  await writeProtectedFile(previewFile, previewJson(result.doc));
  return result.result;
}

/** action-request: stores a new immutable request when --hash matches the current snapshot, or retrieves the original. */
export async function requestAction(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  inputFile: string, expectedHash: string): Promise<ActionRequestResult> {
  assertComposition(composition);
  if (!isHash(expectedHash)) throw actionError('ACTION_INPUT_INVALID');
  const input = await readInput(inputFile);
  return withFencedAdmission(db, credential, clientId, { permissions: REQUEST_PERMISSIONS, deniedEvent: 'action.request_denied' },
    async (tx, admission): Promise<AdmissionOutcome<ActionRequestResult>> => {
      const found = await lookupOrSnapshot(tx, admission, input, 'action.request_refused');
      if ('refused' in found) return found;
      if ('existing' in found.ok) return { ok: { ...summary(found.ok.existing, admission), idempotent: true } };
      const { fresh, inputHash } = found.ok;
      if (inputHash !== expectedHash) {
        await clientAudit(tx, admission, 'action.request_refused', { connectionId: fresh.connectionId, safeErrorCode: 'ACTION_PREVIEW_STALE' });
        return { refused: 'ACTION_PREVIEW_STALE' };
      }
      // A derived-ID collision with another request is refused, never adopted (the key lookup above found nothing).
      const collision = await tx.actionRequest.findUnique({ where: { workspaceId_clientId_id: { workspaceId: fresh.workspaceId, clientId: fresh.clientId, id: fresh.requestId } },
        select: { id: true } });
      if (collision) {
        await clientAudit(tx, admission, 'action.request_refused', { safeErrorCode: 'ACTION_STATE_CONFLICT' });
        return { refused: 'ACTION_STATE_CONFLICT' };
      }
      const row = await tx.actionRequest.create({ data: {
        workspaceId: fresh.workspaceId, clientId: fresh.clientId, id: fresh.requestId, connectionId: fresh.connectionId,
        requesterActorId: fresh.requesterActorId, requesterTokenId: fresh.requesterTokenId, requesterTokenExpiresAt: admission.signer.tokenExpiresAt,
        idempotencyKey: input.idempotencyKey, intentHash: intentHash(input), dtoVersion: fresh.dto, actionType: fresh.actionType,
        actionVersion: fresh.actionVersion, policyVersion: fresh.policyVersion, portVersion: fresh.portVersion, mode: fresh.mode,
        connectionSystem: fresh.connectionSystem, customerKey: fresh.customerKey, connectionLifecycleVersion: fresh.lifecycleVersion,
        secretRefDigest: fresh.secretRefDigest, authorityEpoch: fresh.authorityEpoch, markedTitle: fresh.title, description: fresh.description,
        marker: actionMarker(fresh.requestId), canonicalInput: fresh as unknown as Prisma.InputJsonObject, inputHash,
        createdAt: admission.now, updatedAt: admission.now } });
      await clientAudit(tx, admission, 'action.requested', { actionRequestId: row.id, actionType: row.actionType, requestState: row.state,
        connectionId: row.connectionId });
      return { ok: { ...summary(row, admission), idempotent: false } };
    });
}

async function loadRequest(tx: Prisma.TransactionClient, admission: Admission, requestId: string): Promise<RequestRow | null> {
  return tx.actionRequest.findUnique({ where: { workspaceId_clientId_id: { workspaceId: admission.workspaceId, clientId: admission.clientId, id: requestId } } });
}
/** action-get: safe summary of one request of the client (read + context). */
export async function getAction(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string): Promise<ActionRequestSummary> {
  assertComposition(composition);
  if (!isUuid(requestId)) throw actionError('ACTION_INPUT_INVALID');
  return withFencedAdmission(db, credential, clientId, { permissions: READ_PERMISSIONS, deniedEvent: 'action.read_denied' },
    async (tx, admission): Promise<AdmissionOutcome<ActionRequestSummary>> => {
    const row = await loadRequest(tx, admission, requestId);
    return row ? { ok: summary(row, admission) } : { refused: 'ACTION_NOT_FOUND' };
  });
}
/** action-get --preview-file: exports the exact STORED preview to a protected file (read + context; no request grant). */
export async function exportStoredPreview(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string, previewFile: string): Promise<ActionRequestSummary> {
  assertComposition(composition);
  if (!isUuid(requestId)) throw actionError('ACTION_INPUT_INVALID');
  const found = await withFencedAdmission(db, credential, clientId, { permissions: READ_PERMISSIONS, deniedEvent: 'action.read_denied' },
    async (tx, admission): Promise<AdmissionOutcome<{ doc: ActionPreviewDocument; summary: ActionRequestSummary }>> => {
      const row = await loadRequest(tx, admission, requestId);
      return row ? { ok: { doc: storedPreview(row), summary: summary(row, admission) } } : { refused: 'ACTION_NOT_FOUND' };
    });
  await writeProtectedFile(previewFile, previewJson(found.doc));
  return found.summary;
}

const encodeCursor = (row: { createdAt: Date; id: string }) => Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url');
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && isUuid(value[1])) {
      const createdAt = new Date(value[0]);
      if (!Number.isNaN(createdAt.getTime()) && createdAt.toISOString() === value[0]) return { createdAt, id: value[1] };
    }
  } catch { /* refused below */ }
  throw actionError('ACTION_INPUT_INVALID');
}
/** action-list: newest first, keyset over (createdAt, id), 50 default / 100 maximum, summaries only (no text bodies). */
export async function listActions(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  options: { limit?: number; cursor?: string } = {}): Promise<ActionListPage> {
  assertComposition(composition);
  const limit = options.limit ?? LIST_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) throw actionError('ACTION_INPUT_INVALID');
  const after = options.cursor === undefined ? null : decodeCursor(options.cursor);
  return withFencedAdmission(db, credential, clientId, { permissions: READ_PERMISSIONS, deniedEvent: 'action.read_denied' },
    async (tx, admission): Promise<AdmissionOutcome<ActionListPage>> => {
    const rows = await tx.actionRequest.findMany({ where: { workspaceId: admission.workspaceId, clientId: admission.clientId,
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const page = rows.slice(0, limit);
    return { ok: { items: page.map(r => summary(r, admission)), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null, synthetic: true } };
  });
}
