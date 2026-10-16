import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Controller, Get, Inject, Module, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../../../../packages/core/contracts.ts';
import { AtlasError } from '../../../../packages/core/contracts.ts';
import { envCursorKey } from '../../../../packages/correlation/cursor.ts';
import { CORRELATION_DENIED_EVENT, readCorrelation } from '../../../../packages/correlation/read.ts';
import { toHttp } from '../http-boundary.ts';
import { PRISMA } from './database.ts';
import { AuthModule, ApiTokenGuard, AccessPolicy, CurrentActor } from './auth.ts';

/**
 * GET /clients/:clientId/observations/:observationId/correlation (02 §5): a thin controller over the shared correlation
 * service, which owns the all-of authority (context:read + m365:read; one workspace denial), the strict input parser
 * (required connectionId/from/to, optional limit/cursor; unknown, repeated or non-scalar keys are a 400), the snapshot and
 * the cursor. A malformed client ID is denied here before anything else. Stored data only: no sync, no widening.
 * The three cursor outcomes carry their fixed code in the body; everything else maps like the Stage 1 endpoints.
 */
export function correlationQuery(query: unknown, observationId: string): Record<string, unknown> {
  const raw: Record<string, unknown> = query && typeof query === 'object' && !Array.isArray(query) ? { ...(query as Record<string, unknown>) } : { parameters: query };
  // The observation comes from the path; a query override of it is a non-scalar (refused by the parser), never an input.
  raw.observationId = Object.hasOwn(raw, 'observationId') ? [raw.observationId, observationId] : observationId;
  return raw;
}
export function correlationHttp(error: unknown): never {
  if (error instanceof AtlasError && (error.code === 'CORRELATION_CHANGED' || error.code === 'CORRELATION_CURSOR_EXPIRED')) {
    throw new ConflictException({ statusCode: 409, error: 'Conflict', code: error.code });
  }
  if (error instanceof AtlasError && error.code === 'CORRELATION_CURSOR_INVALID') throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: error.code });
  return toHttp(error);
}

@Controller('clients')
@UseGuards(ApiTokenGuard)
export class CorrelationsController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient, private readonly access: AccessPolicy) {}

  @Get(':clientId/observations/:observationId/correlation')
  async correlation(@CurrentActor() actor: Actor, @Param('clientId') clientId: string, @Param('observationId') observationId: string, @Query() query: unknown,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown }) {
    const correlationId = randomUUID();
    res.setHeader('x-atlas-correlation-id', correlationId);
    await this.access.requireWellFormedClient(actor, clientId, CORRELATION_DENIED_EVENT, {}, correlationId);
    const scope = { workspaceId: actor.workspaceId, clientId };
    try { return await readCorrelation(this.db, actor, scope, correlationQuery(query, observationId), { cursorKey: envCursorKey(), correlationId }); }
    catch (error) { correlationHttp(error); }
  }
}

@Module({ imports: [AuthModule], controllers: [CorrelationsController] })
export class CorrelationsModule {}
