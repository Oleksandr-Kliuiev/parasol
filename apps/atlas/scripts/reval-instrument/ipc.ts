// The instrument's two measured local connections (06 "Roles, channels and sequences"; rs-c brief §2 T1/T2; brief B §1(3)).
// Control → C at `<owner config dir>/reval-instrument.sock` (principal I: 06 envelopes, per-direction sequences from 1, fresh
// challenges, ONE outstanding request, 2 s command timeout, response meaning checked against the outstanding operation and its
// ORIGINAL producer). Handoff ↔ S at `<owner config dir>/reval-handoff.sock` (the separate transient frames only: READY out,
// READY_ACK/TRANSFER/COMMIT in; sequences enforced both ways). Both HELLOs are written first so the kernel names this process;
// C and S prove the peer with the pinned helper (same euid, node exe, a TTY). Nothing here persists or prints a frame.
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { Channel } from '../../packages/reval/channel.ts';
import type { Kind, Operation } from '../../packages/reval/codes.ts';
import { buildRequest, checkResponse, decodeResponse, Sequence } from '../../packages/reval/envelope.ts';
import type { ConnectionBinding } from '../../packages/reval/envelope.ts';
import { METADATA_FRAME_CAP } from '../../packages/reval/frame.ts';
import { TRANSFER_FRAME_CAP } from '../../packages/reval/eval-transient.ts';
import { decodeHandoffWelcome, decodeInstrumentWelcome, HANDOFF_HELLO_V1, INSTRUMENT_HELLO_V1 } from '../../packages/reval/eval-wire.ts';

export class IpcError extends Error { readonly code: string; constructor(code: string) { super(code); this.name = 'IpcError'; this.code = code; } }
const COMMAND_MS = 2000;
/** 06: the ORIGINAL producer of each response kind (FAILURE: whoever detected it). */
/** RS-D-A: PROCESS_CENSUS is S's payload forwarded by C; DRAIN is C's own composition; RS-D-B: both proofs are C's (06 emitter rules). */
export const EMITTER: Readonly<Partial<Record<Kind, 'CONTROLLER' | 'SERVER'>>> = Object.freeze({ IDENTITY: 'CONTROLLER', SNAPSHOT: 'CONTROLLER', ARM_ACK: 'SERVER',
  TERMINAL_OBSERVATION: 'SERVER', PAIR_ACK: 'SERVER', PROCESS_CENSUS: 'SERVER', DRAIN: 'CONTROLLER', PLATFORM_PROOF: 'CONTROLLER', PRIVACY_PROOF: 'CONTROLLER' });
export const EXPECTED_KIND: Readonly<Partial<Record<Operation, Kind>>> = Object.freeze({ IDENTITY: 'IDENTITY', SNAPSHOT: 'SNAPSHOT', ARM_CASE: 'ARM_ACK',
  TERMINAL_OBSERVATION: 'TERMINAL_OBSERVATION', END_PAIR: 'PAIR_ACK', PROCESS_CENSUS: 'PROCESS_CENSUS', DRAIN: 'DRAIN', PLATFORM_PROOF: 'PLATFORM_PROOF',
  PRIVACY_PROOF: 'PRIVACY_PROOF' });

async function open(path: string, cap: number): Promise<Channel> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', () => reject(new IpcError('IPC_CONNECT_FAILED'))); });
  return new Channel(socket, cap);
}

export interface Answer { readonly kind: Kind; readonly payload: unknown; readonly emitter: 'CONTROLLER' | 'SERVER' }
/** Principal I on C's measured socket. */
export class ControlClient {
  readonly binding: ConnectionBinding; readonly #channel: Channel; readonly #databaseInstanceId: string;
  readonly #send = new Sequence(); readonly #recv = new Sequence(); #busy = false;
  private constructor(channel: Channel, binding: ConnectionBinding, databaseInstanceId: string) {
    this.#channel = channel; this.binding = binding; this.#databaseInstanceId = databaseInstanceId;
  }
  static async connect(path: string, registrationId: string, databaseInstanceId: string): Promise<ControlClient> {
    const channel = await open(path, METADATA_FRAME_CAP);
    const helloNonce = randomUUID();
    channel.send({ contractVersion: INSTRUMENT_HELLO_V1, kind: 'CONTROL', helloNonce });
    let w;
    try { w = decodeInstrumentWelcome(await channel.next(COMMAND_MS)); } catch { channel.close(); throw new IpcError('IPC_WELCOME_INVALID'); }
    if (w.helloNonce !== helloNonce || w.registrationId !== registrationId) { channel.close(); throw new IpcError('IPC_WELCOME_INVALID'); }
    return new ControlClient(channel, { registrationId, serverBootId: w.serverBootId, connectionId: w.connectionId }, databaseInstanceId);
  }
  get closed(): boolean { return this.#channel.closed !== null; }
  /** One request (never two outstanding); the answer must be the operation's own kind from its original producer, or a FAILURE. */
  async request(operation: Operation, payload: Record<string, unknown>): Promise<Answer> {
    if (this.#busy) throw new IpcError('IPC_BUSY');
    if (this.closed) throw new IpcError('IPC_LOST');
    this.#busy = true;
    try {
      const out = { challenge: randomUUID(), sequence: this.#send.take(), operation };
      this.#channel.send(buildRequest(this.binding, out.challenge, out.sequence, operation, payload));
      let raw: unknown;
      try { raw = await this.#channel.next(COMMAND_MS); } catch (e) { throw new IpcError((e as { reason?: string }).reason === 'TIMEOUT' ? 'IPC_TIMEOUT' : 'IPC_LOST'); }
      let r;
      try { r = decodeResponse(raw); } catch { this.#channel.close(); throw new IpcError('IPC_PROTOCOL'); }
      const want = r.kind === 'FAILURE' ? r.emitter : EMITTER[r.kind];
      if (want === undefined || checkResponse(this.binding, this.#recv, out, r, want, this.#databaseInstanceId) !== null
        || (r.kind !== 'FAILURE' && r.kind !== EXPECTED_KIND[operation])) { this.#channel.close(); throw new IpcError('IPC_PROTOCOL'); }
      return { kind: r.kind, payload: r.payload, emitter: r.emitter };
    } finally { this.#busy = false; }
  }
  close(): void { this.#channel.close(); }
}

/** The transient S<->I connection (06 "Exact transient transfer"): own sequences both ways; frames are decoded by the caller. */
export class HandoffClient {
  readonly connectionId: string; readonly controlConnectionId: string; readonly serverBootId: string;
  readonly #channel: Channel; #sendSeq = 0n; #recvSeq = 0n;
  private constructor(channel: Channel, w: { connectionId: string; controlConnectionId: string; serverBootId: string }) {
    this.#channel = channel; this.connectionId = w.connectionId; this.controlConnectionId = w.controlConnectionId; this.serverBootId = w.serverBootId;
  }
  static async connect(path: string, control: ControlClient): Promise<HandoffClient> {
    const channel = await open(path, TRANSFER_FRAME_CAP);
    const helloNonce = randomUUID();
    channel.send({ contractVersion: HANDOFF_HELLO_V1, helloNonce, controlConnectionId: control.binding.connectionId });
    let w;
    try { w = decodeHandoffWelcome(await channel.next(COMMAND_MS)); } catch { channel.close(); throw new IpcError('IPC_WELCOME_INVALID'); }
    if (w.helloNonce !== helloNonce || w.controlConnectionId !== control.binding.connectionId || w.serverBootId !== control.binding.serverBootId
      || w.registrationId !== control.binding.registrationId) { channel.close(); throw new IpcError('IPC_WELCOME_INVALID'); }
    return new HandoffClient(channel, w);
  }
  get closed(): boolean { return this.#channel.closed !== null; }
  /** Sends `frame` with this connection's NEXT I sequence; returns that sequence. */
  send(frame: Record<string, unknown>): string {
    if (this.closed) throw new IpcError('IPC_LOST');
    this.#sendSeq += 1n; const sequence = String(this.#sendSeq);
    this.#channel.send({ ...frame, connectionId: this.connectionId, sequence });
    return sequence;
  }
  /** The next S frame by `ms`: it must carry this connection and S's exactly-next sequence (else the connection closes). */
  async next(ms: number): Promise<Record<string, unknown>> {
    let raw: unknown;
    try { raw = await this.#channel.next(Math.max(0, ms)); } catch (e) { throw new IpcError((e as { reason?: string }).reason === 'TIMEOUT' ? 'IPC_TIMEOUT' : 'IPC_LOST'); }
    const o = raw as Record<string, unknown>;
    if (typeof o !== 'object' || o === null || o.connectionId !== this.connectionId || o.sequence !== String(this.#recvSeq + 1n)) {
      this.#channel.close(); throw new IpcError('IPC_PROTOCOL');
    }
    this.#recvSeq += 1n;
    return o;
  }
  close(): void { this.#channel.close(); }
}
