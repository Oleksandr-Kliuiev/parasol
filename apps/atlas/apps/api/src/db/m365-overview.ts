import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Module, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../../../../packages/core/contracts.ts';
import { M365_OVERVIEW_DENIED_EVENT, readM365Overview } from '../../../../packages/m365/overview.ts';
import { toHttp } from '../http-boundary.ts';
import { PRISMA } from './database.ts';
import { AccessPolicy, ApiTokenGuard, AuthModule, CurrentActor } from './auth.ts';

@Controller('clients')
@UseGuards(ApiTokenGuard)
export class M365OverviewController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient, private readonly access: AccessPolicy) {}

  @Get(':clientId/m365/overview')
  async overview(@CurrentActor() actor: Actor, @Param('clientId') clientId: string, @Query() query: unknown,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown }) {
    const correlationId = randomUUID();
    res.setHeader('x-atlas-correlation-id', correlationId);
    res.setHeader('Cache-Control', 'no-store');
    await this.access.requireWellFormedClient(actor, clientId, M365_OVERVIEW_DENIED_EVENT, {}, correlationId);
    try { return await readM365Overview(this.db, actor, { workspaceId: actor.workspaceId, clientId }, query, correlationId); }
    catch (error) { toHttp(error); }
  }
}

@Module({ imports: [AuthModule], controllers: [M365OverviewController] })
export class M365OverviewModule {}
