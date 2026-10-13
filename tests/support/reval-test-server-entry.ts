// TEST-ONLY server entry (R-EVAL RS-A launch test; RS-C-A composition): the BUILT API bridge library and the built API modules,
// with the Docker TCP seam instead of the unix-socket binding (production main.js has no such seam). Probes descriptors at first
// JS entry. Ask REMOTE runs exactly as main.js composes it (composeEvaluation + gate); the provider is the production seam unless
// test.json names a scripted OFFLINE provider (never a network call; the synthetic key reference resolves only here).
import { readFileSync, writeFileSync } from 'node:fs';
import { probeDescriptors } from './reval-test-deps.ts';
import type { TestTcp } from './reval-test-deps.ts';

const t0 = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as TestTcp & { serverFdProbe?: string;
  /**
   * Offline scripted provider (RS-C-A tests): every call returns this intent's envelope after `delayMs`; `hang` never settles.
   * RS-C-C: intent 'BY_QUESTION' answers each frozen question with its frozen expected intent (rehearsals across cases).
   */
  provider?: { intent?: string; delayMs?: number; hang?: boolean } };
const t = { ...t0, databaseOverride: t0.serverDatabase };
if (t.serverFdProbe) writeFileSync(t.serverFdProbe, JSON.stringify({ role: 'S', pid: process.pid, env: Object.keys(process.env).sort(), fds: probeDescriptors() }));
const dist = new URL('../../dist/apps/api/src/', import.meta.url);
await import('reflect-metadata');
const { RevalBridge } = await import(new URL('reval/bridge.js', dist).href);
const { tcpVerify } = await import('./reval-test-deps.ts');
const bridge = await RevalBridge.start(process.env, {
  readSecret: (await import('../../packages/reval/secret-file.ts')).readSecretFile,
  verify: async (l: any, password: string) => {
    const v = await tcpVerify(t, l.endpoint, l.physical, l.runtimeRole, password, 'atlas-reval-s-runtime');
    return t.forgeObservedOid ? { ...v, observed: { ...v.observed, databaseOid: t.forgeObservedOid } } : v;
  },
  runtimeUrl: (l: any, password: string) => `postgresql://${encodeURIComponent(l.runtimeRole)}:${encodeURIComponent(password)}@${t.host}:${t.port}/${l.endpoint.database}`
    + '?application_name=atlas-reval-s-runtime',
});
const { connectRuntimeDatabase } = await import(new URL('db/database.js', dist).href);
const { AtlasDbModule } = await import(new URL('db/app.module.js', dist).href);
const { installApiParsers } = await import(new URL('ask-http.js', dist).href);
const { NestFactory } = await import('@nestjs/core');
const { composeEvaluation, bridgeRemoteSeams } = await import(new URL('reval/evaluation.js', dist).href);
// RS-D-A: as main.js — the guard census exists before the Ask module (census-wrapped seams) and shares the ingress budget.
const { GuardCensus } = await import(new URL('../../../packages/reval/eval-census.js', dist).href);
const { AskBudget } = await import(new URL('../../../packages/ask/budget.js', dist).href);
const census = new GuardCensus(); const budget = new AskBudget(); census.attachOwners(budget);
let seams: unknown;
if (t0.provider) {
  const { ScriptedProvider, envelope, response } = await import('./ask-remote-api.ts');
  const scripted = new ScriptedProvider();
  scripted.hang = t0.provider.hang === true;
  let byQuestion: [string, string][] = [];
  if (t0.provider.intent === 'BY_QUESTION') {
    const { flattenCorpus, loadCorpusFiles } = await import('../../scripts/ask-remote-eval/dataset.ts');
    byQuestion = (flattenCorpus(loadCorpusFiles()) as { question: string; expectedIntent: string }[]).map(c => [JSON.stringify(c.question).slice(1, -1), c.expectedIntent]);
  }
  scripted.next = async capture => {
    await new Promise(r => setTimeout(r, t0.provider!.delayMs ?? 0));
    const intent = t0.provider!.intent === 'BY_QUESTION' ? byQuestion.find(([q]) => capture.bytes.includes(q))?.[1] ?? 'UNSUPPORTED' : t0.provider!.intent ?? 'SUMMARY';
    return response(envelope(intent));
  };
  seams = scripted.seams();
}
const port = Number(process.env.ATLAS_API_PORT);
const db = await connectRuntimeDatabase(bridge.runtimeUrl);
const app = await NestFactory.create(AtlasDbModule.forDatabase(db, 'remote', undefined, census.wrapSeams(seams ?? bridgeRemoteSeams())),
  { logger: ['error'], bodyParser: false });
const runtime = await composeEvaluation({ app, db, bridge, port, census });
installApiParsers(app, 'remote', budget, undefined, runtime.gate);
await bridge.bindAndAwaitOpen();
await app.listen(port, '127.0.0.1');
