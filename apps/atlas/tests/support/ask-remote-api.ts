import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { projectRoot } from './pg-harness.ts';
import { activate, ledger, policyRow } from './ask-remote-pg.ts';
import { CLIENT, WS, addActor, askDatabase } from './ask-pg.ts';
import type { AskDb } from './ask-pg.ts';
import { AskBudget, AskDeadline } from '../../packages/ask/budget.ts';
import { AskRun } from '../../packages/ask/service.ts';
import type { AskReply } from '../../packages/ask/service.ts';
import { RemoteCircuit } from '../../packages/ask/remote/circuit.ts';
import { dbRemotePort } from '../../packages/ask/remote/db.ts';
import { runRemoteQuestion } from '../../packages/ask/remote/service.ts';
import type { RemoteDeps } from '../../packages/ask/remote/service.ts';
import type { RemoteSeams } from '../../packages/ask/remote/secret.ts';
import type { TransportResult } from '../../packages/ask/remote/transport.ts';

/**
 * ASK-REMOTE R-B PostgreSQL test support. Synthetic disposable data only: the accepted Ask seed plus ONE synthetic ACTIVE
 * policy provisioned through the trusted fence-first routines (fixture:// secret reference, synthetic hashes of the approved
 * prompt/schema/package). The provider is ALWAYS the scripted in-process transport below (the private offline seam passed by
 * direct construction); it records the exact bytes/key it receives and returns scripted upstream results. No network, no
 * real key: KEY is a synthetic marker that must appear ONLY in the captured synthetic request.
 */
export const KEY = 'sk-synthetic-KEY-MARKER-7f3-0123456789abcdef';
export const SECRET_REF = 'fixture://ask-remote/synthetic-key-ref';
export const Q_MARKER = 'QUESTION-REMOTE-MARKER-7f3';

export function envelope(intent = 'SUMMARY', patch: (e: any) => void = () => undefined): Buffer {
  const e: any = { id: 'chatcmpl-UPSTREAM-ID-MARKER-7f3', object: 'chat.completion', created: 1, model: 'gpt-6-luna', service_tier: 'default',
    system_fingerprint: 'UPSTREAM-FP-MARKER-7f3', choices: [{ index: 0, finish_reason: 'stop', logprobs: null,
      message: { role: 'assistant', content: JSON.stringify({ version: 'AskRemoteIntentV1', intent }), refusal: null, annotations: [] } }],
    usage: { prompt_tokens: 777, completion_tokens: 9, total_tokens: 786, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } };
  patch(e);
  return Buffer.from(JSON.stringify(e), 'utf8');
}
/** ceil((777×275 + 9×825)/1000) = ceil(221100/1000) = 222 micro-USD for the default scripted usage. */
export const DEFAULT_COST = '222';
export const response = (body: Buffer, status = 200, contentType = 'application/json'): TransportResult => ({ kind: 'RESPONSE', status, contentType, body });

export interface Capture { readonly bytes: string; readonly key: string; readonly signal: AbortSignal }
/** The scripted provider: `next` decides each call's result (it may also act, e.g. revoke authority, before resolving). */
export class ScriptedProvider {
  readonly captures: Capture[] = [];
  next: (capture: Capture) => Promise<TransportResult> | TransportResult = () => response(envelope());
  /** A physical call that never settles (ignored abort): result and settlement stay pending forever. */
  hang = false;
  seams(): RemoteSeams {
    return Object.freeze({
      resolveSecret: (ref: string) => ref === SECRET_REF ? KEY : null,
      transport: (bytes: Buffer, key: string, signal: AbortSignal) => {
        const capture = { bytes: bytes.toString('utf8'), key, signal };
        this.captures.push(capture);
        if (this.hang) return { result: new Promise<TransportResult>(() => undefined), settled: new Promise<void>(() => undefined) };
        const result = Promise.resolve().then(() => this.next(capture));
        return { result, settled: result.then(() => undefined, () => undefined) };
      }
    });
  }
}

export interface RemoteDb extends AskDb {
  readonly admissionId: string; policyVersion: string; readonly tokens: Readonly<Record<'both' | 'context' | 'remote' | 'other', string>>;
}
/** Seeded Ask data + synthetic ACTIVE remote policy for demo-gasta + actors: both permissions, context only, ask:remote only, other client. */
export async function remoteDatabase(): Promise<RemoteDb> {
  const db = await askDatabase();
  const owner = db.pgdb.owner;
  const both = await addActor(owner, 'rem-both', ['context:read', 'ask:remote']);
  const context = await addActor(owner, 'rem-context', ['context:read']);
  const remote = await addActor(owner, 'rem-remote', ['ask:remote']);
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, 'rem-other-client', 'Other synthetic client')`, [WS]);
  const other = await addActor(owner, 'rem-other', ['context:read', 'ask:remote'], { client: 'rem-other-client' });
  const policy = await activate(owner, WS, [CLIENT]);
  return { ...db, admissionId: policy.admissionId, policyVersion: policy.policyVersion, tokens: { both, context, remote, other } };
}
export const currentConsent = async (owner: pg.Client) => {
  const row = (await policyRow(owner, WS))!;
  return { admissionId: row.admissionId, policyVersion: row.policyVersion };
};

export const remoteBody = (question: string, observationId: string | null, consent: { admissionId: string; policyVersion: string }, requestId = randomUUID()) =>
  ({ contractVersion: 'AskRequestV2', requestId, question, observationId,
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: consent.admissionId, policyVersion: consent.policyVersion, questionDataClass: 'SYNTHETIC' } });

/** The compiled DB API in this process (dist), ATLAS_ASK_MODE=remote, with the scripted provider seam and an observable budget. */
export interface RemoteApi { base: string; port: number; budget: any; close(): Promise<void> }
export async function remoteApi(runtimeUrl: string, seams: RemoteSeams): Promise<RemoteApi> {
  await import('reflect-metadata');
  const dist = (path: string) => import(join(projectRoot, 'dist', path));
  const [{ NestFactory }, { AtlasDbModule }, { installApiParsers }, { AskBudget: DistBudget }] = await Promise.all([
    import('@nestjs/core'), dist('apps/api/src/db/app.module.js'), dist('apps/api/src/ask-http.js'), dist('packages/ask/budget.js')]);
  const prisma = new PrismaClient({ datasourceUrl: runtimeUrl });
  const budget = new DistBudget();
  const app = await NestFactory.create(AtlasDbModule.forDatabase(prisma, 'remote', undefined, seams), { logger: false, bodyParser: false });
  installApiParsers(app, 'remote', budget);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, port, budget, close: async () => { await app.close(); } };
}

/**
 * The production orchestration and DB port (TypeScript sources) over a real runtime connection, called directly so a test
 * can give the request its own original deadline (total budget and clock). Everything below the call is production code.
 */
export interface DirectResult { reply?: AskReply; error?: unknown; run: AskRun; code?: string; json?: any }
export function directFlow(prisma: PrismaClient, seams: RemoteSeams, circuit = new RemoteCircuit()) {
  const budget = new AskBudget();
  const deps: RemoteDeps = { port: dbRemotePort(prisma), seams, circuit };
  async function ask(token: string, body: unknown, options: { totalMs?: number; clock?: () => number; clientId?: string; onRun?: (run: AskRun) => void } = {}): Promise<DirectResult> {
    const owner = budget.reserve();
    if (owner === null) throw new Error('no free owner');
    const run = new AskRun(owner, new AskDeadline(options.totalMs ?? 8000, options.clock));
    options.onRun?.(run);
    const work = runRemoteQuestion(run, deps, { authorization: `Bearer ${token}`, clientId: options.clientId ?? CLIENT, body });
    owner.hold(work.catch(() => undefined)); owner.finish();
    try {
      const reply = await work;
      let json: any = null; try { json = JSON.parse(reply.json); } catch { /* not JSON */ }
      return { reply, run, json, code: json?.code };
    } catch (error) { return { error, run }; }
  }
  return { ask, budget, deps, circuit };
}

/** Every row of every table (text), for the privacy marker scans; owner reads with RLS bypass by superuser/owner. */
export async function databaseText(owner: pg.Client): Promise<string> {
  const tables = (await owner.query(`SELECT quote_ident(relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`)).rows.map(r => r.t as string);
  let out = '';
  for (const t of tables) {
    await owner.query('BEGIN');
    try {
      await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CLIENT]);
      out += (await owner.query(`SELECT coalesce(string_agg(x::text, '|'), '') AS d FROM ${t} x`)).rows[0].d;
    } finally { await owner.query('COMMIT'); }
  }
  return out;
}
export { ledger, WS, CLIENT };
