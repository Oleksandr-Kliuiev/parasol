import { authorize, CONTROLLER_EXIT, NOT_IMPLEMENTED } from './codes.ts';
import type { FailureCode, Kind } from './codes.ts';
import { Channel } from './channel.ts';
import { BUDGET_MS } from './closure.ts';
import { bounded, DeadlineExceeded } from './deadline.ts';
import type { OwnerConfig } from './config.ts';
import type { ControllerDeps } from './deps.ts';
import { buildResponse, decodeRequest, ResponderState } from './envelope.ts';
import type { Request } from './envelope.ts';
import { FrameError, METADATA_FRAME_CAP } from './frame.ts';
import type { Digests } from './launch.ts';
import { pauseExport, reapExecutor } from './pause.ts';
import type { PauseContext } from './pause.ts';
import { parentPeerOk } from './peer.ts';
import { destroyClient } from './physical.ts';
import type { Observed, QueryClient } from './physical.ts';
import { exportSnapshot, readSnapshotWrapper, ReaderFailure, wrapperBound } from './snapshot-reader.ts';
import { fixtureCheck } from './fixture-check.ts';
import { dirname, join } from 'node:path';
import { ControllerEvaluation } from './eval-controller.ts';
import { CensusLink } from './eval-drain.ts';
import { processInventory } from './platform.ts';
import { ProofLink } from './eval-proofs.ts';
import { InstrumentListener } from './eval-instrument-link.ts';
import type { InstrumentResult } from './eval-instrument-link.ts';
import { PAIR_SECRET_V1 } from './eval-wire.ts';
import type { Snapshot } from './payloads.ts';
import type { FixtureCheckContext } from './fixture-check.ts';
import { isAbsPath, isUuid } from './scalars.ts';
import { ServerLink } from './server-link.ts';
export { productionDeps } from './deps.ts';

/**
 * The resident controller C (brief §2a): (1) platform/helper gate; (2) on O's FIRST frame, the actual Darwin peer proof of
 * O on the inherited fd 3; (3) source/build digests; (4) reader connection with physical binding; (5) a successful bound
 * snapshot wrapper (registration, binding, build) — only then (6) S per server.mode. Only the platform/helper gate (1) and
 * the peer proof (2) end with the brief's fixed local exits 10/11/12 (no response can be authenticated before them; a launch
 * env or config without a verifiable helper pin fails the helper gate). After the peer proof, a failure of (3)–(5) is an
 * authenticated FAILURE response like SNAPSHOT's — REGISTRATION_MISMATCH, the reader's own code, or DEADLINE past the first
 * budget — repeated for every implemented operation of the session, and S is never launched. Then one 06 request at a
 * time. EVERY operation (the first one including startup) has ONE absolute deadline t0 + 1800 ms: each await is bounded by
 * it, and a guard answers the operation's fixed FAILURE just before it if the work is still running. An expired operation
 * is abandoned for good: its late values are disposed (a late reader is destroyed, never assigned), it can never respond,
 * launch S or report success; only a commit-uncertain PAUSE_EXPORT latches. Each response consumes exactly one sequence.
 * O EOF cancels outstanding work at once (reader destroyed, E killed, S stopped) and exits after bounded cleanup.
 */
export function createController(deps: ControllerDeps): { run(): Promise<never> } {
  return { run: () => runController(deps) };
}
type Reader = { client: QueryClient; observed: Observed };
/** One operation: its absolute deadline (deps.now()), and whether it was answered or abandoned. */
interface Op { readonly until: number; done: boolean; expired: boolean; startup: boolean; release?: () => void }
/** The guard answers this many ms before the deadline (the frame is then delivered before 1800 ms). */
const GUARD_MARGIN_MS = 40;

async function runController(deps: ControllerDeps): Promise<never> {
  const env = deps.env;
  const configPath = env.ATLAS_REVAL_CONFIG; const connectionId = env.ATLAS_REVAL_CONNECTION_ID; const serverBootId = env.ATLAS_REVAL_SERVER_BOOT_ID;
  if (deps.platform !== 'darwin' || deps.arch !== 'arm64') return deps.exit(CONTROLLER_EXIT.PLATFORM);
  if (!isAbsPath(configPath) || !isUuid(connectionId) || !isUuid(serverBootId)) return deps.exit(CONTROLLER_EXIT.HELPER);
  let config: OwnerConfig;
  try { config = await deps.loadConfig(configPath); } catch { return deps.exit(CONTROLLER_EXIT.HELPER); }
  try { await deps.verifyHelper(config.nativePeerHelper, config.nativePeerHelperSha256); await deps.warmHelper(config.nativePeerHelper); }
  catch { return deps.exit(CONTROLLER_EXIT.HELPER); }

  const owner = new Channel(deps.ownerSocket(), METADATA_FRAME_CAP);
  let first: unknown;
  try { first = await owner.next(); } catch { return deps.exit(0); }
  const t0 = deps.now();
  // (2) O wrote: the token now names O. Exact parent, same euid, expected exe, O has a TTY, C has none, parent unchanged.
  const parent = deps.ppid();
  const facts = await deps.peer(config.nativePeerHelper, 3, deps.nodeRealpath).catch(() => null);
  if (!facts || !parentPeerOk(facts, parent) || deps.ppid() !== parent || deps.ttyAvailable()) return deps.exit(CONTROLLER_EXIT.PEER);

  // Absolute instants are kept on deps.now(); bounded() works on performance.now(): convert by the current offset.
  const abs = (until: number): number => performance.now() + (until - deps.now());
  let closing = false;
  let reader: Reader | null = null; let digests: Digests | null = null;
  let startupFailure: FailureCode | null = null; let started = false;
  let server: ServerLink | null = null;
  const bootId: string = serverBootId;
  const state = new ResponderState({ registrationId: config.registrationId, serverBootId, connectionId });
  const dropReader = (): void => { const r = reader; reader = null; if (r) void destroyClient(r.client); };
  /** A bound reader by `until`; a late connection is destroyed, never assigned; an abandoned op never assigns either. */
  async function ensureReader(op: Op, until: number): Promise<Reader> {
    if (reader) return reader;
    const secret = await bounded(deps.readSecret(config.secretFiles.reader), abs(until));
    let fresh: Reader;
    try {
      fresh = await bounded(deps.connectReader(config, secret.toString('latin1'), Math.max(1, Math.floor(until - deps.now()))), abs(until),
        late => { void destroyClient(late.client); });
    } finally { secret.fill(0); }
    if (op.done || closing || reader) { void destroyClient(fresh.client); if (reader) return reader; throw new Error('abandoned'); }
    reader = fresh; return fresh;
  }
  const bind = (w: Parameters<typeof wrapperBound>[0]) => digests !== null && wrapperBound(w, { ...config, buildManifestSha256: digests.buildManifestSha256 });
  /** (3)–(5) inside the FIRST operation's budget; S is launched only by a startup that completed in time and before EOF. */
  async function startup(op: Op): Promise<void> {
    const code = await (async (): Promise<FailureCode | null> => {
      let d: Digests;
      try { d = await bounded(deps.digests(config), abs(op.until)); } catch (e) { return op.done || e instanceof DeadlineExceeded ? 'DEADLINE' : 'REGISTRATION_MISMATCH'; }
      if (config.server.mode === 'LAUNCH' && d.apiEntry !== config.server.apiEntry) return 'REGISTRATION_MISMATCH';
      digests = d;
      let rd: Reader;
      try { rd = await ensureReader(op, op.until); } catch (e) { return op.done || e instanceof DeadlineExceeded ? 'DEADLINE' : 'REGISTRATION_MISMATCH'; }
      try {
        const w = await readSnapshotWrapper(rd.client, op.until, () => deps.now());
        if (!bind(w)) return 'REGISTRATION_MISMATCH';
      } catch (error) { return error instanceof ReaderFailure ? error.code : 'REGISTRATION_MISMATCH'; }
      return op.done || deps.now() > op.until ? 'DEADLINE' : null;
    })();
    if (started) return; // the guard already decided this startup (DEADLINE)
    started = true; startupFailure = code;
    if (code) { dropReader(); return; }
    if (!closing && config.server.mode === 'LAUNCH') {
      server = new ServerLink(deps, config, bootId, () => reader, configPath!);
      void startEvaluation().catch(() => undefined);
    }
  }
  // ---- RS-C-A: the measured instrument socket and the evaluation logic (after a successful startup only) -----------------
  type Answer = { kind: Kind; payload: unknown } | { code: FailureCode };
  let evaluation: ControllerEvaluation | null = null; let instruments: InstrumentListener | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  /** RS-D-A: the one census link of this controller (its recorded guardEpoch covers O's and I's requests alike). */
  const census = new CensusLink({ server: () => server, now: () => deps.now(), snapshot: async until => {
    const a = await snapshotAnswer({ until, done: false, expired: false, startup: false });
    return { result: toResult(a), snapshot: 'code' in a ? null : a.payload as Snapshot };
  }, inventory: until => processInventory({ server, roles: config.roles, deadline: abs(until),
    reader: async () => (await ensureReader({ until, done: false, expired: false, startup: false }, until).catch(() => null))?.client ?? null }) });
  /** RS-D-B: C's platform/privacy evidence adapters (shared by O's and I's requests). */
  const proofs = new ProofLink({ server: () => server, config, configPath: configPath!, serverBootId, wallIso: () => deps.wallIso(), deadline: until => abs(until),
    buildManifestSha256: () => digests?.buildManifestSha256 ?? null,
    reader: async until => (await ensureReader({ until, done: false, expired: false, startup: false }, until).catch(() => null))?.client ?? null });
  /** ONE operation at a time across O and every instrument connection (the reader and the S channel are shared). */
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next; };
  const toResult = (a: Answer): InstrumentResult => 'code' in a ? { kind: 'FAILURE', payload: { code: a.code }, emitter: 'CONTROLLER' }
    : { kind: a.kind, payload: a.payload, emitter: 'CONTROLLER' };
  async function startEvaluation(): Promise<void> {
    const dir = dirname(configPath!);
    const ev = new ControllerEvaluation({
      server: () => server, serialize, census, proofs, now: () => deps.now(), wallMs: () => Date.parse(deps.wallIso()), admissionId: config.admissionId, serverBootId: bootId,
      registrationId: config.registrationId,
      identity: async until => toResult(await identityAnswer({ until, done: false, expired: false, startup: false })),
      snapshot: async until => {
        const a = await snapshotAnswer({ until, done: false, expired: false, startup: false });
        return { result: toResult(a), snapshot: 'code' in a ? null : a.payload as Snapshot, completed: deps.now() };
      },
      readCurrent: async until => {
        const got = await fixture.read(until);
        return 'code' in got ? null : { fixtureId: got.w.snapshot.fixtureId as string, fixtureGeneration: got.w.snapshot.fixtureGeneration as string };
      },
    }, join(dir, 'reval-journal.jsonl'));
    const listener = new InstrumentListener(join(dir, 'reval-instrument.sock'), { registrationId: config.registrationId, serverBootId: bootId,
      databaseInstanceId: config.databaseInstanceId }, {
      peer: socket => deps.peer(config.nativePeerHelper, socket, deps.nodeRealpath),
      excludedPids: () => [process.pid, deps.ppid(), server?.pid, pause.lastChild?.pid, fixture.lastChild?.pid].filter((x): x is number => typeof x === 'number'),
      now: () => deps.now(), wallIso: () => deps.wallIso() }, ev);
    if (closing) return;
    await listener.listen();
    evaluation = ev; instruments = listener;
  }
  const pause: PauseContext = { deps, config, latched: false, spawns: 0, lastChild: null, requestSent: false,
    reread: async until => {
      const op: Op = { until, done: false, expired: false, startup: false };
      try {
        const r = await ensureReader(op, until);
        const w = await readSnapshotWrapper(r.client, until, () => deps.now());
        return bind(w) ? w : null;
      } catch { dropReader(); return null; }
    } };
  /** RS-B FIXTURE_CHECK (fixture-check.ts): bound reader snapshots around the short-lived verifier V. */
  const fixture: FixtureCheckContext = { deps, config, spawns: 0, lastChild: null,
    read: async until => {
      const op: Op = { until, done: false, expired: false, startup: false };
      try {
        const r = await ensureReader(op, until);
        const w = await readSnapshotWrapper(r.client, until, () => deps.now());
        return bind(w) ? { w } : { code: 'REGISTRATION_MISMATCH' };
      } catch (error) {
        if (error instanceof ReaderFailure) { if (error.code === 'CENSUS_UNAVAILABLE') dropReader(); return { code: error.code }; }
        dropReader(); return { code: error instanceof DeadlineExceeded ? 'DEADLINE' : 'REGISTRATION_MISMATCH' };
      }
    } };
  const reaping = new Set<Promise<boolean>>();
  const reap = (child: PauseContext['lastChild']): void => { const p = reapExecutor(child); reaping.add(p); void p.finally(() => reaping.delete(p)); };
  /** Operation work still running (an operation abandoned at its deadline finishes here; awaited, bounded, at shutdown). */
  const detached = new Set<Promise<void>>();
  /** Exactly one response per request, with exactly one send sequence; an over-cap payload becomes CENSUS_LIMIT_EXCEEDED. */
  const send = (r: { challenge: string; sequence: string }, kind: Kind, payload: unknown, closeAfter = false, emitter: 'CONTROLLER' | 'SERVER' = 'CONTROLLER'): void => {
    const seq = state.send.take();
    try {
      owner.send(buildResponse(state.binding, r, seq, emitter, config.databaseInstanceId, kind, payload, deps.wallIso()));
    } catch (error) {
      if (error instanceof FrameError) {
        try { owner.send(buildResponse(state.binding, r, seq, 'CONTROLLER', config.databaseInstanceId, 'FAILURE', { code: 'CENSUS_LIMIT_EXCEEDED' }, deps.wallIso())); }
        catch { /* closed */ }
      }
    }
    if (closeAfter) owner.close();
  };
  const reply = (op: Op, r: Request, kind: Kind, payload: unknown, emitter: 'CONTROLLER' | 'SERVER' = 'CONTROLLER'): void => {
    if (op.done || closing) return; op.done = true; send(r, kind, payload, false, emitter);
  };
  const fail = (op: Op, r: Request, code: FailureCode): void => reply(op, r, 'FAILURE', { code });
  /** The guard's answer when an operation is still running at its deadline (and what that abandonment implies). */
  const onExpired = (op: Op, r: Request): void => {
    if (op.done || closing) return;
    op.expired = true;
    let code: FailureCode = 'DEADLINE';
    if (op.startup && !started) { started = true; startupFailure = 'DEADLINE'; dropReader(); }
    else if (r.operation === 'IDENTITY') { dropReader(); server?.kill(); code = 'IDENTITY_UNVERIFIED'; }
    else if (r.operation === 'SNAPSHOT') { dropReader(); code = 'CENSUS_UNAVAILABLE'; }
    else if (r.operation === 'FIXTURE_CHECK') {
      dropReader();
      const v = fixture.lastChild; if (v && v.exitCode === null && v.signalCode === null) v.kill('SIGKILL');
      if (v) reap(v);
    }
    else if (r.operation === 'PAUSE_EXPORT') {
      dropReader();
      // After the request frame was sent a commit may happen: uncertain → latch. E is killed either way (never proof of rollback).
      if (pause.requestSent) { pause.latched = true; code = 'CONTAINMENT_UNCONFIRMED'; }
      const e = pause.lastChild; if (e && e.exitCode === null && e.signalCode === null) e.kill('SIGKILL');
      if (e) reap(e);
    }
    fail(op, r, code);
    op.release?.(); // the responder is free at once; the abandoned work finishes detached (it can no longer act)
  };

  /** IDENTITY of the measured server for O or I (re-proves S; any mismatch kills S). */
  async function identityAnswer(op: Op): Promise<Answer> {
    if (startupFailure || !digests) return { code: startupFailure ?? 'INTERNAL_FAILURE' };
    const dg: Digests = digests;
    if (!server) return { code: 'IDENTITY_UNVERIFIED' };
    const s: ServerLink = server;
    const rd = await ensureReader(op, op.until - 300).catch(() => null);
    const ok = rd !== null && await bounded(deps.recheckReader(config, rd.client, Math.max(1, Math.floor(op.until - 300 - deps.now()))), abs(op.until - 300))
      .catch(() => false);
    if (op.done) return { code: 'DEADLINE' };
    if (!ok) { dropReader(); s.kill(); return { code: 'IDENTITY_UNVERIFIED' }; }
    const problem = await s.identity(op.until - GUARD_MARGIN_MS);
    if (problem || !s.facts) return { code: problem ?? 'IDENTITY_UNVERIFIED' };
    const startedAt = new Date(s.facts.startSec * 1000 + Math.floor(s.facts.startUsec / 1000)).toISOString();
    return { kind: 'IDENTITY', payload: { databaseInstanceId: config.databaseInstanceId, buildManifestSha256: dg.buildManifestSha256,
      runtimeImageSha256: dg.runtimeImageSha256, launcherManifestSha256: dg.launcherManifestSha256, platformEvidenceRef: deps.platformRef,
      loadedBinding: 'UNVERIFIED', startedAt } };
  }
  /** One bound census snapshot for O or I. */
  async function snapshotAnswer(op: Op): Promise<Answer> {
    if (startupFailure || !digests) return { code: startupFailure ?? 'INTERNAL_FAILURE' };
    try {
      const rd = await ensureReader(op, op.until - 200);
      const w = await readSnapshotWrapper(rd.client, op.until - 50, () => deps.now());
      if (!bind(w)) return { code: 'REGISTRATION_MISMATCH' };
      return { kind: 'SNAPSHOT', payload: exportSnapshot(w, config.approvedPriceRevision) };
    } catch (error) {
      if (error instanceof ReaderFailure) { if (error.code === 'CENSUS_UNAVAILABLE') dropReader(); return { code: error.code }; }
      // A (re)connection that ran out of the operation budget is a census timeout; any other binding failure is a mismatch.
      dropReader(); return { code: error instanceof DeadlineExceeded ? 'CENSUS_UNAVAILABLE' : 'REGISTRATION_MISMATCH' };
    }
  }
  async function handle(op: Op, r: Request): Promise<void> {
    if (op.startup) await startup(op);
    if (op.done) return;
    const refused = authorize('O', 'C', r.operation);
    if (refused) return fail(op, r, refused);
    const notImplemented = NOT_IMPLEMENTED[r.operation];
    if (notImplemented) return fail(op, r, notImplemented);
    if (startupFailure || !digests) return fail(op, r, startupFailure ?? 'INTERNAL_FAILURE');
    const answer = (a: Answer, emitter: 'CONTROLLER' | 'SERVER' = 'CONTROLLER') => 'code' in a ? fail(op, r, a.code) : reply(op, r, a.kind, a.payload, emitter);
    if (r.operation === 'IDENTITY') return answer(await identityAnswer(op));
    if (r.operation === 'SNAPSHOT') return answer(await snapshotAnswer(op));
    if (r.operation === 'PLATFORM_PROOF' || r.operation === 'PRIVACY_PROOF') {
      const res = r.operation === 'PLATFORM_PROOF' ? await proofs.platform() : await proofs.privacy(op.until - GUARD_MARGIN_MS);
      return res.kind === 'FAILURE' ? fail(op, r, (res.payload as { code: FailureCode }).code) : reply(op, r, res.kind, res.payload);
    }
    if (r.operation === 'PROCESS_CENSUS' || r.operation === 'DRAIN') {
      const res = r.operation === 'DRAIN' ? await census.drain(op.until - GUARD_MARGIN_MS) : await census.census(op.until - GUARD_MARGIN_MS);
      return res.kind === 'FAILURE' ? fail(op, r, (res.payload as { code: FailureCode }).code) : reply(op, r, res.kind, res.payload, res.emitter);
    }
    if (r.operation === 'FIXTURE_CHECK') {
      const decision = await fixtureCheck(fixture, op.until - BUDGET_MS);
      evaluation?.fixtureChecked(decision.kind === 'FIXTURE_CHECK' ? decision.payload : null);
      if (decision.kind === 'FIXTURE_CHECK') reply(op, r, 'FIXTURE_CHECK', decision.payload); else fail(op, r, decision.code);
      if (!op.expired) reap(fixture.lastChild);
      return;
    }
    if (r.operation === 'PAIR' || r.operation === 'END_PAIR' || r.operation === 'TERMINAL_OBSERVATION') {
      if (!evaluation) return fail(op, r, r.operation === 'TERMINAL_OBSERVATION' ? 'OBSERVATION_UNAVAILABLE' : 'PAIR_UNAVAILABLE');
      const p = r.payload as Record<string, string>;
      if (r.operation === 'TERMINAL_OBSERVATION') { const res = await evaluation.terminal(p.armId!, op.until - GUARD_MARGIN_MS); return answer(res, res.emitter); }
      if (r.operation === 'END_PAIR') { const res = await evaluation.endPair(p.pairId!, op.until - GUARD_MARGIN_MS, null); return answer(res); }
      const res = await evaluation.ownerPair(p as { instrumentControlConnectionId: string; instrumentHandoffConnectionId: string }, op.until - GUARD_MARGIN_MS);
      if (typeof res === 'string') return fail(op, r, res);
      if (op.done || closing) return;
      reply(op, r, 'PAIR_ACK', res.ack);
      // The private secret frame on C's NEXT send sequence, echoing the owner's PAIR request (06); never a safe payload.
      try {
        owner.send({ contractVersion: PAIR_SECRET_V1, registrationId: config.registrationId, serverBootId, connectionId, sequence: state.send.take(),
          challenge: r.challenge, requestSequence: r.sequence, pairId: res.secret.pairId, instrumentControlConnectionId: p.instrumentControlConnectionId,
          instrumentHandoffConnectionId: p.instrumentHandoffConnectionId, pairingNonce: res.secret.pairingNonce, expiresAt: res.secret.expiresAt });
      } catch { /* closed */ }
      return;
    }
    // PAUSE_EXPORT
    const p = r.payload as { admissionId: string; expectedPolicyVersion: string; policyFloor: string; fenceFloor: string };
    const decision = await pauseExport(pause, p, op.until - BUDGET_MS);
    if (decision.kind === 'CLOSURE') reply(op, r, 'CLOSURE', decision.closure); else fail(op, r, decision.code);
    // Cleanup is bounded separately AFTER the response (brief §6) and never holds the responder. An abandoned operation's
    // child was already killed and reaped by the guard (lastChild may meanwhile belong to a newer operation).
    if (!op.expired) reap(pause.lastChild);
  }

  // One request at a time; a request arriving while busy gets OPERATION_BUSY (its sequence is consumed).
  const process1 = async (value: unknown, received: number, isFirst: boolean): Promise<void> => {
    const d = decodeRequest(value);
    if (!d.ok) { if (d.addressable) send(d.addressable, 'FAILURE', { code: 'PROTOCOL_INVALID' }, true); else owner.close(); return; }
    const problem = state.check(d.request);
    if (problem === 'OPERATION_BUSY') return send(d.request, 'FAILURE', { code: problem });
    if (problem) return send(d.request, 'FAILURE', { code: problem }, true);
    const op: Op = { until: received + BUDGET_MS, done: false, expired: false, startup: isFirst };
    const abandon = new Promise<void>(r => { op.release = r; });
    const guard = setTimeout(() => onExpired(op, d.request), Math.max(0, op.until - GUARD_MARGIN_MS - deps.now()));
    state.busy = true;
    const work = serialize(() => handle(op, d.request)).catch(() => fail(op, d.request, 'INTERNAL_FAILURE'));
    detached.add(work); void work.finally(() => detached.delete(work));
    try { await Promise.race([work, abandon]); } finally { clearTimeout(guard); state.busy = false; }
  };
  let current: Promise<void> = process1(first, t0, true);
  const shutdown = async (): Promise<never> => {
    closing = true;
    instruments?.close();
    dropReader();
    const child = pause.lastChild;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const verifier = fixture.lastChild;
    if (verifier && verifier.exitCode === null && verifier.signalCode === null) verifier.kill('SIGKILL');
    const stopping = server?.stop(5000);
    await bounded(Promise.all([current.catch(() => undefined), ...detached]), performance.now() + 500).catch(() => undefined);
    await Promise.all(reaping);
    await reapExecutor(child);
    await reapExecutor(verifier);
    await stopping;
    if (!started) started = true; // a startup still running can no longer launch S
    dropReader();
    return deps.exit(0);
  };
  for (;;) {
    let value: unknown;
    try { value = await owner.next(); } catch { return shutdown(); }
    const received = deps.now();
    if (state.busy) {
      const d = decodeRequest(value);
      if (!d.ok) { if (d.addressable) send(d.addressable, 'FAILURE', { code: 'PROTOCOL_INVALID' }, true); else owner.close(); continue; }
      const problem = state.check(d.request);
      send(d.request, 'FAILURE', { code: problem ?? 'OPERATION_BUSY' }, problem !== 'OPERATION_BUSY');
      continue;
    }
    await current;
    current = process1(value, received, false);
  }
}
