import { randomUUID } from 'node:crypto';
import { createParamDecorator, ForbiddenException, Inject, Injectable, Module, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../../../../packages/core/contracts.ts';
import { assertPermission, assertWorkspacePermission, safeErrorCode } from '../../../../packages/core/contracts.ts';
import { authenticateToken } from '../../../../packages/auth/prisma-auth.ts';
import { parseBearerToken } from '../../../../packages/auth/token.ts';
import { PrismaSecurityAudit } from '../../../../packages/audit/prisma.ts';
import { PRISMA } from './database.ts';

interface AtlasRequest { headers: { authorization?: string }; atlasActor?: Actor }

/** AuthModule: bearer token → verified Actor from the database. Missing, malformed or unknown credentials are a bare 401. */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AtlasRequest>();
    const token = parseBearerToken(request.headers.authorization);
    const actor = token === null ? null : await authenticateToken(this.db, token);
    if (!actor) throw new UnauthorizedException();
    request.atlasActor = actor;
    return true;
  }
}

/** The actor ApiTokenGuard verified for this request. Never taken from the body, a header field or a model. */
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext): Actor => {
  const actor = context.switchToHttp().getRequest<AtlasRequest>().atlasActor;
  if (!actor) throw new UnauthorizedException();
  return actor;
});

/**
 * Deterministic access decision before any read. The client is resolved inside the actor's own workspace, never from the
 * request. A denial is written to the workspace SecurityAuditEvent (the requested client ID as plain text) before the
 * 403, and the answer is the same for a forbidden and a non-existent client, so existence outside the scope stays hidden.
 */
@Injectable()
export class AccessPolicy {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}
  async requireClient(actor: Actor, clientId: string, permission: string, eventType: string): Promise<Scope> {
    const scope = { workspaceId: actor.workspaceId, clientId };
    try { assertPermission(actor, scope, permission); return scope; }
    catch (error) { return this.deny(actor, eventType, clientId, safeErrorCode(error)); }
  }
  async requireWorkspace(actor: Actor, permission: string, eventType: string): Promise<void> {
    try { assertWorkspacePermission(actor, actor.workspaceId, permission); }
    catch (error) { await this.deny(actor, eventType, null, safeErrorCode(error)); }
  }
  async deny(actor: Actor, eventType: string, requestedClientId: string | null, reasonCode: string): Promise<never> {
    await new PrismaSecurityAudit(this.db, actor).append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType, outcome: 'DENIED',
      requestedClientId, reasonCode, correlationId: randomUUID(), metadata: {} });
    throw new ForbiddenException('Access denied');
  }
}

@Module({ providers: [ApiTokenGuard, AccessPolicy], exports: [ApiTokenGuard, AccessPolicy] })
export class AuthModule {}
