import { Controller, Get, Header, Inject, Module, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../../../../packages/core/contracts.ts';
import { getClientContext, getObservationPage, getObservationSummary, listClients, CONTEXT_OBSERVATION_LIMIT } from '../../../../packages/graph/prisma-context.ts';
import { listClientAudit, AUDIT_PAGE_LIMIT } from '../../../../packages/audit/prisma.ts';
import { toHttp, parseLimit, parseObservationQuery } from '../http-boundary.ts';
import { PRISMA } from './database.ts';
import { AuthModule, ApiTokenGuard, AccessPolicy, CurrentActor } from './auth.ts';

/**
 * ClientGraphModule: Stage 1 client endpoints over PostgreSQL. AccessPolicy decides first (denials audited, 403); every
 * read then runs through withScope as the runtime role, so RLS confines it to the approved client.
 */
@Controller('clients')
@UseGuards(ApiTokenGuard)
export class ClientsController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient, private readonly access: AccessPolicy) {}

  @Get() async list(@CurrentActor() actor: Actor) {
    try { return await listClients(this.db, actor); } catch (error) { toHttp(error); }
  }
  /** Parasol identity migration: only this actor's visible clients, never connection secrets or external payloads. */
  @Get('identity-export') @Header('Cache-Control', 'no-store') async identityExport(@CurrentActor() actor: Actor) {
    try {
      const clients = await listClients(this.db, actor);
      return { schemaVersion: 1, source: 'atlas', workspaceId: actor.workspaceId,
        clients: clients.map(c => ({ clientId: c.id, name: c.name })).sort((a, b) => a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0) };
    } catch (error) { toHttp(error); }
  }
  @Get(':id/overview') async overview(@CurrentActor() actor: Actor, @Param('id') id: string) {
    const scope = await this.access.requireClient(actor, id, 'context:read', 'client.overview_denied');
    try { return await getClientContext(this.db, actor, scope); } catch (error) { toHttp(error); }
  }
  @Get(':id/observations') async observations(@CurrentActor() actor: Actor, @Param('id') id: string, @Query('limit') limit?: unknown,
    @Query('status') status?: unknown, @Query('severity') severity?: unknown, @Query('cursor') cursor?: unknown,
    @Query('deviceId') deviceId?: unknown) {
    const scope = await this.access.requireClient(actor, id, 'context:read', 'client.observations_denied');
    const query = parseObservationQuery({ limit, status, severity, cursor, deviceId }, CONTEXT_OBSERVATION_LIMIT);
    try { return await getObservationPage(this.db, actor, scope, query); } catch (error) { toHttp(error); }
  }
  @Get(':id/observations/:observationId') @Header('Cache-Control', 'no-store') async observation(@CurrentActor() actor: Actor,
    @Param('id') id: string, @Param('observationId') observationId: string) {
    const scope = await this.access.requireClient(actor, id, 'context:read', 'client.observation_denied');
    try {
      const observation = await getObservationSummary(this.db, actor, scope, observationId);
      if (!observation) throw new NotFoundException();
      return observation;
    } catch (error) { toHttp(error); }
  }
  @Get(':id/audit') async audit(@CurrentActor() actor: Actor, @Param('id') id: string, @Query('limit') limit?: unknown) {
    const scope = await this.access.requireClient(actor, id, 'context:read', 'client.audit_denied');
    const size = parseLimit(limit, AUDIT_PAGE_LIMIT);
    try { return await listClientAudit(this.db, actor, scope, size); } catch (error) { toHttp(error); }
  }
}

@Module({ imports: [AuthModule], controllers: [ClientsController] })
export class ClientGraphModule {}
