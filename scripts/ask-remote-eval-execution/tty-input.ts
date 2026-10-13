// Pure, buffer-safe TTY input collector for the operator session. EVERY input (commands, metadata and pastes) is read with
// echo OFF: raw bytes are accumulated until a single-byte terminator — CR/LF for a line, Ctrl-D (0x04) for a paste — which
// can never occur inside a multi-byte UTF-8 sequence, so chunk boundaries never split characters. The JOINED bytes are then
// decoded once with a FATAL UTF-8 decoder (malformed input → fixed code, never U+FFFD), bracketed-paste markers are stripped
// from the joined text, backspace editing is applied and other C0 controls are dropped. Nothing is ever written back.

export const INPUT_MAX_BYTES = 300_000;
export type Collected = { readonly kind: 'VALUE'; readonly value: string } | { readonly kind: 'ABORT' } | { readonly kind: 'REJECTED'; readonly code: 'INPUT_MALFORMED_UTF8' | 'INPUT_TOO_LARGE' };

const PASTE_MARKERS = /\x1b\[20[01]~/g;
/** Decode and normalise one completed input (pure). */
export function finishInput(bytes: Buffer): Collected {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return { kind: 'REJECTED', code: 'INPUT_MALFORMED_UTF8' }; }
  const out: string[] = [];
  for (const ch of text.replace(PASTE_MARKERS, '').replace(/\r\n?/g, '\n')) {
    if (ch === '\u007f' || ch === '\b') { out.pop(); continue; }
    if (ch !== '\n' && ch !== '\t' && (ch.charCodeAt(0) < 0x20 || ch === '\u007f')) continue;
    out.push(ch);
  }
  return { kind: 'VALUE', value: out.join('') };
}

/** Feed raw chunks; returns a result once the terminator (or Ctrl-C) arrives, else null. Bytes AFTER the terminator in the
 * same chunk (type-ahead) are kept in `remainder` for the next input instead of being dropped. */
export class InputCollector {
  readonly #paste: boolean; readonly #chunks: Buffer[] = []; #bytes = 0; #overflow = false; #remainder: Buffer = Buffer.alloc(0);
  constructor(paste: boolean) { this.#paste = paste; }
  get remainder(): Buffer { return this.#remainder; }
  feed(chunk: Buffer): Collected | null {
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i]!;
      if (b === 0x03) return { kind: 'ABORT' };
      const end = this.#paste ? b === 0x04 : b === 0x0d || b === 0x0a;
      if (end) {
        this.#remainder = Buffer.from(chunk.subarray(i + 1));
        this.#push(chunk.subarray(0, i));
        if (this.#overflow) return { kind: 'REJECTED', code: 'INPUT_TOO_LARGE' };
        return finishInput(Buffer.concat(this.#chunks));
      }
    }
    this.#push(chunk);
    return null;
  }
  #push(part: Buffer): void {
    if (this.#overflow) return;
    if (this.#bytes + part.length > INPUT_MAX_BYTES) { this.#overflow = true; this.#chunks.length = 0; return; }
    this.#chunks.push(Buffer.from(part)); this.#bytes += part.length;
  }
}
