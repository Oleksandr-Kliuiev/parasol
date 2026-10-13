import { AtlasError } from '../core/contracts.ts';
import type { ErrorKind } from '../core/contracts.ts';

/**
 * Stage 4 PowerOffice MOCK contracts (docs/stage4/02_CONTRACTS.md). Atlas-normalized DTOs, fixed codes and bounds only:
 * these are not vendor wire schemas. S4-A defines the vocabulary, strict validation, exact arithmetic, schema/roles and the
 * private bearer authority foundation; sync/publication/recovery (S4-B) and reads/API/CLI/maintenance admission (S4-C)
 * come later.
 */
/** Same-client permissions (ClientMembership vocabulary, migration 202610091200), never assigned automatically. */
export const CONTEXT_READ = 'context:read';
export const POWEROFFICE_READ = 'poweroffice:read';
export const POWEROFFICE_SYNC = 'poweroffice:sync';
export const POWEROFFICE_MAINTAIN = 'poweroffice:maintain';
export type PowerOfficeOperation = 'read' | 'sync' | 'recover' | 'maintain';
/** All-of on ONE membership of the chosen client (never merged across memberships, no workspace-admin shortcut). */
export const POWEROFFICE_PERMISSIONS: Readonly<Record<PowerOfficeOperation, readonly string[]>> = Object.freeze({
  read: Object.freeze([CONTEXT_READ, POWEROFFICE_READ]),
  sync: Object.freeze([CONTEXT_READ, POWEROFFICE_READ, POWEROFFICE_SYNC]),
  recover: Object.freeze([CONTEXT_READ, POWEROFFICE_READ, POWEROFFICE_SYNC]),
  maintain: Object.freeze([CONTEXT_READ, POWEROFFICE_READ, POWEROFFICE_MAINTAIN]),
});

/** Fixed domain codes (02 "Public interface"). No value, body, SQL diagnostic or vendor message ever follows. */
export const POWEROFFICE_ERROR_CODES = [
  'POWEROFFICE_DISABLED', 'POWEROFFICE_MODE_UNSUPPORTED', 'POWEROFFICE_AUTHENTICATION_FAILED', 'SCOPE_DENIED', 'PERMISSION_DENIED',
  'POWEROFFICE_CONNECTION_UNAVAILABLE', 'POWEROFFICE_BINDING_CHANGED', 'POWEROFFICE_DTO_INVALID', 'POWEROFFICE_EXPORT_INCOMPLETE',
  'POWEROFFICE_SOURCE_FAILED', 'POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_SYNC_LIMIT', 'POWEROFFICE_DEADLINE', 'POWEROFFICE_RECOVERY_NOT_DUE',
  'POWEROFFICE_CLAIM_STALE', 'POWEROFFICE_AUDIT_FAILED', 'POWEROFFICE_DB_CONFLICT', 'POWEROFFICE_PUBLICATION_CONFLICT', 'POWEROFFICE_NOT_FOUND',
  'POWEROFFICE_SNAPSHOT_EXPIRED', 'POWEROFFICE_SNAPSHOT_STALE', 'POWEROFFICE_RUNTIME_NOT_READY', 'POWEROFFICE_NO_ACTIVE_ATTEMPT',
  'POWEROFFICE_CLEANUP_TIMEOUT', 'POWEROFFICE_CLEANUP_FAILED', 'INVALID_ARGUMENTS', 'UNEXPECTED_ERROR',
] as const;
export type PowerOfficeErrorCode = typeof POWEROFFICE_ERROR_CODES[number];
/**
 * Codes that may close a claim (FAILED/ABANDONED) and therefore appear as lastAttempt/lastCompleted codes. Same list as the
 * CHECKs of migration 202610091200.
 */
export const POWEROFFICE_ATTEMPT_CODES: readonly PowerOfficeErrorCode[] = [
  'POWEROFFICE_AUTHENTICATION_FAILED', 'SCOPE_DENIED', 'PERMISSION_DENIED', 'POWEROFFICE_DISABLED', 'POWEROFFICE_MODE_UNSUPPORTED',
  'POWEROFFICE_CONNECTION_UNAVAILABLE', 'POWEROFFICE_BINDING_CHANGED', 'POWEROFFICE_DTO_INVALID', 'POWEROFFICE_EXPORT_INCOMPLETE',
  'POWEROFFICE_SOURCE_FAILED', 'POWEROFFICE_DEADLINE', 'POWEROFFICE_CLAIM_STALE', 'POWEROFFICE_PUBLICATION_CONFLICT', 'UNEXPECTED_ERROR',
];
const KINDS: Partial<Record<PowerOfficeErrorCode, ErrorKind>> = {
  POWEROFFICE_AUTHENTICATION_FAILED: 'SCOPE', SCOPE_DENIED: 'SCOPE', PERMISSION_DENIED: 'SCOPE', POWEROFFICE_NOT_FOUND: 'SCOPE',
  POWEROFFICE_DTO_INVALID: 'VALIDATION', POWEROFFICE_EXPORT_INCOMPLETE: 'VALIDATION', INVALID_ARGUMENTS: 'VALIDATION',
  POWEROFFICE_SYNC_BUSY: 'CONFLICT', POWEROFFICE_DB_CONFLICT: 'CONFLICT', POWEROFFICE_PUBLICATION_CONFLICT: 'CONFLICT',
  POWEROFFICE_CLAIM_STALE: 'CONFLICT', POWEROFFICE_RECOVERY_NOT_DUE: 'CONFLICT',
  POWEROFFICE_SOURCE_FAILED: 'TRANSIENT', POWEROFFICE_DEADLINE: 'TRANSIENT', POWEROFFICE_CLEANUP_TIMEOUT: 'TRANSIENT',
};
/** A fixed PowerOffice error: code only, never details (no echo of inputs through AtlasError.details). */
export function powerOfficeError(code: PowerOfficeErrorCode): AtlasError {
  return new AtlasError(code, KINDS[code] ?? 'PERMANENT');
}
const FIXED = new Set<string>(POWEROFFICE_ERROR_CODES);
export const isPowerOfficeErrorCode = (code: unknown): code is PowerOfficeErrorCode => typeof code === 'string' && FIXED.has(code);

/** Currencies of the normalized MOCK export, in lexical order. No conversion or inference. */
export const POWEROFFICE_CURRENCIES = ['DKK', 'EUR', 'GBP', 'NOK', 'SEK', 'USD'] as const;
export type PowerOfficeCurrency = typeof POWEROFFICE_CURRENCIES[number];
export type InvoiceKind = 'INVOICE' | 'CREDIT_NOTE';
export type AttemptState = 'ACTIVE' | 'SUCCEEDED' | 'FAILED' | 'ABANDONED';

/** Export bounds (02 "Internal normalized DTO"). */
export const MAX_TOTAL_COUNT = 10_000;
export const MAX_PAGES = 100;
export const PAGE_SIZE = 100;
export const MAX_PAGE_BYTES = 512 * 1024;
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
/** Input amounts: at most 15 integer digits; aggregate sums: at most 19. Always exactly 2 fractional digits. */
export const AMOUNT_INTEGER_DIGITS = 15;
export const SUM_INTEGER_DIGITS = 19;
/** Freshness and lifetime (01 "Freshness and retention", 03 tables). */
export const FRESH_MS = 15 * 60_000;
export const SNAPSHOT_TTL_MS = 24 * 60 * 60_000;
export const READ_WINDOW_MS = 60_000;
export const CLAIM_WINDOW_MS = 80_000;
export const RETAINED_ATTEMPT_LIMIT = 1000;
export const CLEANUP_ROW_LIMIT = 1000;
/** IANA zone of the business date (tzdata via Intl/PostgreSQL, never the runtime's local zone). */
export const BUSINESS_TIME_ZONE = 'Europe/Oslo';

/** Fixed synthetic binding (02): externalTenantId and secretRef carry the same lower-case UUID. Never resolved. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UUID_PATTERN = new RegExp(`^${UUID}$`);
export const SYNTHETIC_COMPANY_PATTERN = new RegExp(`^synthetic-po-(${UUID})$`);
export const SYNTHETIC_SECRET_REF_PATTERN = new RegExp(`^fixture://poweroffice/(${UUID})$`);

/** The exact aggregate object (02): {totalCount, currencies[]} with exactly these group fields. */
export interface CurrencyGroup {
  readonly currency: PowerOfficeCurrency; readonly count: number; readonly openInvoiceCount: number; readonly overdueInvoiceCount: number;
  readonly creditNoteCount: number; readonly outstandingInvoiceAmount: string; readonly outstandingCreditAmount: string;
}
export interface InvoiceSummary { readonly totalCount: number; readonly currencies: readonly CurrencyGroup[] }
export const CURRENCY_GROUP_KEYS: readonly (keyof CurrencyGroup)[] = ['currency', 'count', 'openInvoiceCount', 'overdueInvoiceCount', 'creditNoteCount',
  'outstandingInvoiceAmount', 'outstandingCreditAmount'];
