import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertRuntimeRole } from '../../../../packages/graph/scoped-db.ts';

/** Injection token of the PrismaClient that connects as the confined runtime role. */
export const PRISMA = 'atlas.prisma.runtime';

/**
 * DatabaseModule (docs/02): one PrismaClient for the runtime role of prisma/roles.sql. connectRuntimeDatabase runs before
 * the HTTP server exists and refuses a connection through which RLS cannot confine client data — superuser, BYPASSRLS,
 * owner of any protected table, or a protected table without RLS (assertRuntimeRole). The owner URL (DATABASE_URL) is
 * for migrations and the synthetic seed only and is never read here.
 */
export async function connectRuntimeDatabase(url: string | undefined): Promise<PrismaClient> {
  if (!url) throw new Error('ATLAS_MODE=db needs ATLAS_RUNTIME_DATABASE_URL: the runtime role from prisma/roles.sql, never the owner');
  const db = new PrismaClient({ datasourceUrl: url });
  try { await assertRuntimeRole(db); }
  catch (error) { await db.$disconnect(); throw error; }
  return db;
}

@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}
  async onApplicationShutdown(): Promise<void> { await this.db.$disconnect(); }
}

@Global()
@Module({})
export class DatabaseModule {
  static forClient(db: PrismaClient): DynamicModule {
    return { module: DatabaseModule, global: true, providers: [{ provide: PRISMA, useValue: db }, PrismaLifecycle], exports: [PRISMA] };
  }
}
