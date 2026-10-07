import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Module, Post, Res, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../../../../packages/core/contracts.ts';
import { executeTool } from '../../../../packages/tools/gateway.ts';
import { describeTool } from '../../../../packages/tools/registry.ts';
import { toolsAvailableTo } from '../../../../packages/policy/tool-policy.ts';
import { PrismaToolLedger, databaseReaders } from '../../../../packages/tools/prisma-ledger.ts';
import { PrismaAudit, PrismaSecurityAudit } from '../../../../packages/audit/prisma.ts';
import { toHttp, parseToolRequest } from '../http-boundary.ts';
import { PRISMA } from './database.ts';
import { AuthModule, ApiTokenGuard, AccessPolicy, CurrentActor } from './auth.ts';

/**
 * ToolsModule over PostgreSQL: the read-only gateway with database sinks. Malformed client ID (checked here) or scope
 * denial → workspace security audit before any read; malformed, unknown or write tool, missing permission → client audit
 * `tool.denied`; parameters outside the tool's runtime schema → `tool.rejected`; an execution → ToolExecution row with its
 * audit rows. The correlation (requestId or a new one) is returned in X-Atlas-Correlation-Id, also on a refusal.
 */
@Controller('tools')
@UseGuards(ApiTokenGuard)
export class ToolsController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient, private readonly access: AccessPolicy) {}

  /** Registry entries the actor holds the permission for on at least one client, with metadata and parameter schemas. */
  @Get() list(@CurrentActor() actor: Actor) {
    return toolsAvailableTo(actor).map(describeTool);
  }
  @Post('execute') async execute(@CurrentActor() actor: Actor, @Body() body: unknown, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown }) {
    const request = parseToolRequest(body);
    const correlationId = request.requestId ?? randomUUID();
    res.setHeader('x-atlas-correlation-id', correlationId);
    await this.access.requireWellFormedClient(actor, request.clientId, 'tool.scope_denied', { tool: request.tool }, correlationId);
    const scope = { workspaceId: actor.workspaceId, clientId: request.clientId };
    const sinks = { audit: new PrismaAudit(this.db, actor), securityAudit: new PrismaSecurityAudit(this.db, actor), ledger: new PrismaToolLedger(this.db, actor) };
    try {
      const outcome = await executeTool(actor, scope, { tool: request.tool, parameters: request.parameters, correlationId }, databaseReaders(this.db, actor, scope), sinks);
      res.setHeader('x-atlas-tool-execution-id', outcome.executionId);
      return outcome.result;
    } catch (error) { toHttp(error); }
  }
}

@Module({ imports: [AuthModule], controllers: [ToolsController] })
export class ToolsModule {}
