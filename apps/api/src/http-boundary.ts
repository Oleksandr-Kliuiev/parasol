import { HttpException, ForbiddenException, BadRequestException, BadGatewayException, InternalServerErrorException, Logger } from '@nestjs/common';
import { AtlasError, safeErrorCode } from '../../../packages/core/contracts.ts';

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
