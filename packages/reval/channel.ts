import type { Duplex } from 'node:stream';
import { encodeFrame, FrameDecoder, FrameError, parseFrameBody } from './frame.ts';

/**
 * A framed strict-JSON channel over one private AF_UNIX socket (an inherited socketpair end). Frames are queued in arrival
 * order; `next(timeoutMs)` takes exactly one. The decoder cap can switch once (private 4 KiB launch phase → 06 256 KiB
 * phase); a frame of the wrong phase fails its decoder. Any decode error, EOF or socket error closes the channel; waiters
 * then reject with ChannelClosed. Nothing is logged.
 * STRICT (the private C↔S and C↔E channels, brief §2e): every frame must be solicited — a complete frame, or even part of
 * one, that arrives while no `next()` is waiting (a duplicate/coalesced/fragmented extra HELLO, launch, request or result,
 * or any wrong-phase traffic) closes the channel with PROTOCOL synchronously inside the same `data` event, i.e. before any
 * continuation of an earlier frame can run. The phase is the RECEIVE phase: a peer's send-time order is not observable.
 */
export class ChannelClosed extends Error {
  readonly reason: 'EOF' | 'ERROR' | 'PROTOCOL' | 'FRAME_TOO_LARGE' | 'TIMEOUT' | 'LOCAL';
  constructor(reason: ChannelClosed['reason']) { super(`CHANNEL_${reason}`); this.name = 'ChannelClosed'; this.reason = reason; }
}
/** The close reasons that are protocol violations (oversize included); EOF/ERROR/TIMEOUT/LOCAL are not. */
export const isViolation = (reason: ChannelClosed['reason'] | undefined): boolean => reason === 'PROTOCOL' || reason === 'FRAME_TOO_LARGE';
export class Channel {
  private decoder: FrameDecoder;
  private readonly queue: unknown[] = [];
  private readonly waiters: { resolve(v: unknown): void; reject(e: Error): void; timer?: ReturnType<typeof setTimeout> }[] = [];
  private closedWith: ChannelClosed | null = null;
  private readonly closeHandlers: ((e: ChannelClosed) => void)[] = [];
  readonly socket: Duplex;
  private cap: number;
  private readonly strict: boolean;
  constructor(socket: Duplex, cap: number, options: { strict?: boolean } = {}) {
    this.socket = socket; this.cap = cap; this.decoder = new FrameDecoder(cap); this.strict = options.strict === true;
    socket.on('data', (chunk: Buffer) => {
      if (this.closedWith) return;
      let bodies: Buffer[];
      try {
        bodies = this.decoder.push(chunk);
        for (const b of bodies) if (!this.deliver(parseFrameBody(b))) { this.close('PROTOCOL'); return; }
        if (this.strict && this.waiters.length === 0 && this.decoder.partial) this.close('PROTOCOL');
      } catch (error) { this.close(error instanceof FrameError && error.code === 'FRAME_TOO_LARGE' ? 'FRAME_TOO_LARGE' : 'PROTOCOL'); }
    });
    socket.on('end', () => { try { this.decoder.end(); this.close('EOF'); } catch { this.close('PROTOCOL'); } });
    socket.on('error', () => this.close('ERROR'));
    socket.on('close', () => this.close('EOF'));
  }
  /** Switches the decoder cap (allowed only with no partially received frame). */
  switchCap(cap: number): void { this.cap = cap; this.decoder = new FrameDecoder(cap); }
  get closed(): ChannelClosed | null { return this.closedWith; }
  /**
   * Closed because of a protocol violation: malformed or oversize traffic, or — strict — any unsolicited (duplicate, extra,
   * partial) frame. Persistent once set (a closed channel never reopens). A peer's normal EOF/exit is NOT a violation.
   */
  violated(): boolean { return isViolation(this.closedWith?.reason); }
  onClose(fn: (e: ChannelClosed) => void): void { if (this.closedWith) fn(this.closedWith); else this.closeHandlers.push(fn); }
  /** Number of frames received but not yet taken. */
  get pending(): number { return this.queue.length; }
  next(timeoutMs?: number): Promise<unknown> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.closedWith) return Promise.reject(this.closedWith);
    return new Promise((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject };
      if (timeoutMs !== undefined) w.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new ChannelClosed('TIMEOUT')); }, Math.max(0, timeoutMs));
      this.waiters.push(w);
    });
  }
  send(value: unknown): void {
    if (this.closedWith) throw this.closedWith;
    this.socket.write(encodeFrame(value, this.cap));
  }
  /** Sends and resolves once the bytes were handed to the kernel. */
  sendAndFlush(value: unknown): Promise<void> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const frame = encodeFrame(value, this.cap);
    return new Promise((resolve, reject) => this.socket.write(frame, error => error ? reject(error) : resolve()));
  }
  close(reason: ChannelClosed['reason'] = 'LOCAL'): void {
    if (this.closedWith) return;
    this.closedWith = new ChannelClosed(reason);
    for (const w of this.waiters.splice(0)) { if (w.timer) clearTimeout(w.timer); w.reject(this.closedWith); }
    try { this.socket.destroy(); } catch { /* gone */ }
    for (const fn of this.closeHandlers.splice(0)) fn(this.closedWith);
  }
  /** false = an unsolicited frame on a strict channel (protocol violation). */
  private deliver(v: unknown): boolean {
    const w = this.waiters.shift();
    if (w) { if (w.timer) clearTimeout(w.timer); w.resolve(v); return true; }
    if (this.strict) return false;
    this.queue.push(v); return true;
  }
}
