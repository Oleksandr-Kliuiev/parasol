import { HttpException, ForbiddenException, BadRequestException, BadGatewayException, InternalServerErrorException, Logger } from '@nestjs/common';
import { AtlasError, activeObservationStatuses, observationStatuses, safeErrorCode, severities } from '../../../packages/core/contracts.ts';
import type { ObservationQuery } from '../../../packages/observations/query.ts';

const logger = new Logger('AtlasApi');

/**
 * AtlasError.kind → HTTP without leaking internals (docs/02): SCOPE 403, VALIDATION 400, broken upstream or result
 * contract 502, everything else 500. HTTP exceptions raised by the API layer pass through unchanged. Unexpected errors
 * are logged by name and safe code only, never by message (which may carry query details).
 */
export function toHttp(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof AtlasError) {
    if (error.kind === 'SCOPE') throw new ForbiddenException('Access denied');
    if (error.kind === 'VALIDATION') throw new BadRequestException();
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
 * POST /tools/execute body. Only clientId and tool are accepted; risk, sideEffect, actor or permissions in the body are a
 * 400, never an input. The actor and its permissions come from authentication, the tool metadata from the registry.
 */
export function parseToolRequest(body: unknown): { clientId: string; tool: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException();
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(k => k !== 'clientId' && k !== 'tool') || typeof input.clientId !== 'string' || typeof input.tool !== 'string'
    || input.clientId.length > 128 || input.tool.length > 100) throw new BadRequestException();
  return { clientId: input.clientId, tool: input.tool };
}
