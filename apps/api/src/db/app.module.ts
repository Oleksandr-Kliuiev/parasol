import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { DatabaseModule } from './database.ts';
import { ClientGraphModule } from './clients.ts';
import { AuditModule } from './audit.ts';
import { ToolsModule } from './tools.ts';

/**
 * DB-backed API (ATLAS_MODE=db): the Stage 1 read endpoints of docs/02 over PostgreSQL through the confined runtime role.
 * Same routes and contracts as the fixture module (apps/api/src/atlas.module.ts); data, actors and audit are persistent.
 */
@Module({})
export class AtlasDbModule {
  static forDatabase(db: PrismaClient): DynamicModule {
    return { module: AtlasDbModule, imports: [DatabaseModule.forClient(db), ClientGraphModule, AuditModule, ToolsModule] };
  }
}
