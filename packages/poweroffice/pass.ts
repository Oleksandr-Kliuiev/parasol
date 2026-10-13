import type { PrismaClient } from '@prisma/client';
import { AtlasError } from '../core/contracts.ts';
import { MAX_PAGES, powerOfficeError } from './contracts.ts';
import type { InvoiceSummary, PowerOfficeErrorCode } from './contracts.ts';
import { powerOfficeFailure } from './authority.ts';
import { ExportAccumulator } from './export.ts';
import { bindCompletedFact, claimRecord, closeClaimSession } from './capabilities.ts';
import type { ClaimRecord, SyncClaim } from './capabilities.ts';
import { authorizePage } from './page.ts';

/**
 * One bounded export pass of a claim (docs/stage4/04_PORT_AND_SYNC.md step 2, 02 "Internal normalized DTO"). Pages are read
 * serially; before EVERY call a fresh page admission commits (page.ts), then exactly one port invocation runs outside any
 * transaction with its own AbortController and deadline min(now + 10 s, the claim's ORIGINAL local read deadline) — no
 * window is ever restarted after an await, and admission/pool/lock waits have already consumed the original 60 s.
 * Checks: the read window before the call; the deadline timer aborts an in-flight call (POWEROFFICE_DEADLINE); a result
 * that arrives after the deadline or abort is inert (also DEADLINE); a rejection is POWEROFFICE_SOURCE_FAILED. Every page is
 * validated by the accepted ExportAccumulator (strict DTO, header/company/asOf/export identity, contiguous ordinals, full
 * pages, counts, bytes, duplicate IDs) BEFORE it contributes; the first failure ends the whole pass (DTO_INVALID or
 * EXPORT_INCOMPLETE) with no partial summary. Nothing is retried, staged, persisted or logged. On every exit the
 * accumulator (page buffers, tracked IDs) is disposed and the port session closed; only a complete pass binds its detached
 * frozen summary to the claim (capabilities.ts bindCompletedFact) — the one fact publication may persist.
 */
export const PAGE_WINDOW_MS = 10_000;
export type PassOutcome = { readonly complete: true; readonly summary: InvoiceSummary } | { readonly complete: false; readonly code: PowerOfficeErrorCode };
type PageRead = { page: unknown } | { code: PowerOfficeErrorCode };

async function readOnce(record: ClaimRecord, ordinal: number): Promise<PageRead> {
  const session = record.session;
  const start = performance.now();
  if (session === null) return { code: 'POWEROFFICE_SOURCE_FAILED' };
  if (start >= record.identity.readDeadline) return { code: 'POWEROFFICE_DEADLINE' }; // the window already closed: no call
  const deadline = Math.min(start + PAGE_WINDOW_MS, record.identity.readDeadline);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'TIMEOUT'>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve('TIMEOUT'); }, Math.max(0, deadline - performance.now()));
  });
  try {
    let call: Promise<unknown>;
    try { call = Promise.resolve(record.port.readPage(session, ordinal, { signal: controller.signal, monotonicDeadline: deadline })); }
    catch (error) { call = Promise.reject(error); }
    const result = await Promise.race([call.then(page => ({ page }), () => 'FAILED' as const), timeout]);
    const late = controller.signal.aborted || performance.now() >= deadline;
    if (result === 'TIMEOUT' || late) return { code: 'POWEROFFICE_DEADLINE' }; // a late result is never used
    if (result === 'FAILED') return { code: 'POWEROFFICE_SOURCE_FAILED' };
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort(); // nothing of this invocation may continue past the pass
  }
}
const validationCode = (error: unknown): PowerOfficeErrorCode =>
  error instanceof AtlasError && error.code === 'POWEROFFICE_EXPORT_INCOMPLETE' ? 'POWEROFFICE_EXPORT_INCOMPLETE' : 'POWEROFFICE_DTO_INVALID';

/** Runs the claim's single export pass; the claim must be READING (a second pass of the same claim is CLAIM_STALE). */
export async function runExportPass(db: PrismaClient, claim: SyncClaim): Promise<PassOutcome> {
  const record = claimRecord(claim);
  if (record.phase !== 'READING') throw powerOfficeError('POWEROFFICE_CLAIM_STALE');
  const identity = record.identity;
  const fail = (code: PowerOfficeErrorCode): PassOutcome => { record.phase = 'ENDED'; return Object.freeze({ complete: false, code }); };
  let accumulator: ExportAccumulator | null = null;
  try {
    accumulator = new ExportAccumulator({ companyKey: identity.companyKey, asOf: identity.asOf });
    if (accumulator.businessDate !== identity.businessDate) return fail('POWEROFFICE_DTO_INVALID');
    for (;;) {
      const ordinal = accumulator.expectedOrdinal;
      if (ordinal > MAX_PAGES) return fail('POWEROFFICE_EXPORT_INCOMPLETE');
      try { await authorizePage(db, record); } catch (error) { return fail(powerOfficeFailure(error).code as PowerOfficeErrorCode); }
      const read = await readOnce(record, ordinal);
      if ('code' in read) return fail(read.code);
      let done: boolean;
      try { done = accumulator.accept(read.page); } catch (error) { return fail(validationCode(error)); }
      if (done) {
        const summary = accumulator.summary();
        bindCompletedFact(claim, summary); // the claim's one publishable fact; also READING → COMPLETE
        return Object.freeze({ complete: true, summary });
      }
    }
  } catch {
    return fail('UNEXPECTED_ERROR');
  } finally {
    accumulator?.dispose();
    closeClaimSession(record);
  }
}
