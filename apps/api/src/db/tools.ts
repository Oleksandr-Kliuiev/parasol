import { Body, Controller, Get, Inject, Module, Post, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../../../../packages/core/contracts.ts';
import { executeReadTool, stage1Tools } from '../../../../packages/tools/gateway.ts';
import { getClientContext } from '../../../../packages/graph/prisma-context.ts';
import { PrismaAudit, PrismaSecurityAudit } from '../../../../packages/audit/prisma.ts';
import { toHttp, parseToolRequest } from '../http-boundary.ts';
import { PRISMA } from './database.ts';
import { AuthModule, ApiTokenGuard, CurrentActor } from './auth.ts';

/**
 * ToolsModule over PostgreSQL: the read-only gateway with database sinks. Scope denial → workspace security audit before
 * any read; unknown or write tool → client audit `tool.denied`; success/failure → client audit. Runtime input schemas,
 * versioned DTOs with parameters and ToolExecution rows are task 1.9.
 */
@Controller('tools')
@UseGuards(ApiTokenGuard)
export class ToolsController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}

  /** Registry entries the actor holds the permission for on at least one client. Risk metadata comes from the registry. */
  @Get() list(@CurrentActor() actor: Actor) {
    return stage1Tools.filter(tool => actor.memberships.some(m => m.permissions.includes(tool.permission)));
  }
  @Post('execute') async execute(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const request = parseToolRequest(body);
    const scope = { workspaceId: actor.workspaceId, clientId: request.clientId };
    const sinks = { audit: new PrismaAudit(this.db, actor), securityAudit: new PrismaSecurityAudit(this.db, actor) };
    try { return await executeReadTool(actor, scope, request.tool, () => getClientContext(this.db, actor, scope), sinks); }
    catch (error) { toHttp(error); }
  }
}

@Module({ imports: [AuthModule], controllers: [ToolsController] })
export class ToolsModule {}
