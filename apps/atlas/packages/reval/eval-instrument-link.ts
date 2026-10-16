import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { Channel } from './channel.ts';
import { authorize, NOT_IMPLEMENTED } from './codes.ts';
import type { FailureCode, Kind } from './codes.ts';
import { buildResponse, decodeRequest, ResponderState } from './envelope.ts';
import type { Request } from './envelope.ts';
import { encodeFrame, METADATA_FRAME_CAP, PRIVATE_FRAME_CAP } from './frame.ts';
import { instrumentPeerOk } from './eval-handoff-socket.ts';
import { decodeInstrumentHello, INSTRUMENT_WELCOME_V1 } from './eval-wire.ts';
import type { PeerFacts } from './peer.ts';

/**
 * C's measured instrument control socket (rs-c/IMPLEMENTATION_BRIEF.md §2 T1; 06 "Roles, channels and sequences"). C creates
 * `<configDir>/reval-instrument.sock` (0600 in the owner's 0700 directory). Per connection: the instrument writes its HELLO FIRST,
 * C proves the peer with the pinned helper (same euid, expected exe, a TTY, not O/C/S/E/V), greets with a fresh connectionId,
 * then serves 06 requests with the I principal: direction table first (OWNER_REQUIRED / WRONG_DIRECTION before any effect),
 * per-direction sequences from 1, fresh challenges, ONE outstanding request (OPERATION_BUSY otherwise). A closed or violated
 * connection ends; the handler learns the loss (the pair of that control connection is ended).
 */
export interface InstrumentConn { readonly connectionId: string; readonly facts: PeerFacts }
export interface InstrumentResult { readonly kind: Kind; readonly payload: unknown; readonly emitter: 'CONTROLLER' | 'SERVER' }
export interface InstrumentHandler {
  handle(conn: InstrumentConn, r: Request, received: number): Promise<InstrumentResult>;
  connected(conn: InstrumentConn): void;
  lost(conn: InstrumentConn): void;
}
export interface InstrumentDeps {
  peer(socket: Socket): Promise<PeerFacts>;
  excludedPids(): number[];
  now(): number; wallIso(): string;
}
const failure = (code: FailureCode): InstrumentResult => ({ kind: 'FAILURE', payload: { code }, emitter: 'CONTROLLER' });

export class InstrumentListener {
  readonly #path: string; readonly #registrationId: string; readonly #serverBootId: string; readonly #databaseInstanceId: string;
  readonly #deps: InstrumentDeps; readonly #handler: InstrumentHandler;
  #server: Server | null = null;
  readonly #channels = new Set<Channel>();
  constructor(path: string, binding: { registrationId: string; serverBootId: string; databaseInstanceId: string }, deps: InstrumentDeps, handler: InstrumentHandler) {
    this.#path = path; this.#registrationId = binding.registrationId; this.#serverBootId = binding.serverBootId;
    this.#databaseInstanceId = binding.databaseInstanceId; this.#deps = deps; this.#handler = handler;
  }
  async listen(): Promise<void> {
    try { if (lstatSync(this.#path).isSocket()) unlinkSync(this.#path); } catch { /* absent */ }
    const server = createServer({ allowHalfOpen: false }, socket => { void this.#accept(socket); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.#path, () => resolve()); });
    chmodSync(this.#path, 0o600);
    this.#server = server;
  }
  close(): void {
    this.#server?.close(); for (const c of this.#channels) c.close();
    try { unlinkSync(this.#path); } catch { /* gone */ }
  }
  async #accept(socket: Socket): Promise<void> {
    const channel = new Channel(socket, METADATA_FRAME_CAP);
    this.#channels.add(channel);
    let conn: InstrumentConn;
    try {
      const hello = decodeInstrumentHello(await channel.next(2000));
      const facts = await this.#deps.peer(socket);
      if (!instrumentPeerOk(facts, this.#deps.excludedPids()) || channel.closed) throw new Error('peer');
      conn = Object.freeze({ connectionId: randomUUID(), facts });
      socket.write(encodeFrame({ contractVersion: INSTRUMENT_WELCOME_V1, helloNonce: hello.helloNonce, registrationId: this.#registrationId,
        serverBootId: this.#serverBootId, connectionId: conn.connectionId }, PRIVATE_FRAME_CAP));
    } catch { channel.close(); this.#channels.delete(channel); return; }
    const state = new ResponderState({ registrationId: this.#registrationId, serverBootId: this.#serverBootId, connectionId: conn.connectionId });
    this.#handler.connected(conn);
    channel.onClose(() => { this.#channels.delete(channel); this.#handler.lost(conn); });
    const respond = (r: { challenge: string; sequence: string }, res: InstrumentResult, close = false) => {
      try { channel.send(buildResponse(state.binding, r, state.send.take(), res.emitter, this.#databaseInstanceId, res.kind, res.payload, this.#deps.wallIso())); }
      catch { /* closed */ }
      if (close) channel.close();
    };
    for (;;) {
      let value: unknown;
      try { value = await channel.next(); } catch { return; }
      const received = this.#deps.now();
      const d = decodeRequest(value);
      if (!d.ok) { if (d.addressable) respond(d.addressable, failure('PROTOCOL_INVALID'), true); else channel.close(); return; }
      const problem = state.check(d.request);
      if (problem === 'OPERATION_BUSY') { respond(d.request, failure(problem)); continue; }
      if (problem) { respond(d.request, failure(problem), true); return; }
      const refused = authorize('I', 'C', d.request.operation) ?? NOT_IMPLEMENTED[d.request.operation] ?? null;
      if (refused) { respond(d.request, failure(refused)); continue; }
      state.busy = true;
      const r = d.request;
      void this.#handler.handle(conn, r, received).catch(() => failure('INTERNAL_FAILURE')).then(res => { state.busy = false; respond(r, res); });
    }
  }
}
