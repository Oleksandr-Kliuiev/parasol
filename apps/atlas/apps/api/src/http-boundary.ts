import { HttpException, ForbiddenException, BadRequestException, BadGatewayException, ConflictException, InternalServerErrorException, Logger } from '@nestjs/common';
import { AtlasError, activeObservationStatuses, observationStatuses, safeErrorCode, severities } from '../../../packages/core/contracts.ts';
import type { ObservationQuery } from '../../../packages/observations/query.ts';

const logger = new Logger('AtlasApi');

/**
 * AtlasError.kind → HTTP without leaking internals (docs/02): SCOPE 403, VALIDATION 400, CONFLICT 409, broken upstream or
 * result contract 502, everything else 500. HTTP exceptions raised by the API layer pass through unchanged. Unexpected errors
 * are logged by name and safe code only, never by message (which may carry query details).
 */
export function toHttp(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof AtlasError) {
    if (error.kind === 'SCOPE') throw new ForbiddenException('Access denied');
    if (error.kind === 'VALIDATION') throw new BadRequestException();
    if (error.kind === 'CONFLICT') throw new ConflictException();
    if (error.code === 'CONTEXT_SCOPE_MISMATCH' || error.code === 'CONTEXT_CONTRACT_MISMATCH' || error.kind === 'TRANSIENT') throw new BadGatewayException(error.code);
  }
  const code = (error as { code?: unknown } | null)?.code;
  logger.error(`request failed: ${error instanceof Error ? error.name : typeof error} ${typeof code === 'string' ? code.slice(0, 40) : safeErrorCode(error)}`);
  throw new InternalServerErrorException();
}

/**
 * GET /clients/:id/observations query (task 1.8): `status` and `severity` are comma-separated lists of known values without
 * repeats (defaults: the active statuses, every severity), `cursor` an opaque base64url string, `limit` as parseLimit.
 * Anything else — a repeated parameter, an unknown value, an empty item — is a 400 before any query runs.
 */
export function parseObservationQuery(query: { status?: unknown; severity?: unknown; cursor?: unknown; limit?: unknown }, max: number): ObservationQuery {
  const list = <T extends string>(value: unknown, allowed: readonly T[], fallback: readonly T[]): T[] => {
    if (value === undefined) return [...fallback];
    if (typeof value !== 'string' || value.length > 100) throw new BadRequestException();
    const items = value.split(',');
    if (new Set(items).size !== items.length || !items.every(i => (allowed as readonly string[]).includes(i))) throw new BadRequestException();
    return items as T[];
  };
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,400}$/.test(query.cursor))) throw new BadRequestException();
  return { statuses: list(query.status, observationStatuses, activeObservationStatuses), severities: list(query.severity, severities, severities),
    limit: parseLimit(query.limit, max), cursor: (query.cursor as string | undefined) ?? null };
}

/** Page size from a query string: absent → `max`; anything but an integer in 1..max → 400. */
export function parseLimit(value: unknown, max: number): number {
  if (value === undefined) return max;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value) || Number(value) > max) throw new BadRequestException();
  return Number(value);
}

/**
 * POST /tools/execute body, versioned DTO v1 (task 1.9): `version` ("1", optional), `clientId`, `tool`, `parameters` (a
 * plain object, optional — validated by the tool's runtime schema in the gateway) and `requestId` (optional correlation,
 * echoed as X-Atlas-Correlation-Id). Risk, sideEffect, actor, permissions or any other field are a 400, never an input:
 * the actor comes from authentication, the tool metadata from the registry.
 */
export interface ToolRequest { clientId: string; tool: string; parameters: unknown; requestId: string | null }
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
const TOOL_REQUEST_KEYS = ['version', 'clientId', 'tool', 'parameters', 'requestId'];
export function parseToolRequest(body: unknown): ToolRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException();
  const input = body as Record<string, unknown>;
  const plain = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (Object.keys(input).some(k => !TOOL_REQUEST_KEYS.includes(k)) || typeof input.clientId !== 'string' || typeof input.tool !== 'string'
    || input.clientId.length > 128 || input.tool.length > 100 || (input.version !== undefined && input.version !== '1')
    || (input.parameters !== undefined && (!plain(input.parameters) || JSON.stringify(input.parameters).length > 2048))
    || (input.requestId !== undefined && (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)))) throw new BadRequestException();
  return { clientId: input.clientId, tool: input.tool, parameters: input.parameters, requestId: (input.requestId as string | undefined) ?? null };
}
