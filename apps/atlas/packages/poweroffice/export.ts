import { MAX_EXPORT_BYTES, MAX_PAGE_BYTES, MAX_TOTAL_COUNT, PAGE_SIZE, powerOfficeError } from './contracts.ts';
import type { InvoiceSummary } from './contracts.ts';
import { SummaryBuilder } from './aggregate.ts';
import { businessDate, parseUtcInstant } from './calendar.ts';
import { validatePage } from './dto.ts';
import type { ExportHeader, HeaderPins } from './dto.ts';

/**
 * Complete-bounded-export rules across pages (docs/stage4/02_CONTRACTS.md, 04_PORT_AND_SYNC.md "Manual synchronization").
 * Each page is validated strictly BEFORE it contributes; then: every page repeats the exact header of page 1, ordinals are
 * contiguous from 1, every non-final page has exactly 100 items, a final empty page only for totalCount 0 at ordinal 1, no
 * invoice ID repeats (at most 10000 tracked in private memory), the running count never exceeds totalCount and the final
 * count equals it, at most 512 KiB canonical bytes per page and 8 MiB in total. Malformed DTOs are POWEROFFICE_DTO_INVALID,
 * cross-page inconsistencies POWEROFFICE_EXPORT_INCOMPLETE. The first failure poisons the export: no partial summary is
 * ever returned and every later call refuses. On completion the exact summary is computed once (frozen, detached) and the
 * tracked IDs are released internally. dispose() ends the pass for good: an incomplete export becomes permanently failed
 * (no later page or summary, whatever its content), a completed one keeps only its frozen summary; repeating it is harmless.
 */
export class ExportAccumulator {
  readonly #pins: HeaderPins;
  readonly #businessDate: string;
  #builder: SummaryBuilder | null;
  #summary: InvoiceSummary | null = null;
  #ids = new Set<string>();
  #header: ExportHeader | null = null;
  #nextOrdinal = 1;
  #count = 0;
  #bytes = 0;
  #complete = false;
  #failed = false;

  /** Pins come from the claim: the bound synthetic company key and the claim's DB asOf (exact UTC ISO instant). */
  constructor(pins: HeaderPins) {
    const asOf = parseUtcInstant(pins.asOf);
    if (asOf === null) throw powerOfficeError('POWEROFFICE_DTO_INVALID');
    this.#pins = Object.freeze({ companyKey: pins.companyKey, asOf: pins.asOf });
    this.#businessDate = businessDate(asOf);
    this.#builder = new SummaryBuilder(this.#businessDate);
  }
  get businessDate(): string { return this.#businessDate; }
  get expectedOrdinal(): number { return this.#nextOrdinal; }
  get complete(): boolean { return this.#complete; }

  /** Validates and accepts the next page; true when it was the final one. */
  accept(raw: unknown): boolean {
    if (this.#failed || this.#complete) throw powerOfficeError('POWEROFFICE_EXPORT_INCOMPLETE');
    try { return this.#accept(raw); } catch (error) { this.#fail(); throw error; }
  }
  #accept(raw: unknown): boolean {
    const page = validatePage(raw, this.#pins);
    const incomplete = () => powerOfficeError('POWEROFFICE_EXPORT_INCOMPLETE');
    const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
    if (bytes > MAX_PAGE_BYTES || this.#bytes + bytes > MAX_EXPORT_BYTES) throw powerOfficeError('POWEROFFICE_DTO_INVALID');
    const h = page.header;
    if (this.#header !== null && (h.exportId !== this.#header.exportId || h.totalCount !== this.#header.totalCount
      || h.companyKey !== this.#header.companyKey || h.asOf !== this.#header.asOf)) throw incomplete();
    if (page.ordinal !== this.#nextOrdinal) throw incomplete();
    const n = page.items.length;
    if (page.hasMore ? n !== PAGE_SIZE : (n === 0 && !(h.totalCount === 0 && page.ordinal === 1))) throw incomplete();
    if (this.#count + n > h.totalCount || this.#count + n > MAX_TOTAL_COUNT) throw incomplete();
    if (page.hasMore ? this.#count + n >= h.totalCount : this.#count + n !== h.totalCount) throw incomplete();
    for (const item of page.items) {
      if (this.#ids.has(item.id)) throw incomplete();
      this.#ids.add(item.id);
    }
    // Only a fully verified page contributes.
    const builder = this.#builder;
    if (builder === null) throw incomplete();
    for (const item of page.items) builder.add(item);
    this.#header = h;
    this.#count += n;
    this.#bytes += bytes;
    this.#nextOrdinal++;
    if (!page.hasMore) {
      this.#summary = builder.build();
      this.#complete = true;
      this.#release();
    }
    return this.#complete;
  }
  /** The exact frozen aggregate of a COMPLETE export; refused otherwise. */
  summary(): InvoiceSummary {
    if (!this.#complete || this.#failed || this.#summary === null) throw powerOfficeError('POWEROFFICE_EXPORT_INCOMPLETE');
    return this.#summary;
  }
  /** Ends the pass: an incomplete export is failed permanently; a completed one keeps its frozen summary. Idempotent. */
  dispose(): void {
    if (!this.#complete) this.#fail();
    else this.#release();
  }
  #fail(): void { this.#failed = true; this.#summary = null; this.#release(); }
  #release(): void { this.#ids = new Set(); this.#builder = null; }
}
