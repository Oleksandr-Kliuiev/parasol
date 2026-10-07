import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AtlasFixtureModule } from './atlas.module.ts';
if (process.env.ATLAS_MODE && process.env.ATLAS_MODE !== 'fixture') throw new Error('Only fixture mode is implemented in this reference API');
if (!process.env.ATLAS_DEMO_TOKEN || process.env.ATLAS_DEMO_TOKEN.length < 20) throw new Error('Set ATLAS_DEMO_TOKEN to at least 20 characters');
const app = await NestFactory.create(AtlasFixtureModule, { logger: ['error', 'warn'] });
await app.listen(3100, '127.0.0.1');
console.log('Atlas synthetic fixture API: http://127.0.0.1:3100');
