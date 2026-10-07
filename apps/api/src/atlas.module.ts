import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Module, Controller, Get, Post, Param, Body, UseGuards, Injectable, UnauthorizedException, ForbiddenException, BadRequestException, BadGatewayException, InternalServerErrorException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { runDemo } from '../../../fixtures/run-demo.ts';
import type { DemoResult } from '../../../fixtures/run-demo.ts';
import { scope, actor } from '../../../fixtures/gasta.ts';
import { executeReadTool, stage1Tools } from '../../../packages/tools/gateway.ts';
import { AtlasError, assertWorkspacePermission, hasClientPermission } from '../../../packages/core/contracts.ts';

@Injectable()
export class FixtureAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const expected = process.env.ATLAS_DEMO_TOKEN;
    if (!expected || expected.length < 20) throw new UnauthorizedException();
    const actual = request.headers.authorization ?? '';
    const a = Buffer.from(actual); const b = Buffer.from(`Bearer ${expected}`);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}

/**
 * Fixture-only context service. The single demo actor stands in for the authenticated actor of task 1.3. Scope denials
 * are recorded in the workspace security audit before the 403 is returned; the target client's audit is never touched.
 */
@Injectable()
export class FixtureContextService {
  readonly demo: Promise<DemoResult> = runDemo();
  async check(clientId: string, eventType: string): Promise<void> {
    const allowed = actor.workspaceId === scope.workspaceId && hasClientPermission(actor, clientId, 'context:read');
    if (!allowed) {
      (await this.demo).securityAudit.append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType, outcome: 'DENIED',
        requestedClientId: clientId, reasonCode: 'SCOPE_DENIED', correlationId: randomUUID(), metadata: {} });
      throw new ForbiddenException('Client scope denied');
    }
  }
}

/** Maps error kinds to HTTP without leaking internals: denial 403, bad input 400, broken upstream/contract 502, else 500. */
function toHttp(error: unknown): never {
  if (error instanceof AtlasError) {
    if (error.kind === 'SCOPE') throw new ForbiddenException('Tool denied');
    if (error.kind === 'VALIDATION') throw new BadRequestException();
    if (error.code === 'CONTEXT_SCOPE_MISMATCH' || error.code === 'CONTEXT_CONTRACT_MISMATCH' || error.kind === 'TRANSIENT') throw new BadGatewayException(error.code);
  }
  throw new InternalServerErrorException();
}

@Controller()
@UseGuards(FixtureAuthGuard)
export class AtlasController {
  constructor(private readonly service: FixtureContextService) {}
  @Get('clients') clients() { return [{ id: scope.clientId, name: 'Gasta (synthetic)' }]; }
  @Get('clients/:id/overview') async overview(@Param('id') id: string) {
    await this.service.check(id, 'client.overview_denied'); return structuredClone((await this.service.demo).context);
  }
  @Get('clients/:id/observations') async observations(@Param('id') id: string) {
    await this.service.check(id, 'client.observations_denied'); return (await this.service.demo).context.observations;
  }
  @Get('clients/:id/audit') async audit(@Param('id') id: string) {
    await this.service.check(id, 'client.audit_denied'); return (await this.service.demo).audit.list(scope);
  }
  /** Workspace-level denial log. Requires the workspace permission security_audit:read (MSP administrators). */
  @Get('audit/security') async securityAudit() {
    try { assertWorkspacePermission(actor, scope.workspaceId, 'security_audit:read'); } catch (error) { toHttp(error); }
    return (await this.service.demo).securityAudit.list(scope.workspaceId);
  }
  @Get('tools') tools() { return stage1Tools; }
  @Post('tools/execute') async execute(@Body() body: unknown) {
    if (!body || typeof body !== 'object') throw new BadRequestException();
    const input = body as Record<string, unknown>;
    // Only clientId and tool are accepted. risk, sideEffect, actor or permissions in the body are a 400, never an input.
    if (Object.keys(input).some(k => !['clientId', 'tool'].includes(k)) || typeof input.clientId !== 'string' || typeof input.tool !== 'string') throw new BadRequestException();
    const { context, audit, securityAudit } = await this.service.demo;
    const requested = { workspaceId: scope.workspaceId, clientId: input.clientId };
    try { return await executeReadTool(actor, requested, input.tool, async () => context, { audit, securityAudit }); }
    catch (error) { toHttp(error); }
  }
}
@Module({ controllers: [AtlasController], providers: [FixtureContextService, FixtureAuthGuard] })
export class AtlasFixtureModule {}
