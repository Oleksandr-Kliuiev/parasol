import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Module, Controller, Get, Post, Param, Body, Query, Res, UseGuards, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { CanActivate, DynamicModule, ExecutionContext } from '@nestjs/common';
import { runDemo } from '../../../fixtures/run-demo.ts';
import type { DemoResult } from '../../../fixtures/run-demo.ts';
import { scope, actor } from '../../../fixtures/gasta.ts';
import { executeTool } from '../../../packages/tools/gateway.ts';
import { contextReaders, describeTool } from '../../../packages/tools/registry.ts';
import type { ToolReaders } from '../../../packages/tools/registry.ts';
import { atlasTools } from '../../../packages/tools/composed-registry.ts';
import { fixtureM365Readers, M365_TOOL_PERMISSIONS } from '../../../packages/tools/m365.ts';
import { toolsAvailableTo } from '../../../packages/policy/tool-policy.ts';
import { envCursorKey } from '../../../packages/correlation/cursor.ts';
import { MemoryToolLedger } from '../../../packages/tools/ledger.ts';
import type { ClientContextV1 } from '../../../packages/core/contracts.ts';
import { assertWorkspacePermission, hasClientPermission, hasClientPermissions } from '../../../packages/core/contracts.ts';
import { toHttp, parseToolRequest } from './http-boundary.ts';
import { correlationHttp, correlationQuery } from './db/correlations.ts';
import type { AskMode } from '../../../packages/ask/config.ts';
import { ASK_PLANNER, MOCK_PLANNER } from '../../../packages/ask/planner.ts';
import type { AskPlanner } from '../../../packages/ask/planner.ts';
import { ASK_FIXTURE_DEMO, AskFixtureController } from './ask-fixture.ts';

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
  readonly ledger: Promise<MemoryToolLedger> = this.demo.then(d => new MemoryToolLedger(d.audit));
  /** Stage 1 readers over the demo context plus explicit fixture M365 readers (shared cursor configuration, fails closed). */
  readers(context: ClientContextV1): ToolReaders {
    return { ...contextReaders(async () => context), m365: fixtureM365Readers(async () => context, envCursorKey()) };
  }
  async check(clientId: string, eventType: string): Promise<void> {
    const allowed = actor.workspaceId === scope.workspaceId && hasClientPermission(actor, clientId, 'context:read');
    if (!allowed) {
      (await this.demo).securityAudit.append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType, outcome: 'DENIED',
        requestedClientId: clientId, reasonCode: 'SCOPE_DENIED', correlationId: randomUUID(), metadata: {} });
      throw new ForbiddenException('Client scope denied');
    }
  }
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
  /** The composed registry filtered by the demo actor's all-of permissions (Stage 1 output unchanged: no m365:read is granted). */
  @Get('tools') tools() { return toolsAvailableTo(actor, atlasTools).map(describeTool); }
  @Post('tools/execute') async execute(@Body() body: unknown, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown }) {
    const input = parseToolRequest(body);
    const correlationId = input.requestId ?? randomUUID();
    res.setHeader('x-atlas-correlation-id', correlationId);
    const { context, audit, securityAudit } = await this.service.demo;
    const requested = { workspaceId: scope.workspaceId, clientId: input.clientId };
    const sinks = { audit, securityAudit, ledger: await this.service.ledger };
    try { return (await executeTool(actor, requested, { tool: input.tool, parameters: input.parameters, correlationId }, this.service.readers(context), sinks, atlasTools)).result; }
    catch (error) { toHttp(error); }
  }
  /** Fixture counterpart of the correlation endpoint: the same all-of check (denial → security audit), an honest UNAVAILABLE envelope. */
  @Get('clients/:id/observations/:observationId/correlation') async correlation(@Param('id') id: string, @Param('observationId') observationId: string,
    @Query() query: unknown) {
    const { context, securityAudit } = await this.service.demo;
    if (actor.workspaceId !== scope.workspaceId || !hasClientPermissions(actor, id, M365_TOOL_PERMISSIONS)) {
      securityAudit.append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType: 'correlation.read_denied', outcome: 'DENIED', requestedClientId: id,
        reasonCode: 'PERMISSION_DENIED', correlationId: randomUUID(), metadata: {} });
      throw new ForbiddenException('Access denied');
    }
    try { return await this.service.readers(context).m365!.correlation(correlationQuery(query, observationId) as never); }
    catch (error) { correlationHttp(error); }
  }
}
@Module({ controllers: [AtlasController], providers: [FixtureContextService, FixtureAuthGuard] })
export class AtlasFixtureModule {
  /** Ask Atlas (docs/stage5/ask): OFF is exactly this module; MOCK adds the two Ask routes over the same demo and its audit. */
  static withAsk(mode: AskMode, planner: AskPlanner = MOCK_PLANNER): DynamicModule {
    if (mode === 'off') return { module: AtlasFixtureModule };
    // ASK-REMOTE is DB-only (docs/stage5/ask/remote/01): fixture startup with remote refuses (main.ts refuses first).
    if (mode === 'remote') throw new Error('ATLAS_ASK_MODE=remote requires ATLAS_MODE=db');
    return { module: AtlasFixtureModule, controllers: [AskFixtureController],
      providers: [{ provide: ASK_FIXTURE_DEMO, useExisting: FixtureContextService }, { provide: ASK_PLANNER, useValue: planner }] };
  }
}
