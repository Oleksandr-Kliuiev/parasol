import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { Channel } from './channel.ts';
import { encodeFrame } from './frame.ts';
import { decodeHandoffHello, HANDOFF_WELCOME_V1 } from './eval-wire.ts';
import { ACK_V1, decodeReady, READY_V1, TRANSFER_FRAME_CAP } from './eval-transient.ts';
import { ACK_WAIT_EXPIRED } from './eval-runtime.ts';
import type { EvaluationRuntime, HandoffLink } from './eval-runtime.ts';
import type { PeerFacts } from './peer.ts';

/**
 * S's measured S<->I transient socket (rs-c/IMPLEMENTATION_BRIEF.md §2 T2; 06 "Exact transient transfer"). Listens on the
 * owner-supplied path inside the owner's 0700 config directory (socket mode 0600). Each connection: the instrument writes its
 * HELLO FIRST (so the kernel token names it), S proves the peer with the pinned helper (same euid, expected exe, a TTY, not this
 * process or its parent), greets with a fresh connectionId, then accepts only sequenced READY and ACK frames (I's sequence
 * starts at 1, exactly next). Anything else, a gap/replay, an oversize frame or EOF closes the connection; losing the paired
 * connection revokes the pair. This socket is never an O/C command channel and carries no 06 envelope.
 */
export interface HandoffSocketDeps { peer(socket: Socket): Promise<PeerFacts> }
export const ACK_CAP = 8 * 1024; export const READY_CAP = 4 * 1024;
export function instrumentPeerOk(f: PeerFacts, excluded: readonly number[]): boolean {
  return f.euid === process.geteuid!() && f.exeMatch && f.hasTty && !excluded.includes(f.pid);
}

class Link implements HandoffLink {
  readonly connectionId = randomUUID();
  readonly controlConnectionId: string;
  readonly #channel: Channel;
  #send = 0n;
  /** The ONE outstanding transfer's ACK waiter (registered synchronously right after TRANSFER is sent). */
  #ackWaiter: ((v: unknown) => void) | null = null;
  constructor(channel: Channel, controlConnectionId: string) { this.#channel = channel; this.controlConnectionId = controlConnectionId; }
  send(build: (sequence: string) => Record<string, unknown>): string {
    this.#send += 1n;
    const sequence = String(this.#send);
    this.#channel.send(build(sequence));
    return sequence;
  }
  /** An ACK with no outstanding transfer (late after its deadline, or unsolicited) is dropped: it can never answer a later transfer. */
  deliverAck(frame: unknown): void { const w = this.#ackWaiter; this.#ackWaiter = null; if (w) w(frame); }
  nextAck(deadlineMono: number): Promise<unknown | typeof ACK_WAIT_EXPIRED | null> {
    if (this.#channel.closed) return Promise.resolve(null);
    return new Promise(resolve => {
      let settled = false;
      const done = (v: unknown) => { if (settled) return; settled = true; clearTimeout(t); if (this.#ackWaiter === done) this.#ackWaiter = null; resolve(v); };
      // The timer firing IS the deadline (it may fire before performance.now() reaches deadlineMono): never re-read the clock.
      const t = setTimeout(() => done(ACK_WAIT_EXPIRED), Math.max(0, deadlineMono - performance.now()));
      this.#ackWaiter = done;
      this.#channel.onClose(() => done(null));
    });
  }
  close(): void { this.#channel.close(); }
}

export class HandoffSocketServer {
  readonly #path: string; readonly #runtime: EvaluationRuntime; readonly #deps: HandoffSocketDeps; readonly #excluded: readonly number[];
  #server: Server | null = null;
  constructor(path: string, runtime: EvaluationRuntime, deps: HandoffSocketDeps, excludedPids: readonly number[]) {
    this.#path = path; this.#runtime = runtime; this.#deps = deps; this.#excluded = excludedPids;
  }
  async listen(): Promise<void> {
    try { if (lstatSync(this.#path).isSocket()) unlinkSync(this.#path); } catch { /* absent */ }
    const server = createServer({ allowHalfOpen: false }, socket => { void this.#accept(socket); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.#path, () => resolve()); });
    chmodSync(this.#path, 0o600);
    this.#server = server;
  }
  close(): void { this.#server?.close(); try { unlinkSync(this.#path); } catch { /* gone */ } }
  async #accept(socket: Socket): Promise<void> {
    const channel = new Channel(socket, TRANSFER_FRAME_CAP);
    let link: Link | null = null;
    try {
      const hello = decodeHandoffHello(await channel.next(2000));
      const facts = await this.#deps.peer(socket);
      if (!instrumentPeerOk(facts, this.#excluded) || channel.closed) throw new Error('peer');
      link = new Link(channel, hello.controlConnectionId);
      socket.write(encodeFrame({ contractVersion: HANDOFF_WELCOME_V1, helloNonce: hello.helloNonce, registrationId: this.#runtime.reg.registrationId,
        serverBootId: this.#runtime.serverBootId, connectionId: link.connectionId, controlConnectionId: hello.controlConnectionId }, READY_CAP));
      this.#runtime.connected(link);
    } catch { channel.close(); return; }
    const l = link;
    channel.onClose(() => this.#runtime.lost(l));
    let expect = 1n;
    for (;;) {
      let frame: unknown;
      try { frame = await channel.next(); } catch { return; }
      const size = Buffer.byteLength(JSON.stringify(frame) ?? '', 'utf8');
      const o = frame as Record<string, unknown>;
      if (typeof o !== 'object' || o === null || o.connectionId !== l.connectionId || o.sequence !== String(expect)) { channel.close('PROTOCOL'); return; }
      expect += 1n;
      if (o.contractVersion === READY_V1 && size <= READY_CAP) {
        let ready;
        try { ready = decodeReady(frame); } catch { channel.close('PROTOCOL'); return; }
        const d = this.#runtime.ready(l, ready);
        try { l.send(this.#runtime.readyAckFrame(l, ready, d)); } catch { return; }
      } else if (o.contractVersion === ACK_V1 && size <= ACK_CAP) l.deliverAck(frame);
      else { channel.close('PROTOCOL'); return; }
    }
  }
}
