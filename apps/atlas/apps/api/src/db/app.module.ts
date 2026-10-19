import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { DatabaseModule } from './database.ts';
import { ClientGraphModule } from './clients.ts';
import { AuditModule } from './audit.ts';
import { ToolsModule } from './tools.ts';
import { CorrelationsModule } from './correlations.ts';
import { M365OverviewModule } from './m365-overview.ts';
import { PowerOfficeModule } from './poweroffice.ts';
import { AskDbModule } from './ask.ts';
import { AskRemoteDbModule } from './ask-remote.ts';
import type { AskMode } from '../../../../packages/ask/config.ts';
import type { AskPlanner } from '../../../../packages/ask/planner.ts';
import type { RemoteSeams } from '../../../../packages/ask/remote/secret.ts';

/**
 * DB-backed API (ATLAS_MODE=db): the Stage 1 read endpoints of docs/02 over PostgreSQL through the confined runtime role.
 * Same routes and contracts as the fixture module (apps/api/src/atlas.module.ts); data, actors and audit are persistent.
 * Stage 4 adds the dedicated PowerOffice status/summary reads (poweroffice.ts; DISABLED unless ATLAS_POWEROFFICE_MODE=MOCK).
 * Stage 5 Ask Atlas (ask.ts) is composed only when ATLAS_ASK_MODE=mock; `planner` is an in-process test seam, never configuration.
 * ASK-REMOTE (ask-remote.ts) only when ATLAS_ASK_MODE=remote; `remoteSeams` is the in-process offline provider seam of tests.
 */
@Module({})
export class AtlasDbModule {
  static forDatabase(db: PrismaClient, ask: AskMode = 'off', planner?: AskPlanner, remoteSeams?: RemoteSeams): DynamicModule {
    return { module: AtlasDbModule, imports: [DatabaseModule.forClient(db), ClientGraphModule, AuditModule, ToolsModule, CorrelationsModule, M365OverviewModule, PowerOfficeModule,
      ...(ask === 'mock' ? [AskDbModule.forPlanner(planner)] : []), ...(ask === 'remote' ? [AskRemoteDbModule.forSeams(remoteSeams)] : [])] };
  }
}
