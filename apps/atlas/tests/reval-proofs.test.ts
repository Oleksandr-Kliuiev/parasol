import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATASET_DATA_DIR } from '../packages/reval/dataset.ts';
import { ProofLink } from '../packages/reval/eval-proofs.ts';
import { composePlatformProof, destinationInventorySha256 } from '../packages/reval/platform.ts';
import { composePrivacyProof, loadCanaries, loggingDisabled, OUTSIDE_INSPECTION, scanConfigDirectory } from '../packages/reval/privacy-scan.ts';
import { decodePlatformProof, decodePrivacyProof, NO_POLICY_REF, SERVER_POLICY_REF } from '../packages/reval/proof-payloads.ts';
import { rejects, terminal } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-D-B proofs (rs-d brief B §2.3–§2.4; 05 PLATFORM_PROOF / PRIVACY_PROOF): exact payloads and the 05 countsAsVerifiedZero rule
// (no software flag manufactures a zero), the honest composition on this platform, and the closed local privacy scanner — canaries are
// counted, never echoed; an unknown file is unclassified; a malformed journal line is a metadata violation. Synthetic files only.
const T0 = '2026-10-13T10:00:00.000Z'; const T1 = '2026-10-13T10:05:00.000Z'; const D = 'a'.repeat(64);
const platform = (over: Record<string, unknown> = {}) => ({ environmentId: randomUUID(), buildManifestSha256: D, serverBootId: randomUUID(), policyEvidenceRef: SERVER_POLICY_REF,
  destinationInventorySha256: D, intervalStart: T0, intervalEnd: T1, processCoverage: 'COMPLETE', destinationCoverage: 'COMPLETE', unexpectedDestinationCount: '0',
  unknownDestinationCount: '0', unmeasuredProcessCount: '0', mode: 'MEASURED', countsAsVerifiedZero: true, ...over });
const privacy = (over: Record<string, unknown> = {}) => ({ environmentId: randomUUID(), destinationInventorySha256: D, scannerManifestSha256: D, intervalStart: T0, intervalEnd: T1,
  coveredDestinationCount: '9', unreadableDestinationCount: '0', newUnclassifiedDestinationCount: '0', forbiddenContentMatchCount: '0', metadataViolationCount: '0',
  collectionState: 'DISABLED_AS_REQUIRED', externalRetentionEvidenceRef: 'owner-retention-evidence-1', mode: 'MEASURED', countsAsVerifiedZero: true, ...over });

test('05 rule: countsAsVerifiedZero is exactly MEASURED + complete coverage + zero counts + accepted evidence; OFFLINE_SIMULATED never true', () => {
  assert.doesNotThrow(() => decodePlatformProof(platform()));
  assert.doesNotThrow(() => decodePrivacyProof(privacy()));
  for (const over of [{ countsAsVerifiedZero: false }, { mode: 'OFFLINE_SIMULATED' }, { processCoverage: 'UNKNOWN' }, { destinationCoverage: 'UNKNOWN' },
    { unexpectedDestinationCount: '1' }, { unknownDestinationCount: '1' }, { unmeasuredProcessCount: '1' }, { policyEvidenceRef: NO_POLICY_REF },
    { intervalStart: T1, intervalEnd: T0 }, { extra: 1 }, { unmeasuredProcessCount: 1 }]) {
    assert.ok(rejects(() => decodePlatformProof(platform(over))), `platform ${JSON.stringify(over)} with true`);
  }
  for (const over of [{ mode: 'OFFLINE_SIMULATED' }, { processCoverage: 'UNKNOWN' }, { unmeasuredProcessCount: '4' }]) {
    assert.doesNotThrow(() => decodePlatformProof(platform({ ...over, countsAsVerifiedZero: false })), `${JSON.stringify(over)} false is valid`);
  }
  for (const over of [{ countsAsVerifiedZero: false }, { mode: 'OFFLINE_SIMULATED' }, { coveredDestinationCount: '0' }, { unreadableDestinationCount: '1' },
    { newUnclassifiedDestinationCount: '1' }, { forbiddenContentMatchCount: '1' }, { metadataViolationCount: '1' }, { collectionState: 'UNKNOWN' },
    { externalRetentionEvidenceRef: null }, { externalRetentionEvidenceRef: 'has space' }]) {
    assert.ok(rejects(() => decodePrivacyProof(privacy(over))), `privacy ${JSON.stringify(over)} with true`);
  }
  assert.doesNotThrow(() => decodePrivacyProof(privacy({ externalRetentionEvidenceRef: null, countsAsVerifiedZero: false })));
});

test('honest composition here: an enforced S gives process COMPLETE but destinations UNKNOWN and 4 unenforced components → never a verified zero', () => {
  const inv = destinationInventorySha256({ apiPort: 3100, endpoint: { socketDir: '/s', port: 5432, database: 'd' }, unixSockets: ['/c/b.sock', '/c/a.sock'] });
  assert.equal(inv, destinationInventorySha256({ apiPort: 3100, endpoint: { socketDir: '/s', port: 5432, database: 'd' }, unixSockets: ['/c/a.sock', '/c/b.sock'] }));
  const id = randomUUID(); const boot = randomUUID();
  const on = composePlatformProof({ registrationId: id, buildManifestSha256: D, serverBootId: boot, enforced: true, inventorySha256: inv, intervalStart: T0, intervalEnd: T1 });
  assert.deepEqual([on.policyEvidenceRef, on.processCoverage, on.destinationCoverage, on.unmeasuredProcessCount, on.mode, on.countsAsVerifiedZero, on.environmentId],
    [SERVER_POLICY_REF, 'COMPLETE', 'UNKNOWN', '4', 'MEASURED', false, id]);
  const off = composePlatformProof({ registrationId: id, buildManifestSha256: D, serverBootId: boot, enforced: false, inventorySha256: inv, intervalStart: T0, intervalEnd: T1 });
  assert.deepEqual([off.policyEvidenceRef, off.processCoverage, off.countsAsVerifiedZero], [NO_POLICY_REF, 'UNKNOWN', false]);
});

function configDir(): { dir: string; config: string; secrets: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'reval-priv-')); chmodSync(dir, 0o700);
  mkdirSync(join(dir, 'secrets'), { mode: 0o700 });
  const config = join(dir, 'owner.json'); writeFileSync(config, '{"contractVersion":"RevalOwnerConfigV1"}');
  const secrets = ['owner', 'runtime', 'reader'].map(s => join(dir, 'secrets', s));
  for (const f of secrets) writeFileSync(f, 'synthetic-secret');
  const line = JSON.stringify({ contractVersion: 'RevalTerminalJournalV1', serverBootId: randomUUID(), receivedAt: T0, record: terminal() });
  writeFileSync(join(dir, 'reval-journal.jsonl'), `${line}\n`);
  return { dir, config, secrets };
}
/** Every path the code under test passes to an fs open/read while `fn` runs (the ESM named imports are re-synced to the spies). */
async function opened<T>(fn: () => T | Promise<T>): Promise<{ value: T; paths: string[] }> {
  const paths: string[] = []; const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>; const saved: [string, (...a: unknown[]) => unknown][] = [];
  for (const name of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream']) {
    const orig = f[name]!; saved.push([name, orig]);
    f[name] = function (this: unknown, p: unknown, ...a: unknown[]) { paths.push(String(p)); return orig.call(this, p, ...a); };
  }
  syncBuiltinESMExports();
  try { return { value: await fn(), paths }; } finally { for (const [name, orig] of saved) f[name] = orig; syncBuiltinESMExports(); }
}
test('privacy scanner: counts only — a planted canary is counted (never echoed), an unknown file unclassified, a bad journal line a violation', async () => {
  const canaries = loadCanaries();
  assert.ok(canaries.needles.length >= 200, 'every question (and rationale) of the frozen corpus');
  const esc = (n: string) => JSON.stringify(n).slice(1, -1);
  assert.ok(canaries.needles.some(n => esc(n) !== n && canaries.needles.includes(esc(n))), 'the JSON-escaped form of a text that needs escaping is a needle too');
  assert.ok(canaries.needles.some(n => /\\u[0-9a-f]{4}/.test(n)), 'and the ASCII-only (\\uXXXX) JSON form of a text with non-ASCII characters (rc2 N6)');
  const mixed = canaries.needles.filter(n => /[^\x00-\x7f]/.test(n) && esc(n) !== n && !n.includes('\\'));
  assert.ok(mixed.length > 0 && mixed.every(n => canaries.needles.includes(esc(n))), 'a text with non-ASCII AND escaped characters keeps its UTF-8 JSON form');
  const data = (name: string) => readFileSync(DATASET_DATA_DIR + name);
  assert.throws(() => loadCanaries(name => name === 'DATASET_MANIFEST.json' ? Buffer.concat([data(name), Buffer.from(' ')]) : data(name)), /CANARY_MANIFEST/);
  assert.throws(() => loadCanaries(name => name.startsWith('cases-') ? Buffer.from('{}\n') : data(name)), /CANARY_CASES/, 'only the pinned case files');
  const clean = configDir();
  assert.deepEqual(scanConfigDirectory(clean.config, canaries, clean.secrets), { covered: 2, unreadable: 0, newUnclassified: 0, forbidden: 0, metadata: 0 },
    'the config file and the journal; the three credential files are not scanned');
  const dirty = configDir();
  const question = canaries.needles.find(n => n.length > 40 && !n.includes('\\'))!;
  writeFileSync(join(dirty.dir, 'notes.txt'), `operator pasted: ${question}`);
  writeFileSync(join(dirty.dir, 'reval-journal.jsonl'), `${JSON.stringify({ contractVersion: 'RevalTerminalJournalV1', serverBootId: randomUUID(), receivedAt: T0, record: terminal() })}\n{"x":1}\n`);
  // rc2 F1: a canary inside a credential file (and in a hard link to it) is never found — those files are never opened; rc2 N7: a symlink
  // is unreadable, never followed.
  writeFileSync(dirty.secrets[0]!, question); linkSync(dirty.secrets[0]!, join(dirty.dir, 'owner-copy'));
  const target = join(tmpdir(), `reval-target-${randomUUID()}`); writeFileSync(target, question); symlinkSync(target, join(dirty.dir, 'link'));
  const run = await opened(() => scanConfigDirectory(dirty.config, canaries, dirty.secrets));
  const counts = run.value;
  assert.deepEqual(counts, { covered: 3, unreadable: 1, newUnclassified: 1, forbidden: 1, metadata: 1 });
  const secretIds = new Set(dirty.secrets.map(f => realpathSync(f)));
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  assert.deepEqual(run.paths.filter(p => secretIds.has(real(p)) || p.endsWith('owner-copy') || p.endsWith('/link') || p === target), [], 'no credential file, link or link target opened');
  assert.ok(run.paths.some(p => p.endsWith('notes.txt')), 'the spy sees the scanner\'s reads');
  const proof = composePrivacyProof({ registrationId: randomUUID(), intervalStart: T0, intervalEnd: T1, canaries, scan: counts, logging: { settings: OFF, roleOverrides: 0 } });
  assert.deepEqual([proof.forbiddenContentMatchCount, proof.newUnclassifiedDestinationCount, proof.metadataViolationCount, proof.coveredDestinationCount,
    proof.unreadableDestinationCount, proof.collectionState, proof.countsAsVerifiedZero], ['1', '1', '1', '5', String(1 + OUTSIDE_INSPECTION.length), 'DISABLED_AS_REQUIRED', false]);
  assert.ok(!JSON.stringify(proof).includes(question.slice(0, 20)), 'no matched content in the proof');
  const unread = composePrivacyProof({ registrationId: randomUUID(), intervalStart: T0, intervalEnd: T1, canaries, scan: scanConfigDirectory(clean.config, canaries, clean.secrets), logging: null });
  assert.deepEqual([unread.collectionState, unread.unreadableDestinationCount, unread.countsAsVerifiedZero], ['UNKNOWN', String(OUTSIDE_INSPECTION.length + 1), false]);
  for (const area of ['DB_ATTEMPT_COUNTER_AUDIT_SECURITY_ROWS', 'TEMP_AND_SPOOL_FILES', 'SESSION_RECORDERS', 'CLIPBOARD_MANAGERS', 'ATOMIC_SAVE_LEFTOVERS_OUTSIDE_CONFIG',
    'OWNER_CREDENTIAL_FILES_NOT_OPENED']) assert.ok(OUTSIDE_INSPECTION.includes(area), `05 minimum: ${area} (rc2 F3)`);
});

const OFF = { log_statement: 'ddl', log_min_duration_statement: '-1', log_min_duration_sample: '-1', log_transaction_sample_rate: '0', log_parameter_max_length_on_error: '0',
  log_min_error_statement: 'panic', debug_print_parse: 'off', debug_print_rewritten: 'off', debug_print_plan: 'off' };
test('PG logging: statement/parameter/error-statement/debug logging off and no role-specific override for DISABLED_AS_REQUIRED', () => {
  assert.equal(loggingDisabled({ settings: OFF, roleOverrides: 0 }), true);
  for (const over of [{ log_statement: 'all' }, { log_statement: 'mod' }, { log_min_duration_statement: '0' }, { log_min_duration_sample: '100' },
    { log_transaction_sample_rate: '0.5' }, { log_parameter_max_length_on_error: '-1' }, { log_min_error_statement: 'error' }, { debug_print_parse: 'on' },
    { debug_print_rewritten: 'on' }, { debug_print_plan: 'on' }]) assert.equal(loggingDisabled({ settings: { ...OFF, ...over }, roleOverrides: 0 }), false, JSON.stringify(over));
  assert.equal(loggingDisabled({ settings: OFF, roleOverrides: 1 }), false, 'a per-role override (S\'s or C\'s session may differ from the reader\'s view; rc2 F2)');
  assert.equal(loggingDisabled(null), false);
});

test('ProofLink: no verified S is a fixed FAILURE; a verified S gives CONTROLLER-produced exact proofs; the credential files stay unopened; bounded PG read', { timeout: 20_000 }, async () => {
  const { config: configPath, secrets } = configDir();
  const config = { registrationId: randomUUID(), server: { port: 3100 }, endpoint: { socketDir: '/s', port: 5432, database: 'd' }, roles: { runtime: 'rt', reader: 'rd' },
    secretFiles: { owner: secrets[0], runtime: secrets[1], reader: secrets[2] } } as never;
  let server: unknown = null; let pg: 'OFF' | 'EMPTY' | 'STALL' = 'EMPTY'; const asked: unknown[] = [];
  const query = async (sql: string, params: unknown[]) => {
    asked.push(params);
    if (pg === 'STALL') return new Promise(() => undefined);
    if (pg === 'EMPTY') return { rows: [] };
    return sql.includes('pg_db_role_setting') ? { rows: [{ n: 0 }] } : { rows: Object.entries(OFF).map(([name, setting]) => ({ name, setting })) };
  };
  const link = new ProofLink({ server: () => server as never, config, configPath, serverBootId: randomUUID(), buildManifestSha256: () => D,
    reader: async () => ({ query }) as never, wallIso: () => T1, deadline: until => performance.now() + (until - Date.now()) });
  assert.deepEqual([(await link.platform()).payload, (await link.privacy(Date.now() + 1000)).payload], [{ code: 'PLATFORM_UNVERIFIED' }, { code: 'PRIVACY_UNVERIFIED' }]);
  server = { verifiedAt: T0, enforcedNow: async () => true };
  const p = await link.platform();
  const { value: q, paths } = await opened(() => link.privacy(Date.now() + 1000));
  assert.deepEqual([p.kind, p.emitter, (p.payload as { processCoverage: string }).processCoverage], ['PLATFORM_PROOF', 'CONTROLLER', 'COMPLETE']);
  assert.deepEqual([q.kind, q.emitter, (q.payload as { collectionState: string }).collectionState], ['PRIVACY_PROOF', 'CONTROLLER', 'UNKNOWN']);
  assert.deepEqual(paths.filter(x => secrets.includes(x)), [], 'C never opens a credential file for a privacy proof (frozen 01; rc2 F1)');
  pg = 'OFF';
  assert.equal(((await link.privacy(Date.now() + 1000)).payload as { collectionState: string }).collectionState, 'DISABLED_AS_REQUIRED');
  assert.deepEqual(asked.at(-1), [['rt', 'rd'], Object.keys(OFF)], 'the role overrides of S\'s runtime and C\'s reader roles are checked');
  pg = 'STALL'; const t0 = performance.now();
  assert.equal(((await link.privacy(Date.now() + 300)).payload as { collectionState: string }).collectionState, 'UNKNOWN', 'a stalled reader is UNKNOWN (rc2 N8)');
  assert.ok(performance.now() - t0 < 1500, 'within the operation deadline');
  server = { verifiedAt: T0, enforcedNow: async () => false };
  assert.equal(((await link.platform()).payload as { processCoverage: string }).processCoverage, 'UNKNOWN', 'enforcement lost now → UNKNOWN');
});
