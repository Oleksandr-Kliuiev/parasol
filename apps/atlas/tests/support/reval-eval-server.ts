import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { Channel } from '../../packages/reval/channel.ts';
import { loadCaseFixtures } from '../../packages/reval/eval-cases.ts';
import { TRANSFER_FRAME_CAP } from '../../packages/reval/eval-transient.ts';
import { decodeHandoffWelcome, newToken } from '../../packages/reval/eval-wire.ts';
import type { HandoffWelcome } from '../../packages/reval/eval-wire.ts';
import type { PeerFacts } from '../../packages/reval/peer.ts';
import { registerSandbox } from '../../packages/reval/register.ts';
import type { Registration } from '../../packages/reval/materialize.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { revise } from './ask-remote-pg.ts';
import { ScriptedProvider } from './ask-remote-api.ts';
import { ACTOR, CLIENT, WS, install, ownerTx, pidOf, provisionSandbox, q, registration } from './reval-fixture-pg.ts';
import { nonsuperDatabase } from './reval-nonsuper.ts';
import type { NonsuperDb } from './reval-nonsuper.ts';
import { privateDir } from './reval-test-deps.ts';

/**
 * TEST-ONLY in-process bridge server for R-EVAL RS-C-A PG tests: the BUILT production composition (dist AtlasDbModule REMOTE,
 * composeEvaluation, installApiParsers with the gate) over the registered RS-B sandbox (FX02 installed through the maintenance
 * code, policy ACTIVE), with the scripted OFFLINE provider seam and a test peer seam for the handoff socket (the test process
 * plays I; the real helper/PTY proof is covered by the process E2E). The test plays C by calling the hub's restricted operations
 * and the browser through raw HTTP with full header control. Synthetic data only; no network beyond 127.0.0.1.
 */
export interface Sandbox { ns: NonsuperDb; r: Registration; admissionId: string; policyVersion: string; tokens: { actor: string; actor2: string; other: string } }
/**
 * `singleActor` (RS-C-C): no foreign actor/membership/token, so the accepted maintenance switch (exactly one Actor row) can install
 * other fixtures later; `tokens.other` is then unusable (not stored).
 */
export async function evalSandbox(o: { singleActor?: boolean } = {}): Promise<Sandbox> {
  const ns = await nonsuperDatabase();
  try {
    await ns.admin.end(); // the switch requires every other backend gone (RS-B OTHER_WRITER_PREDICATE)
    const owner = ns.db.owner;
    const { admissionId } = await provisionSandbox(owner);
    const r = registration(admissionId, ns.db.revalReaderRole);
    const pid = await pidOf(owner);
    await registerSandbox(q(owner), r, [pid]);
    await install(owner, r, 'FX02', '0', [pid]);
    const actor = generateToken(); const actor2 = generateToken(); const other = generateToken();
    await ownerTx(owner, async () => {
      if (!o.singleActor) {
        await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, 'syn-actor-other', 'Other synthetic operator')`, [WS]);
        await owner.query(`INSERT INTO "ClientMembership" ("workspaceId", "clientId", "actorId", permissions) VALUES ($1, $2, 'syn-actor-other', $3)`,
          [WS, CLIENT, ['context:read', 'ask:remote']]);
      }
      for (const [id, a, t] of [['tok-actor', ACTOR, actor], ['tok-actor-2', ACTOR, actor2], ...(o.singleActor ? [] : [['tok-other', 'syn-actor-other', other]])] as const) {
        await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, $2, $3, $4)`, [WS, id, a, hashToken(t)]);
      }
    });
    const policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
    return { ns, r, admissionId, policyVersion, tokens: { actor, actor2, other } };
  } catch (error) { await ns.cleanup(); throw error; } // a top-level failure must not leak the throwaway database
}

export interface EvalServer {
  readonly port: number; readonly runtime: any; readonly scripted: ScriptedProvider; readonly handoffPath: string; readonly serverBootId: string;
  /** Handoff connections opened by the flow helpers (closed with the server). */
  readonly clients: HandoffClient[];
  close(): Promise<void>;
}
let nextPort = 3800 + Math.floor(Math.random() * 400);
const testFacts = (over: Partial<PeerFacts> = {}): PeerFacts => ({ pid: 999_999, pidversion: 1, euid: process.geteuid!(), ppid: 1, startSec: 1, startUsec: 0,
  hasTty: true, exeMatch: true, ...over });
/** Real frozen FX02 case IDs (S admits only the 200 frozen IDs; each server process may use each ID once). */
export const FX02_CASES: readonly string[] = [...loadCaseFixtures()].filter(([, f]) => f === 'FX02').map(([c]) => c);
/**
 * `bridgeSeams: true` composes the BUILT production bridge seams (rc2 F1: no key ever resolves) instead of the scripted provider;
 * `scripted` is then present but never called.
 */
export async function startEvalServer(s: Sandbox, o: { peer?: Partial<PeerFacts>; bridgeSeams?: boolean } = {}): Promise<EvalServer> {
  await import('reflect-metadata');
  const dist = (p: string) => import(new URL(`../../dist/apps/api/src/${p}`, import.meta.url).href);
  const [{ NestFactory }, { AtlasDbModule }, { installApiParsers }, { connectRuntimeDatabase }, { composeEvaluation, bridgeRemoteSeams }, { GuardCensus }, { AskBudget }]
    = await Promise.all([import('@nestjs/core'), dist('db/app.module.js'), dist('ask-http.js'), dist('db/database.js'), dist('reval/evaluation.js'),
      dist('../../../packages/reval/eval-census.js'), dist('../../../packages/ask/budget.js')]);
  // RS-D-A: as main.js — census-wrapped seams and ONE budget shared by the ingress and the census.
  const census = new GuardCensus(); const budget = new AskBudget(); census.attachOwners(budget);
  const dir = await privateDir('evalsrv');
  const helper = buildPeer(join(dir, 'peer'));
  const scripted = new ScriptedProvider();
  const port = ++nextPort; const serverBootId = randomUUID(); const handoffPath = join(dir, 'reval-handoff.sock');
  // As the production bridge's runtime URL (bridge.ts): S's sessions carry its fixed application_name (RS-D-A D2 admits them idle).
  const url = new URL(s.ns.db.runtimeUrl); url.searchParams.set('application_name', 'atlas-reval-s-runtime');
  const db = await connectRuntimeDatabase(url.toString());
  const app = await NestFactory.create(AtlasDbModule.forDatabase(db, 'remote', undefined, census.wrapSeams(o.bridgeSeams ? bridgeRemoteSeams() : scripted.seams())),
    { logger: false, bodyParser: false });
  let runtime: any = null;
  const bridge = { launch: { workspaceId: WS, registrationId: s.r.registrationId, databaseInstanceId: s.r.databaseInstanceId, serverBootId,
    nativePeerHelper: helper.path, nativePeerHelperSha256: helper.sha256, handoffSocketPath: handoffPath }, attach(rt: unknown) { runtime = rt; } };
  const composed = await composeEvaluation({ app, db, bridge, port, peer: async () => testFacts(o.peer), census });
  installApiParsers(app, 'remote', budget, undefined, composed.gate);
  await app.listen(port, '127.0.0.1');
  if (runtime !== composed) throw new Error('hub not attached');
  const clients: HandoffClient[] = [];
  return { port, runtime, scripted, handoffPath, serverBootId, clients,
    // RS-C-C: the runtime connection is closed too, so a following fixture switch sees no other backend.
    close: async () => { for (const c of clients) c.channel.close(); await app.close(); await db.$disconnect().catch(() => undefined); } };
}

/** The test instrument's handoff connection (HELLO first, WELCOME, then sequenced READY/ACK frames). */
export class HandoffClient {
  readonly channel: Channel; readonly welcome: HandoffWelcome; seq = 0n;
  private constructor(channel: Channel, welcome: HandoffWelcome) { this.channel = channel; this.welcome = welcome; }
  static async open(path: string, controlConnectionId = randomUUID()): Promise<HandoffClient> {
    const socket = createConnection(path); await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
    const channel = new Channel(socket, TRANSFER_FRAME_CAP);
    const helloNonce = randomUUID();
    channel.send({ contractVersion: 'RevalHandoffHelloV1', helloNonce, controlConnectionId });
    const welcome = decodeHandoffWelcome(await channel.next(3000));
    if (welcome.helloNonce !== helloNonce) throw new Error('welcome');
    return new HandoffClient(channel, welcome);
  }
  get connectionId(): string { return this.welcome.connectionId; }
  get controlConnectionId(): string { return this.welcome.controlConnectionId; }
  /** Sends `frame` with this connection's next I sequence (or an explicit one). */
  send(frame: Record<string, unknown>, sequence?: string): string { this.seq += 1n; const s = sequence ?? String(this.seq); this.channel.send({ ...frame, connectionId: this.connectionId, sequence: s }); return s; }
  next(ms = 3000): Promise<any> { return this.channel.next(ms); }
}

export interface HttpResult { status: number; headers: Record<string, string | string[] | undefined>; body: string; bodyBytes: Buffer }
/** Raw loopback POST with exact headers (fetch cannot set Host/Sec-Fetch-Site). `body: null` sends headers only and never the body. */
export function post(port: number, path: string, body: string | null, headers: Record<string, string>, method = 'POST'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, setHost: false, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c)); res.on('end', () => {
        const bodyBytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, body: bodyBytes.toString('utf8'), bodyBytes });
      });
    });
    req.on('error', reject);
    if (body === null) req.flushHeaders(); else req.end(body);
  });
}
export const browserHeaders = (port: number, bearer: string, extra: Record<string, string> = {}, length?: number): Record<string, string> => ({
  host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
  authorization: `Bearer ${bearer}`, ...(length === undefined ? {} : { 'content-length': String(length) }), ...extra });
export const askPath = `/clients/${CLIENT}/ask`;
export const handoffPath = `/clients/${CLIENT}/ask/evaluation-handoff`;
export { ACTOR, CLIENT, WS };

export interface Armed {
  readonly pairId: string; readonly sessionToken: string; readonly ho: HandoffClient; readonly arm: { armId: string; caseId: string; fixtureId: string;
    fixtureGeneration: string; admissionId: string; policyVersion: string; preSnapshotId: string; expiresAt: string };
  readonly readySequence: string; readonly pair200: any;
}
/** C installs a pair (both instrument connections live) and the browser PAIRs with the nonce (must succeed). */
export async function pairOnly(srv: EvalServer, sb: Sandbox): Promise<{ pairId: string; sessionToken: string; ho: HandoffClient; pair200: any }> {
  const ctl = randomUUID(); const ho = await HandoffClient.open(srv.handoffPath, ctl); srv.clients.push(ho);
  const nonce = newToken(); const pairId = randomUUID();
  const installed = srv.runtime.installPair({ contractVersion: 'RevalPairSecretV1', registrationId: sb.r.registrationId, serverBootId: srv.serverBootId,
    connectionId: randomUUID(), sequence: '3', challenge: randomUUID(), requestSequence: '3', pairId, instrumentControlConnectionId: ctl,
    instrumentHandoffConnectionId: ho.connectionId, pairingNonce: nonce, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  if (typeof installed === 'string') throw new Error(`install ${installed}`);
  const p = await post(srv.port, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: nonce }),
    browserHeaders(srv.port, sb.tokens.actor));
  if (p.status !== 200) throw new Error(`PAIR ${p.status} ${p.body}`);
  const pair200 = JSON.parse(p.body);
  return { pairId, sessionToken: pair200.sessionToken, ho, pair200 };
}
/** pairOnly, then C arms one case and I sends READY (every step must succeed). */
export async function pairAndArm(srv: EvalServer, sb: Sandbox, caseId = FX02_CASES[0]!): Promise<Armed> {
  const { pairId, ho, pair200 } = await pairOnly(srv, sb);
  const arm = await srv.runtime.armCase({ caseId, fixtureId: 'FX02', fixtureGeneration: '1', admissionId: sb.admissionId, policyVersion: sb.policyVersion,
    preSnapshotId: randomUUID(), browserPairId: pairId });
  if (typeof arm === 'string') throw new Error(`arm ${arm}`);
  const readySequence = ho.send({ contractVersion: 'RevalTransientReadyV1', registrationId: sb.r.registrationId, serverBootId: srv.serverBootId,
    challenge: randomUUID(), pairId, armId: arm.armId, caseId, fixtureId: arm.fixtureId, fixtureGeneration: arm.fixtureGeneration, admissionId: arm.admissionId,
    policyVersion: arm.policyVersion, preSnapshotId: arm.preSnapshotId });
  const rack = await ho.next();
  if (rack.disposition !== 'READY') throw new Error(`READY ${JSON.stringify(rack)}`);
  return { pairId, sessionToken: pair200.sessionToken, ho, arm, readySequence, pair200 };
}
/** The browser's V2 question for the armed FX02 case (focus syn-obs-b2), with the evaluation session header. */
export function question(srv: EvalServer, sb: Sandbox, a: Armed, o: { bearer?: string; observationId?: string | null; headers?: Record<string, string> } = {}) {
  const body = { contractVersion: 'AskRequestV2', requestId: randomUUID(), question: 'What needs attention for this client right now?',
    observationId: o.observationId === undefined ? 'syn-obs-b2' : o.observationId,
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: sb.admissionId, policyVersion: sb.policyVersion, questionDataClass: 'SYNTHETIC' } };
  const text = JSON.stringify(body);
  return post(srv.port, askPath, text, browserHeaders(srv.port, o.bearer ?? sb.tokens.actor, { 'x-atlas-evaluation-session': a.sessionToken, ...o.headers },
    Buffer.byteLength(text))).then(res => ({ res, body }));
}
/** The browser's RESPONSE handoff of exactly what it received (override any part to forge). */
export function respond(srv: EvalServer, sb: Sandbox, a: Armed, q: { res: HttpResult; body: unknown }, over: Record<string, unknown> = {},
  headers: Record<string, string> = {}) {
  const text = JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: a.pairId,
    receiptNonce: q.res.headers['x-atlas-evaluation-receipt'], request: q.body,
    response: { status: q.res.status, correlationId: q.res.headers['x-atlas-correlation-id'], body: JSON.parse(q.res.body) }, ...over });
  return post(srv.port, handoffPath, text, browserHeaders(srv.port, sb.tokens.actor, { 'x-atlas-evaluation-session': a.sessionToken, ...headers }));
}
