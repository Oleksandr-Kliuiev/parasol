import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { AtlasError } from '../packages/core/contracts.ts';
import { generateToken } from '../packages/auth/token.ts';
import { POWEROFFICE_MODE_VARIABLE, POWEROFFICE_REFUSED_VARIABLES, compositionPort, powerOfficeComposition, testFaultComposition } from '../packages/poweroffice/composition.ts';
import { isKnownRollback, powerOfficeCredential, powerOfficeFailure } from '../packages/poweroffice/authority.ts';
import { claimRecord, factAuditId, failureIdentity } from '../packages/poweroffice/capabilities.ts';
import { admitSync } from '../packages/poweroffice/admission.ts';
import { runExportPass } from '../packages/poweroffice/pass.ts';
import { publishFact } from '../packages/poweroffice/publication.ts';
import { closeFailed } from '../packages/poweroffice/failure.ts';
import { recoverPowerOffice } from '../packages/poweroffice/recovery.ts';
import { syncPowerOffice } from '../packages/poweroffice/sync.ts';

// S4-B B1 (no database): default DISABLED / exact MOCK composition, unforgeable composition and capabilities, the private
// known-rollback marker behind the fixed public conflict code, stable fact audit IDs, and that the fault seam is test-only.
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as { code?: string }).code; } };
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
/** A database whose every access is recorded: refusals must happen before any of it. */
function recordingDb(): { db: PrismaClient; touched: string[] } {
  const touched: string[] = [];
  const db = new Proxy({}, { get: (_t, p) => { touched.push(String(p)); throw new Error('database touched'); } }) as unknown as PrismaClient;
  return { db, touched };
}

test('mode: unset/empty/DISABLED → POWEROFFICE_DISABLED; only the exact MOCK composes; every other value or refused variable → MODE_UNSUPPORTED', () => {
  for (const env of [{}, { [POWEROFFICE_MODE_VARIABLE]: '' }, { [POWEROFFICE_MODE_VARIABLE]: 'DISABLED' }]) assert.equal(code(() => powerOfficeComposition(env)), 'POWEROFFICE_DISABLED');
  for (const mode of ['mock', ' MOCK', 'MOCK ', 'LIVE', 'HTTP', 'disabled', 'MOCK,LIVE', 'FIXTURE']) {
    assert.equal(code(() => powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: mode })), 'POWEROFFICE_MODE_UNSUPPORTED', mode);
  }
  const composition = powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' });
  assert.deepEqual(composition, { mode: 'MOCK', synthetic: true }); assert.ok(Object.isFrozen(composition));
  assert.ok(POWEROFFICE_REFUSED_VARIABLES.length >= 10);
  for (const variable of POWEROFFICE_REFUSED_VARIABLES) {
    assert.equal(code(() => powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK', [variable]: 'x' })), 'POWEROFFICE_MODE_UNSUPPORTED', variable);
    assert.equal(code(() => powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK', [variable]: '' })), 'ok', `${variable} empty`);
  }
});

test('a fabricated, copied or foreign composition is unknown; services refuse it before touching the database', async () => {
  for (const forged of [{ mode: 'MOCK', synthetic: true }, Object.freeze({ mode: 'MOCK', synthetic: true }), { ...powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' }) },
    null, undefined, 'MOCK', JSON.parse(JSON.stringify(powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' })))]) {
    assert.equal(code(() => compositionPort(forged)), 'POWEROFFICE_MODE_UNSUPPORTED');
  }
  const { db, touched } = recordingDb();
  const credential = powerOfficeCredential(generateToken());
  for (const call of [() => admitSync(db, { mode: 'MOCK', synthetic: true }, credential, 'c', 'p'), () => syncPowerOffice(db, {}, credential, 'c', 'p'),
    () => recoverPowerOffice(db, null, credential, 'c', 'p')]) assert.equal(await codeOf(call()), 'POWEROFFICE_MODE_UNSUPPORTED');
  const real = powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' });
  assert.equal(await codeOf(admitSync(db, real, credential, 7 as never, 'p')), 'INVALID_ARGUMENTS');
  assert.equal(await codeOf(recoverPowerOffice(db, real, credential, 'c', null as never)), 'INVALID_ARGUMENTS');
  assert.deepEqual(touched, [], 'zero database access');
});

test('capabilities: fabricated claims/failure continuations are unknown (CLAIM_STALE) before any database access', async () => {
  const { db, touched } = recordingDb();
  for (const forged of [{ kind: 'PowerOfficeSyncClaim' }, Object.freeze({ kind: 'PowerOfficeSyncClaim' }), null, 'claim']) {
    assert.equal(code(() => claimRecord(forged)), 'POWEROFFICE_CLAIM_STALE');
    assert.equal(await codeOf(runExportPass(db, forged as never)), 'POWEROFFICE_CLAIM_STALE');
    assert.equal(await codeOf(publishFact(db, forged as never, { totalCount: 0, currencies: [] })), 'POWEROFFICE_CLAIM_STALE');
  }
  for (const forged of [{ kind: 'PowerOfficeFailureContinuation' }, {}, null]) {
    assert.equal(code(() => failureIdentity(forged)), 'POWEROFFICE_CLAIM_STALE');
    assert.equal(await codeOf(closeFailed(db, forged as never, 'POWEROFFICE_SOURCE_FAILED')), 'POWEROFFICE_CLAIM_STALE');
  }
  assert.deepEqual(touched, []);
});

test('known rollback: only an actual 40P01/40001 marks the fixed DB_CONFLICT; P2034/P2028/other conflicts stay unmarked; the public error is identical', () => {
  const prisma = (over: Record<string, unknown>) => Object.assign(new Error('x'), { clientVersion: '6.19.0', ...over });
  const marked = [Object.assign(new Error('deadlock detected'), { code: '40P01' }), Object.assign(new Error('could not serialize'), { code: '40001' }),
    prisma({ code: 'P2010', meta: { code: '40P01' } }), prisma({ code: 'P2010', meta: { code: '40001' } }),
    prisma({ code: 'P2010', message: 'Raw query failed. Code: `40P01`. Message: `deadlock detected`' })];
  const unmarked = [prisma({ code: 'P2034' }), prisma({ code: 'P2028' }), Object.assign(new Error('lock timeout'), { code: '55P03' }),
    Object.assign(new Error('canceled'), { code: '57014' }), new Error('connection reset'), prisma({ code: 'P1001' })];
  for (const error of marked) {
    const fixed = powerOfficeFailure(error);
    assert.equal(fixed.code, 'POWEROFFICE_DB_CONFLICT'); assert.equal(isKnownRollback(fixed), true, String((error as { code?: string }).code));
  }
  for (const error of unmarked) assert.equal(isKnownRollback(powerOfficeFailure(error)), false, String((error as { code?: string }).code));
  assert.equal(powerOfficeFailure(prisma({ code: 'P2034' })).code, 'POWEROFFICE_DB_CONFLICT');
  assert.equal(powerOfficeFailure(prisma({ code: 'P2028' })).code, 'POWEROFFICE_DB_CONFLICT');
  const a = powerOfficeFailure(marked[0]); const b = powerOfficeFailure(unmarked[0]);
  assert.deepEqual([a.code, a.kind, a.details, a.message, a.name, Object.keys(a)], [b.code, b.kind, b.details, b.message, b.name, Object.keys(b)]);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'no visible marker');
  assert.equal(isKnownRollback(powerOfficeFailure(a)), false, 'a fixed code passed through again is never a known rollback');
  for (const other of [new AtlasError('POWEROFFICE_DB_CONFLICT', 'CONFLICT'), { code: '40P01' }, '40P01', null]) assert.equal(isKnownRollback(other), false);
});

test('stable fact audit IDs: deterministic UUIDv8 per (claim token, event, attempt); distinct otherwise; reveal no input', () => {
  const t1 = '11111111-1111-4111-8111-111111111111'; const t2 = '22222222-2222-4222-8222-222222222222'; const at = '33333333-3333-4333-8333-333333333333';
  const id = factAuditId(t1, 'poweroffice.sync.succeeded', at);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(factAuditId(t1, 'poweroffice.sync.succeeded', at), id);
  assert.equal(new Set([id, factAuditId(t2, 'poweroffice.sync.succeeded', at), factAuditId(t1, 'poweroffice.sync.failed', at),
    factAuditId(t1, 'poweroffice.sync.succeeded', t2)]).size, 4);
  for (const part of [t1, at, '1111', '3333']) assert.ok(!id.includes(part));
});

test('the fault seam is a private in-process test seam: no production module imports it and no variable selects it', async () => {
  assert.equal(code(() => compositionPort(testFaultComposition(c => c.builtIn()))), 'ok');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(rel); continue; }
      if (!rel.endsWith('.ts') || rel === join('packages', 'poweroffice', 'composition.ts')) continue;
      if ((await readFile(join(root, rel), 'utf8')).includes('testFaultComposition')) offenders.push(rel);
    }
  };
  for (const dir of ['apps', 'packages', 'connectors', 'scripts', 'prisma']) await walk(dir);
  assert.deepEqual(offenders, []);
  const source = await readFile(join(root, 'packages/poweroffice/composition.ts'), 'utf8');
  assert.doesNotMatch(source, /process\.env/, 'the composition reads only the environment record its trusted caller passes');
  assert.deepEqual([...new Set(source.match(/env\[[^\]]+\]/g))].sort(), ['env[POWEROFFICE_MODE_VARIABLE]', 'env[v]'], 'only the mode and the refused variables');
});
