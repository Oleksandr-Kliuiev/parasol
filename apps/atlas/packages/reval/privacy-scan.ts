import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { DATASET_DATA_DIR, DATASET_MANIFEST_SHA256 } from './dataset.ts';
import { decodeTerminalObservation } from './eval-wire.ts';
import type { QueryClient } from './physical.ts';
import { decodePrivacyProof, privacyVerifiedZero } from './proof-payloads.ts';
import type { PrivacyProof } from './proof-payloads.ts';
import { exact, isTime, isUuid } from './scalars.ts';

/**
 * C's closed local privacy scanner (05 "Privacy proof and destination completeness"; rs-d brief B §2.4). Canaries — every frozen
 * question and every rationale of ≥12 characters, raw and JSON-escaped — are loaded from the pinned dataset files into memory only
 * (never argv, env or output). Destinations C can inspect: every regular file under the owner config directory (the closed name set:
 * the config file and C's journal; anything else is new/unclassified but still scanned), S's stdio (spawned `ignore`: no sink) and the
 * PG statement/parameter/error-statement logging that applies to S's and C's sessions (rc2, review F2). The configured credential files
 * are NEVER opened (frozen 01 / RS-A R9b: the owner and runtime passwords never enter C's heap — rc2, review F1): matched by path and
 * dev/ino with lstat only, they are one declared destination outside the scan. Declared destinations outside C's inspection (05
 * "Include at least", rc2 review F3) are counted unreadable. Results are counts only; nothing matched is ever copied, logged or returned.
 */
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const FILE_CAP = 64 * 1024 * 1024;
/** Declared persistence destinations C cannot inspect (each one keeps the proof incomplete), by the 05 areas. */
export const OUTSIDE_INSPECTION = Object.freeze([
  'DB_ATTEMPT_COUNTER_AUDIT_SECURITY_ROWS', 'PG_SERVER_LOG_FILES', 'PG_BACKUPS_AND_REPLICAS', // DB
  'SERVICE_PROXY_APM_DIAGNOSTICS', // API/provider client (S's own stdio is inspected)
  'CRASH_CORE_HEAP_DUMPS', 'TEMP_AND_SPOOL_FILES', 'SESSION_RECORDERS', 'SWAP_AND_HIBERNATION', // process/host
  'BROWSER_PROFILE_STORAGE_DEVTOOLS', 'BROWSER_EXTENSIONS_TELEMETRY_RECORDING', 'CLIPBOARD_MANAGERS', // browser
  'TTY_CAPTURE_SHELL_HISTORY_ARGV', 'INSTRUMENT_RECEIPTS_REPLAY_EXPORT', 'ATOMIC_SAVE_LEFTOVERS_OUTSIDE_CONFIG', // instrument/owner CLI
  'PROVIDER_RETENTION', // external account
  'OWNER_CREDENTIAL_FILES_NOT_OPENED']);
/** Destinations C inspects (besides each config-directory file): S's stdio and PG logging. */
export const INSPECTED_SETTINGS = Object.freeze(['SERVER_STDIO_IGNORE', 'PG_STATEMENT_PARAMETER_ERROR_LOGGING']);
export const PRIVACY_INVENTORY_SHA256 = sha(JSON.stringify({ contractVersion: 'RevalPrivacyInventoryV1', configDirectory: 'EVERY_REGULAR_FILE',
  inspected: INSPECTED_SETTINGS, outside: OUTSIDE_INSPECTION }));

export interface Canaries { readonly needles: readonly string[]; readonly sha256: string }
/** Questions and rationales (≥12 chars) of the pinned frozen corpus, raw and JSON-escaped (in memory only). */
export function loadCanaries(read: (name: string) => Buffer = name => readFileSync(DATASET_DATA_DIR + name)): Canaries {
  const manifestBytes = read('DATASET_MANIFEST.json');
  if (sha(manifestBytes) !== DATASET_MANIFEST_SHA256) throw new Error('CANARY_MANIFEST');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { files: { name: string; sha256: string }[] };
  const set = new Set<string>();
  for (const f of manifest.files) {
    if (!/^cases-[a-z-]+\.jsonl$/.test(f.name)) continue;
    const bytes = read(f.name);
    if (sha(bytes) !== f.sha256) throw new Error('CANARY_CASES');
    for (const line of bytes.toString('utf8').split('\n').filter(l => l.length > 0)) {
      const c = JSON.parse(line) as { question?: unknown; rationale?: unknown };
      for (const t of [c.question, c.rationale]) {
        if (typeof t !== 'string' || t.length < 12) continue;
        const escaped = JSON.stringify(t).slice(1, -1);
        set.add(t); set.add(escaped); set.add(escaped.replace(/[\u0080-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)); // + ASCII-only JSON (rc2 N6)
      }
    }
  }
  const needles = [...set].sort();
  return { needles, sha256: sha(needles.join('\n')) };
}
/** This scanner's own bytes plus the canary set (05 scannerManifestSha256). */
export const scannerManifestSha256 = (c: Canaries): string => sha(`${sha(readFileSync(new URL(import.meta.url)))}\n${c.sha256}`);

const LOGGING = ['log_statement', 'log_min_duration_statement', 'log_min_duration_sample', 'log_transaction_sample_rate', 'log_parameter_max_length_on_error',
  'log_min_error_statement', 'debug_print_parse', 'debug_print_rewritten', 'debug_print_plan'];
/**
 * PG logging as it applies to S's runtime and C's reader sessions: the reader's pg_settings (system and database defaults) plus the
 * PUBLIC-readable pg_db_role_setting rows that would give either role (in this database or all) its own value of a checked setting
 * (rc2, review F2). null = unreadable. A session-level `SET` by S itself is inside S's trust boundary: the log_statement/log_min_* settings
 * are superuser-only, but log_parameter_max_length_on_error and debug_print_* are user-settable (PG17 context `user`; RS-D-B rc2-N5).
 */
export interface PgLogging { readonly settings: Record<string, string>; readonly roleOverrides: number }
export async function readPgLogging(reader: QueryClient, roles: { readonly runtime: string; readonly reader: string }): Promise<PgLogging | null> {
  try {
    const rows = (await reader.query(`SELECT name, setting FROM pg_catalog.pg_settings WHERE name = ANY($1::text[])`, [LOGGING])).rows as { name: string; setting: string }[];
    if (rows.length !== LOGGING.length) return null;
    const n = (await reader.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_db_role_setting s
      WHERE s.setrole IN (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[]))
        AND s.setdatabase IN (0, (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()))
        AND EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE split_part(c, '=', 1) = ANY($2::text[]))`, [[roles.runtime, roles.reader], LOGGING])).rows[0] as { n: number };
    return { settings: Object.fromEntries(rows.map(r => [r.name, r.setting])), roleOverrides: n.n };
  } catch { return null; }
}
/** Statement, parameter, error-statement and debug-tree logging off for both sessions: no question/parameter text reaches PG's logs through them. */
export const loggingDisabled = (l: PgLogging | null): boolean => { const s = l?.settings;
  return l !== null && s !== undefined && l.roleOverrides === 0 && (s.log_statement === 'none' || s.log_statement === 'ddl')
    && s.log_min_duration_statement === '-1' && s.log_min_duration_sample === '-1' && Number(s.log_transaction_sample_rate) === 0
    && s.log_parameter_max_length_on_error === '0' && s.log_min_error_statement === 'panic'
    && s.debug_print_parse === 'off' && s.debug_print_rewritten === 'off' && s.debug_print_plan === 'off'; };

/** One journal line is exactly C's safe record (contractVersion, boot, time, a valid terminal observation). */
function journalLineOk(line: string): boolean {
  try {
    const o = exact(JSON.parse(line), ['contractVersion', 'serverBootId', 'receivedAt', 'record']);
    if (o.contractVersion !== 'RevalTerminalJournalV1' || !isUuid(o.serverBootId) || !isTime(o.receivedAt)) return false;
    decodeTerminalObservation(o.record);
    return true;
  } catch { return false; }
}
export interface ScanCounts { covered: number; unreadable: number; newUnclassified: number; forbidden: number; metadata: number }
/** Path and dev/ino of each credential file, by lstat/realpath only (never opened); a missing one has no identity. */
function credentialIds(files: readonly string[]): { paths: Set<string>; ids: Set<string> } {
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const f of files) {
    paths.add(f); try { paths.add(realpathSync(f)); } catch { /* missing */ }
    try { const st = lstatSync(f); ids.add(`${st.dev}:${st.ino}`); } catch { /* missing */ }
  }
  return { paths, ids };
}
/** Scans the owner config directory (counts only); the configured credential files are skipped unopened. */
export function scanConfigDirectory(configPath: string, canaries: Canaries, credentialFiles: readonly string[]): ScanCounts {
  const dir = join(configPath, '..');
  const known = new Set([basename(configPath), 'reval-journal.jsonl']);
  const secret = credentialIds(credentialFiles);
  const counts: ScanCounts = { covered: 0, unreadable: 0, newUnclassified: 0, forbidden: 0, metadata: 0 };
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { counts.unreadable += 1; return; }
    for (const name of names.sort()) {
      const p = join(d, name); const rel = relative(dir, p);
      let st;
      try { st = lstatSync(p); } catch { counts.unreadable += 1; continue; }
      if (secret.paths.has(p) || secret.ids.has(`${st.dev}:${st.ino}`)) continue; // a credential file (or a hard link to one): never opened
      if (st.isDirectory()) { walk(p); continue; }
      if (st.isSocket()) continue; // a live IPC endpoint, not a persistence destination
      if (!st.isFile() || st.size > FILE_CAP) { counts.unreadable += 1; continue; }
      let text: string;
      try { text = readFileSync(p).toString('utf8'); } catch { counts.unreadable += 1; continue; }
      counts.covered += 1;
      if (!known.has(rel)) counts.newUnclassified += 1;
      for (const needle of canaries.needles) if (text.includes(needle)) counts.forbidden += 1;
      if (rel === 'reval-journal.jsonl') for (const line of text.split('\n')) if (line.length > 0 && !journalLineOk(line)) counts.metadata += 1;
    }
  };
  walk(dir);
  return counts;
}
/** The exact PRIVACY_PROOF (validated); countsAsVerifiedZero by the 05 rule only. */
export function composePrivacyProof(o: { registrationId: string; intervalStart: string; intervalEnd: string; canaries: Canaries; scan: ScanCounts;
  logging: PgLogging | null }): PrivacyProof {
  const covered = o.scan.covered + 1 + (o.logging === null ? 0 : 1); // + S's stdio sink (none) + PG logging settings when readable
  const unreadable = o.scan.unreadable + OUTSIDE_INSPECTION.length + (o.logging === null ? 1 : 0);
  const base = { environmentId: o.registrationId, destinationInventorySha256: PRIVACY_INVENTORY_SHA256, scannerManifestSha256: scannerManifestSha256(o.canaries),
    intervalStart: o.intervalStart, intervalEnd: o.intervalEnd, coveredDestinationCount: String(covered), unreadableDestinationCount: String(unreadable),
    newUnclassifiedDestinationCount: String(o.scan.newUnclassified), forbiddenContentMatchCount: String(o.scan.forbidden),
    metadataViolationCount: String(o.scan.metadata), collectionState: loggingDisabled(o.logging) ? 'DISABLED_AS_REQUIRED' : 'UNKNOWN',
    externalRetentionEvidenceRef: null, mode: 'MEASURED' } as const;
  return decodePrivacyProof({ ...base, countsAsVerifiedZero: privacyVerifiedZero(base) });
}
