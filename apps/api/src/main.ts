import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AtlasFixtureModule } from './atlas.module.ts';
import { AtlasDbModule } from './db/app.module.ts';
import { connectRuntimeDatabase } from './db/database.ts';

// ATLAS_MODE=fixture (default): synthetic in-memory reference, bearer ATLAS_DEMO_TOKEN.
// ATLAS_MODE=db: PostgreSQL through the confined runtime role (ATLAS_RUNTIME_DATABASE_URL), actors and tokens from the
// database. The server listens on loopback only; ATLAS_API_PORT (default 3100) exists for parallel local test runs.
const mode = process.env.ATLAS_MODE || 'fixture';
const port = Number(process.env.ATLAS_API_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ATLAS_API_PORT must be an integer in 1024..65535');
let app: INestApplication;
if (mode === 'fixture') {
  if (!process.env.ATLAS_DEMO_TOKEN || process.env.ATLAS_DEMO_TOKEN.length < 20) throw new Error('Set ATLAS_DEMO_TOKEN to at least 20 characters');
  app = await NestFactory.create(AtlasFixtureModule, { logger: ['error', 'warn'] });
} else if (mode === 'db') {
  const db = await connectRuntimeDatabase(process.env.ATLAS_RUNTIME_DATABASE_URL);
  app = await NestFactory.create(AtlasDbModule.forDatabase(db), { logger: ['error', 'warn'] });
} else {
  throw new Error('ATLAS_MODE must be fixture or db');
}
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Atlas ${mode === 'db' ? 'PostgreSQL' : 'synthetic fixture'} API: http://127.0.0.1:${port}`);
