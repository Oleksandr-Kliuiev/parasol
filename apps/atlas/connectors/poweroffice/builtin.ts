import { createHash } from 'node:crypto';
import { PAGE_SIZE, POWEROFFICE_CURRENCIES, SYNTHETIC_COMPANY_PATTERN, UUID_PATTERN, powerOfficeError } from '../../packages/poweroffice/contracts.ts';
import { businessDate, parseUtcInstant } from '../../packages/poweroffice/calendar.ts';
import { SCOPE_ID_PATTERN } from '../../packages/graph/scope-context.ts';
import { pageCancelled } from './contract.ts';
import type { ExportSession, PageControl, PowerOfficeExportPort, SessionPins } from './contract.ts';

/**
 * The built-in deterministic SYNTHETIC export (docs/stage4/04_PORT_AND_SYNC.md). No fetch, HTTP, socket, OAuth, secret
 * resolver, file or environment access: every page is computed in process from the session pins alone. These are invented
 * MOCK invoices, not PowerOffice data or accounting semantics.
 *
 * Data: the item count is the bound company UUID's last 12 hex digits modulo 251 (0..250, so a test fixture chooses an
 * empty, single-page or multi-page export through its synthetic company UUID). Item i is derived from SHA-256 of the
 * company key and i: UUID id, kind (1 in 8 a credit note), currency, gross, outstanding (some fully paid) and a due date
 * within ±45 days of the claim's Europe/Oslo business date. The export ID derives from the attempt; the header repeats the
 * pinned company key and asOf. Pages hold 100 items; the final page the rest; an empty export is one empty final page.
 *
 * Cancellation: an unknown/closed session, a repeated/out-of-order ordinal or a second concurrent call rejects at once
 * (the ordinal is consumed by its single invocation). The signal and the monotonic deadline are checked before work, at
 * every chunk boundary (the work yields to the event loop every 25 items) and after the work; an abort event or the
 * deadline timer rejects an in-flight call immediately, and its page is never delivered afterwards.
 */
const SIZE_MODULUS = 251;
const CHUNK = 25;
const CURRENCY_CYCLE: readonly string[] = ['NOK', 'NOK', 'NOK', 'EUR', 'USD', ...POWEROFFICE_CURRENCIES.filter(c => !['NOK', 'EUR', 'USD'].includes(c))];
const DAY_MS = 86_400_000;

interface SessionState {
  readonly pins: SessionPins; readonly exportId: string; readonly total: number; readonly businessDay: number;
  next: number; busy: boolean; closed: boolean;
}

/** Synthetic item count of a bound company key (see the module comment). */
export function syntheticInvoiceCount(companyKey: string): number {
  const match = SYNTHETIC_COMPANY_PATTERN.exec(companyKey);
  if (!match) throw powerOfficeError('POWEROFFICE_SOURCE_FAILED');
  return Number(BigInt(`0x${match[1]!.slice(-12)}`) % BigInt(SIZE_MODULUS));
}
const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
function uuidOf(bytes: Buffer): string {
  const b = Buffer.from(bytes.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const money = (minor: bigint): string => `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
const isoDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Item i of a company's synthetic export (a fresh plain object; the caller validates and copies it). */
function syntheticInvoice(companyKey: string, businessDay: number, index: number): Record<string, unknown> {
  const h = digest(`poweroffice-mock/1:${companyKey}:${index}`);
  const gross = BigInt(h.readUInt32BE(18) % 50_000_000) + 100n;
  const outstanding = h[22]! % 4 === 0 ? 0n : (gross * BigInt(h[23]! % 101)) / 100n;
  return { id: uuidOf(h), kind: h[16]! % 8 === 0 ? 'CREDIT_NOTE' : 'INVOICE', currency: CURRENCY_CYCLE[h[17]! % CURRENCY_CYCLE.length]!,
    gross: money(gross), outstanding: money(outstanding), dueDate: isoDay(businessDay + (h[24]! % 91) - 45) };
}

/** A new built-in port: its own private session registry. */
export function builtInExportPort(): PowerOfficeExportPort {
  const sessions = new WeakMap<ExportSession, SessionState>();
  const failure = () => powerOfficeError('POWEROFFICE_SOURCE_FAILED');
  return Object.freeze({
    openSession(pins: SessionPins): ExportSession {
      const asOf = parseUtcInstant(pins?.asOf);
      if (asOf === null || typeof pins.companyKey !== 'string' || !SYNTHETIC_COMPANY_PATTERN.test(pins.companyKey) || typeof pins.attemptId !== 'string'
        || !UUID_PATTERN.test(pins.attemptId) || typeof pins.connectionId !== 'string' || !SCOPE_ID_PATTERN.test(pins.connectionId)
        || !Number.isSafeInteger(pins.lifecycleVersion) || pins.lifecycleVersion < 1) throw failure();
      const [y, m, d] = businessDate(asOf).split('-').map(Number);
      const session: ExportSession = Object.freeze({ kind: 'PowerOfficeExportSession' as const });
      sessions.set(session, { pins: Object.freeze({ connectionId: pins.connectionId, companyKey: pins.companyKey, lifecycleVersion: pins.lifecycleVersion,
        attemptId: pins.attemptId, asOf: pins.asOf }), exportId: uuidOf(digest(`poweroffice-mock-export/1:${pins.attemptId}`)),
        total: syntheticInvoiceCount(pins.companyKey), businessDay: Date.UTC(y!, m! - 1, d!) / DAY_MS, next: 1, busy: false, closed: false });
      return session;
    },
    readPage(session: ExportSession, expectedOrdinal: number, control: PageControl): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const s = sessions.get(session);
        const valid = control !== null && typeof control === 'object' && control.signal instanceof AbortSignal
          && typeof control.monotonicDeadline === 'number' && Number.isFinite(control.monotonicDeadline);
        if (!s || s.closed || s.busy || !valid || expectedOrdinal !== s.next) { reject(failure()); return; }
        s.next++; // this invocation consumes the ordinal, whatever happens next: no retry of a page
        if (pageCancelled(control)) { reject(failure()); return; } // before any work
        s.busy = true;
        const { companyKey, asOf } = s.pins;
        const start = (expectedOrdinal - 1) * PAGE_SIZE;
        const stop = Math.min(start + PAGE_SIZE, s.total);
        const items: Record<string, unknown>[] = [];
        let i = start;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (page: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          control.signal.removeEventListener('abort', cancel);
          s.busy = false;
          items.length = 0;
          if (page === undefined) reject(failure()); else resolve(page);
        };
        const cancel = () => finish(undefined);
        control.signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(cancel, Math.max(0, control.monotonicDeadline - performance.now()));
        const step = () => {
          if (settled) return;
          if (s.closed || pageCancelled(control)) { cancel(); return; } // at every chunk boundary
          for (const end = Math.min(i + CHUNK, stop); i < end; i++) items.push(syntheticInvoice(companyKey, s.businessDay, i));
          if (i < stop) { setImmediate(step); return; }
          if (s.closed || pageCancelled(control)) { cancel(); return; } // after the work: a cancelled page is never delivered
          finish({ header: { synthetic: true, companyKey, exportId: s.exportId, asOf, totalCount: s.total }, ordinal: expectedOrdinal,
            items: [...items], hasMore: stop < s.total });
        };
        setImmediate(step);
      });
    },
    closeSession(session: ExportSession): void {
      const s = sessions.get(session);
      if (s) s.closed = true;
      sessions.delete(session);
    },
  });
}
