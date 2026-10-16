import { parseStrictJson } from '../ask/remote/json.ts';
import { wellFormed } from './scalars.ts';

/**
 * Length-prefixed strict-UTF-8 JSON frames (brief §9): u32 big-endian body length, then exactly that many bytes. A declared
 * length over the cap is refused BEFORE any body is buffered; a zero length, invalid UTF-8, a BOM, a duplicate key at any
 * depth, a lone surrogate (from \u escapes) or trailing content refuses the frame. The 06 protocol caps frames at 256 KiB;
 * the private launch/executor frames at 4 KiB with their own decoders.
 */
export const METADATA_FRAME_CAP = 256 * 1024;
export const PRIVATE_FRAME_CAP = 4 * 1024;

export type FrameErrorCode = 'FRAME_TOO_LARGE' | 'PROTOCOL_INVALID';
export class FrameError extends Error {
  readonly code: FrameErrorCode;
  constructor(code: FrameErrorCode) { super(code); this.name = 'FrameError'; this.code = code; }
}

/** Incremental decoder of one direction of one connection. */
export class FrameDecoder {
  private buffered: Buffer[] = [];
  private size = 0;
  private need: number | null = null;
  private failed = false;
  private readonly cap: number;
  constructor(cap: number) { this.cap = cap; }
  /** Appends bytes; returns the complete frame bodies (raw bytes). Throws FrameError; after a throw the decoder stays failed. */
  push(chunk: Buffer): Buffer[] {
    if (this.failed) throw new FrameError('PROTOCOL_INVALID');
    this.buffered.push(chunk); this.size += chunk.length;
    const out: Buffer[] = [];
    for (;;) {
      if (this.need === null) {
        if (this.size < 4) break;
        const all = this.take(4);
        const length = all.readUInt32BE(0);
        if (length > this.cap) { this.failed = true; throw new FrameError('FRAME_TOO_LARGE'); }
        if (length === 0) { this.failed = true; throw new FrameError('PROTOCOL_INVALID'); }
        this.need = length;
      }
      if (this.size < this.need) break;
      out.push(this.take(this.need)); this.need = null;
    }
    return out;
  }
  /** True while bytes of a not yet complete frame (header or body) are buffered. */
  get partial(): boolean { return this.size > 0 || this.need !== null; }
  /** At end of stream: a partial header/body is a protocol violation. */
  end(): void {
    if (this.failed || this.size !== 0 || this.need !== null) { this.failed = true; throw new FrameError('PROTOCOL_INVALID'); }
  }
  private take(n: number): Buffer {
    const all = Buffer.concat(this.buffered, this.size);
    const head = all.subarray(0, n);
    const rest = all.subarray(n);
    this.buffered = rest.length > 0 ? [Buffer.from(rest)] : []; this.size = rest.length;
    return Buffer.from(head);
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Strict JSON of one frame body. Throws FrameError('PROTOCOL_INVALID') on any non-conforming byte or value. */
export function parseFrameBody(body: Buffer): unknown {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) throw new FrameError('PROTOCOL_INVALID');
  let text: string;
  try { text = UTF8.decode(body); } catch { throw new FrameError('PROTOCOL_INVALID'); }
  let value: unknown;
  try { value = parseStrictJson(text); } catch { throw new FrameError('PROTOCOL_INVALID'); }
  if (!wellFormed(value)) throw new FrameError('PROTOCOL_INVALID');
  return value;
}
/** One frame (header + UTF-8 JSON body) or FRAME_TOO_LARGE. */
export function encodeFrame(value: unknown, cap: number): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > cap) throw new FrameError('FRAME_TOO_LARGE');
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}
