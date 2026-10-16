import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AtlasError } from '../../core/contracts.ts';
import { ENDPOINT_CLASSES } from './classify.ts';

/**
 * Durable metadata receipts of the S2-LIVE pilot (operational brief RC5 §L4). A receipt is an explicit allowlist: exactly
 * these keys, each value of a fixed type/vocabulary, validated before it is written; no URL, query, header, body, token,
 * tenant, exception text or upstream value can be expressed. The file sink creates a NEW file (an existing one is never
 * overwritten) and writes + fsyncs each line before returning, so a dispatch receipt is durable before the dispatch.
 */
export const RECEIPT_VERSION = 1;
export const COMPLETION_OUTCOMES = ['RESPONDED', 'DISPATCH_FAILED', 'DISPATCH_TIMEOUT'] as const;
export const REFUSAL_REASONS = ['DESTINATION_REFUSED', 'METHOD_REFUSED', 'UNRECORDED_FETCH', 'CALLBACK_REFUSED'] as const;
export const RUN_STATUSES = ['REFUSED', 'COMMAND_ERROR', 'COMMAND_NOT_OK', 'COMMAND_OK'] as const;
export type CompletionOutcome = (typeof COMPLETION_OUTCOMES)[number];
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export type Receipt =
  | { v: 1; kind: 'run-start'; at: string; command: string }
  | { v: 1; kind: 'dispatch'; seq: number; endpointClass: string; method: string; startedAt: string }
  | { v: 1; kind: 'completion'; seq: number; endpointClass: string; method: string; httpStatus: number | null; durationMs: number; outcome: CompletionOutcome }
  | { v: 1; kind: 'refusal'; at: string; reason: RefusalReason }
  | { v: 1; kind: 'run-end'; at: string; status: RunStatus; complete: boolean; dispatches: number; completions: number; refusals: number };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COMMAND = /^[a-z][a-z0-9-]{0,31}$/;
type Check = (value: unknown) => boolean;
const int = (max: number): Check => v => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const oneOf = (values: readonly unknown[]): Check => v => values.includes(v);
const iso: Check = v => typeof v === 'string' && ISO.test(v);
const SHAPES: Readonly<Record<Receipt['kind'], Readonly<Record<string, Check>>>> = {
  'run-start': { at: iso, command: v => typeof v === 'string' && COMMAND.test(v) },
  dispatch: { seq: int(1_000_000), endpointClass: oneOf(ENDPOINT_CLASSES), method: oneOf(['GET', 'POST']), startedAt: iso },
  completion: { seq: int(1_000_000), endpointClass: oneOf(ENDPOINT_CLASSES), method: oneOf(['GET', 'POST']),
    httpStatus: v => v === null || (Number.isSafeInteger(v) && (v as number) >= 100 && (v as number) <= 599), durationMs: int(86_400_000), outcome: oneOf(COMPLETION_OUTCOMES) },
  refusal: { at: iso, reason: oneOf(REFUSAL_REASONS) },
  'run-end': { at: iso, status: oneOf(RUN_STATUSES), complete: v => typeof v === 'boolean', dispatches: int(1_000_000), completions: int(1_000_000), refusals: int(1_000_000) },
};

/** The canonical line of a receipt, or PILOT_RECEIPT_INVALID when it is not exactly the allowlisted shape. */
export function receiptLine(receipt: Receipt): string {
  const { v, kind, ...rest } = receipt as unknown as Record<string, unknown>;
  const shape = typeof kind === 'string' && Object.hasOwn(SHAPES, kind) ? SHAPES[kind as Receipt['kind']] : null;
  const keys = Object.keys(rest);
  if (v !== RECEIPT_VERSION || !shape || keys.length !== Object.keys(shape).length || keys.some(k => !Object.hasOwn(shape, k) || !shape[k]!(rest[k]))) {
    throw new AtlasError('PILOT_RECEIPT_INVALID', 'PERMANENT');
  }
  // Fixed key order: v, kind, then the shape's own order
  return `${JSON.stringify(Object.fromEntries([['v', v], ['kind', kind], ...Object.keys(shape).map(k => [k, rest[k]])]))}\n`;
}

export interface ReceiptSink { append(receipt: Receipt): void; close(): void }

/** Opens a new private file (0600); an existing path is PILOT_OUTPUT_EXISTS and stays untouched. */
export function openNewPrivateFile(path: string): number {
  if (!isAbsolute(path)) throw new AtlasError('PILOT_OUTPUT_INVALID', 'VALIDATION');
  try { return openSync(path, 'wx', 0o600); }
  catch (error) { throw new AtlasError((error as { code?: unknown }).code === 'EEXIST' ? 'PILOT_OUTPUT_EXISTS' : 'PILOT_OUTPUT_UNAVAILABLE', 'PERMANENT'); }
}
/** Writes all bytes then fsyncs; any failure throws (the caller treats it as a recording failure). */
export function writeDurably(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  fsyncSync(fd);
}

export function openFileSink(path: string): ReceiptSink {
  const fd = openNewPrivateFile(path);
  let open = true;
  return {
    append(receipt) {
      if (!open) throw new AtlasError('PILOT_RECEIPT_SINK_CLOSED', 'PERMANENT');
      writeDurably(fd, receiptLine(receipt));
    },
    close() { if (open) { open = false; closeSync(fd); } },
  };
}
