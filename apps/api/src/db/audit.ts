import { Controller, Get, Inject, Module, Query, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../../../../packages/core/contracts.ts';
import { listSecurityAudit, AUDIT_PAGE_LIMIT } from '../../../../packages/audit/prisma.ts';
import { toHttp, parseLimit } from '../http-boundary.ts';
import { PRISMA } from './database.ts';
import { AuthModule, ApiTokenGuard, AccessPolicy, CurrentActor } from './auth.ts';

/**
 * AuditModule endpoint: the workspace denial log for MSP administrators (workspace permission security_audit:read).
 * Newest first, bounded. A refused read of the log is itself recorded in it. Client audits stay under /clients/:id/audit.
 */
@Controller('audit')
@UseGuards(ApiTokenGuard)
export class SecurityAuditController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient, private readonly access: AccessPolicy) {}

  @Get('security') async security(@CurrentActor() actor: Actor, @Query('limit') limit?: unknown) {
    await this.access.requireWorkspace(actor, 'security_audit:read', 'audit.security_denied');
    const size = parseLimit(limit, AUDIT_PAGE_LIMIT);
    try { return await listSecurityAudit(this.db, actor, size); } catch (error) { toHttp(error); }
  }
}

@Module({ imports: [AuthModule], controllers: [SecurityAuditController] })
export class AuditModule {}
