import { RevalBridge } from './reval/bridge.ts'; // FIRST: the bridge snapshots the controller-supplied env before any .env loader
import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AtlasFixtureModule } from './atlas.module.ts';
import { AtlasDbModule } from './db/app.module.ts';
import { connectRuntimeDatabase } from './db/database.ts';
import { prepareOperatorConsole } from './operator/console.ts';
import { allowedHostsFromEnv } from './operator/http.ts';
import { proxyIdentityFromEnv, proxyIdentityMiddleware } from './deploy/proxy-identity.ts';
import { askMode } from '../../../packages/ask/config.ts';
import { installApiParsers } from './ask-http.ts';
import { AskBudget } from '../../../packages/ask/budget.ts';
import { GuardCensus } from '../../../packages/reval/eval-census.ts';
import { bridgeRemoteSeams, composeEvaluation } from './reval/evaluation.ts';

// ATLAS_MODE=fixture (default): synthetic in-memory reference, bearer ATLAS_DEMO_TOKEN.
// ATLAS_MODE=db: PostgreSQL through the confined runtime role (ATLAS_RUNTIME_DATABASE_URL), actors and tokens from the
// database. The server listens on loopback only; ATLAS_API_PORT (default 3100) exists for parallel local test runs.
// ATLAS_OPERATOR_UI=1 adds the local operator console (apps/api/src/operator, docs/stage5): Host gate, security headers and
// /operator/ assets from dist/operator, resolved next to this compiled file. Unset or 0 leaves the API unchanged.
// ATLAS_ASK_MODE=mock adds the local synthetic Ask Atlas routes (docs/stage5/ask); unset/off adds none, anything else refuses.
// ATLAS_ASK_MODE=remote (docs/stage5/ask/remote) is DB-only: the V2 routes, gated per request by the durable workspace policy;
// it activates nothing, reads no provider secret and makes no provider call at startup. Fixture + remote refuses to start.
// Both branches disable Nest's automatic parsers: installApiParsers keeps the Host gate first, then the Ask boundary (MOCK)
// and Nest's unchanged JSON/urlencoded defaults for every non-Ask request.
// Deployment (docs/deploy/DEPLOY.md, never with the R-EVAL bridge): ATLAS_LISTEN_HOST (default 127.0.0.1; 0.0.0.0 inside a container),
// ATLAS_ALLOWED_HOSTS (extra exact Host authorities of the console gate), ATLAS_PROXY_SECRET + ATLAS_PROXY_USERS (Microsoft sign-in
// at the edge mapped to each user's own actor token, deploy/proxy-identity.ts); GET /openapi.json is served when the API runs in db mode.
// ATLAS_REVAL_BRIDGE_FD=3 (R-EVAL RS-A, set only by its controller): db mode, runtime URL from the bridge; RS-C-A: Ask REMOTE comes
// ONLY from the controller's launch frame (env Ask stays off) with the registration-lifetime gate and the evaluation handoff route.
const bridge = process.env.ATLAS_REVAL_BRIDGE_FD === undefined ? null : await RevalBridge.start();
const mode = process.env.ATLAS_MODE || 'fixture';
const port = Number(process.env.ATLAS_API_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ATLAS_API_PORT must be an integer in 1024..65535');
const ask = bridge ? 'remote' as const : askMode(process.env.ATLAS_ASK_MODE);
const listenHost = bridge ? '127.0.0.1' : process.env.ATLAS_LISTEN_HOST ?? '127.0.0.1';
if (!/^(?:127\.0\.0\.1|0\.0\.0\.0)$/.test(listenHost)) throw new Error('ATLAS_LISTEN_HOST must be 127.0.0.1 or 0.0.0.0');
const operatorConsole = await prepareOperatorConsole(process.env.ATLAS_OPERATOR_UI, port, fileURLToPath(new URL('../../../operator/', import.meta.url)),
  bridge ? [] : allowedHostsFromEnv(process.env.ATLAS_ALLOWED_HOSTS));
const proxyIdentity = bridge ? null : proxyIdentityFromEnv(process.env);
let app: INestApplication;
let evaluationGate: Awaited<ReturnType<typeof composeEvaluation>>['gate'] | undefined;
// RS-D-A: the bridge's guard census exists before the Ask module, so its no-key seams are census-wrapped and the SAME budget feeds the
// ingress and the census; ordinary processes keep a fresh AskBudget and no census, exactly as before.
const budget = new AskBudget();
const census = bridge ? new GuardCensus() : null;
if (mode === 'fixture') {
  if (ask === 'remote') throw new Error('ATLAS_ASK_MODE=remote requires ATLAS_MODE=db');
  if (!process.env.ATLAS_DEMO_TOKEN || process.env.ATLAS_DEMO_TOKEN.length < 20) throw new Error('Set ATLAS_DEMO_TOKEN to at least 20 characters');
  app = await NestFactory.create(AtlasFixtureModule.withAsk(ask), { logger: ['error', 'warn'], bodyParser: false });
} else if (mode === 'db') {
  const db = await connectRuntimeDatabase(bridge ? bridge.runtimeUrl : process.env.ATLAS_RUNTIME_DATABASE_URL);
  // RS-C-A (review F1): bridge mode composes the no-key seams; ordinary REMOTE keeps the production seams unchanged.
  app = await NestFactory.create(AtlasDbModule.forDatabase(db, ask, undefined, census ? census.wrapSeams(bridgeRemoteSeams()) : undefined),
    { logger: ['error', 'warn'], bodyParser: false });
  if (bridge && census) { census.attachOwners(budget); evaluationGate = (await composeEvaluation({ app, db, bridge, port, census })).gate; }
} else {
  throw new Error('ATLAS_MODE must be fixture or db');
}
if (operatorConsole) app.use(operatorConsole);
if (mode === 'db' && !bridge) app.use(proxyIdentityMiddleware(proxyIdentity));
installApiParsers(app, ask, budget, undefined, evaluationGate);
app.enableShutdownHooks();
if (bridge) await bridge.bindAndAwaitOpen();
await app.listen(port, listenHost);
console.log(`Atlas ${mode === 'db' ? 'PostgreSQL' : 'synthetic fixture'} API: http://${listenHost}:${port}`);
if (proxyIdentity) console.log(`Microsoft sign-in at the edge: ${proxyIdentity.users.size} provisioned user(s)`);
if (operatorConsole) console.log(`Local operator console: http://127.0.0.1:${port}/operator/`);
if (ask === 'mock') console.log('Ask Atlas: local synthetic MOCK; no external model');
if (ask === 'remote') console.log('Ask Atlas: REMOTE V2, policy-gated per request; no provider call at startup');
