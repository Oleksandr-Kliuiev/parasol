import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { AtlasError } from '../packages/core/contracts.ts';
import { auditMetadataAllowlist, sanitizeAuditMetadata } from '../packages/audit/sanitize.ts';
import { POWEROFFICE_AUDIT_KEYS, powerOfficeAuditMetadata } from '../packages/poweroffice/audit.ts';
import { checkBinding } from '../packages/poweroffice/binding.ts';
import { POWEROFFICE_ATTEMPT_CODES, POWEROFFICE_ERROR_CODES, POWEROFFICE_PERMISSIONS, powerOfficeError } from '../packages/poweroffice/contracts.ts';
import { powerOfficeCredential, powerOfficeFailure, withPowerOfficeAuthority } from '../packages/poweroffice/authority.ts';
import { setLocal as actionSetLocal } from '../packages/actions/authority.ts';
import { setLocal as sharedSetLocal } from '../packages/auth/transaction-token.ts';
import { BINDABLE_SYSTEMS } from '../packages/connections/connections.ts';

// S4-A: PowerOffice audit-key domain, synthetic binding rule, permission/error vocabulary and the private credential. No DB.
const uuid = '00000000-0000-4000-8000-000000000001';
const row = (over: Record<string, unknown> = {}) => ({ system: 'poweroffice', status: 'FIXTURE', externalTenantId: `synthetic-po-${uuid}`,
  secretRef: `fixture://poweroffice/${uuid}`, boundBy: 'operator', boundAt: new Date(), lifecycleVersion: 1, ...over });

test('PowerOffice audit metadata: exactly six keys with fixed shapes; counts, amounts, dates and source IDs are refused even if globally allowlisted', () => {
  assert.deepEqual([...POWEROFFICE_AUDIT_KEYS], ['connectionId', 'attemptId', 'snapshotId', 'sequence', 'outcome', 'safeErrorCode']);
  for (const key of POWEROFFICE_AUDIT_KEYS) assert.ok(auditMetadataAllowlist.includes(key), `${key} is allowlisted additively`);
  const full = { connectionId: 'po-a', attemptId: uuid, snapshotId: uuid, sequence: '12', outcome: 'SUCCEEDED' as const, safeErrorCode: 'POWEROFFICE_DEADLINE' };
  assert.deepEqual(powerOfficeAuditMetadata(full), full);
  assert.deepEqual(powerOfficeAuditMetadata({ connectionId: 'po-a', outcome: 'COMPLETED' }), { connectionId: 'po-a', outcome: 'COMPLETED' });
  // Keys another domain may use (global allowlist) still never enter PowerOffice audit.
  for (const key of ['rowCount', 'itemCount', 'total', 'deletedAttempts', 'attempts', 'system', 'command', 'requestId', 'amount', 'asOf', 'companyKey', 'invoiceId']) {
    assert.throws(() => powerOfficeAuditMetadata({ connectionId: 'po-a', outcome: 'READ', [key]: '1' } as never), /not allowed/, key);
  }
  for (const [key, value] of [['sequence', '0'], ['sequence', '1.5'], ['sequence', '-1'], ['attemptId', 'not-a-uuid'], ['outcome', 'DENIED'],
    ['safeErrorCode', 'NOT_A_CODE'], ['connectionId', 'a,b'], ['snapshotId', 7]] as const) {
    assert.throws(() => powerOfficeAuditMetadata({ connectionId: 'po-a', outcome: 'READ', [key]: value } as never), /not allowed/, `${key}=${value}`);
  }
  assert.throws(() => powerOfficeAuditMetadata({ outcome: 'READ' } as never), /needs connectionId/);
  assert.deepEqual(sanitizeAuditMetadata({ outcome: 'X', sequence: '1', amount: '5.00' }), { outcome: 'X', sequence: '1' }, 'the shared writer still drops unknown keys');
});

test('synthetic binding: poweroffice system, paired synthetic tenant/secret UUID, provenance, lifecycle > 0; FIXTURE for source, DISABLED only for close-out', () => {
  assert.deepEqual(checkBinding(row(), 'source'), { binding: { companyKey: `synthetic-po-${uuid}`, lifecycleVersion: 1, status: 'FIXTURE' } });
  assert.deepEqual(checkBinding(null, 'read'), { refused: 'POWEROFFICE_NOT_FOUND' });
  assert.deepEqual(checkBinding(row({ system: 'atera' }), 'read'), { refused: 'POWEROFFICE_NOT_FOUND' }, 'non-PowerOffice connection is not found');
  for (const [label, over] of [['secret for another UUID', { secretRef: 'fixture://poweroffice/00000000-0000-4000-8000-000000000002' }],
    ['vault secret', { secretRef: `vault://poweroffice/${uuid}` }], ['real-looking tenant', { externalTenantId: '912345678' }],
    ['upper-case UUID', { externalTenantId: `synthetic-po-${uuid.toUpperCase().replace('0000-4000-8000', 'ABCD-4000-8000')}` }],
    ['no provenance', { boundBy: null }], ['no bound time', { boundAt: null }], ['lifecycle 0', { lifecycleVersion: 0 }], ['ACTIVE', { status: 'ACTIVE' }]] as const) {
    assert.deepEqual(checkBinding(row(over), 'closeout'), { refused: 'POWEROFFICE_CONNECTION_UNAVAILABLE' }, label);
  }
  assert.deepEqual(checkBinding(row({ status: 'DISABLED' }), 'source'), { refused: 'POWEROFFICE_CONNECTION_UNAVAILABLE' });
  assert.deepEqual(checkBinding(row({ status: 'DISABLED' }), 'read'), { refused: 'POWEROFFICE_CONNECTION_UNAVAILABLE' });
  assert.equal('binding' in checkBinding(row({ status: 'DISABLED', lifecycleVersion: 3 }), 'closeout'), true, 'recover/cleanup close out a disabled binding');
  assert.deepEqual([...BINDABLE_SYSTEMS], ['atera', 'huntress', 'microsoft365'], 'the generic bindable allowlist is unchanged');
});

test('permissions are all-of per operation with context:read; fixed codes; unknown errors become UNEXPECTED_ERROR with no detail', () => {
  assert.deepEqual(POWEROFFICE_PERMISSIONS, { read: ['context:read', 'poweroffice:read'], sync: ['context:read', 'poweroffice:read', 'poweroffice:sync'],
    recover: ['context:read', 'poweroffice:read', 'poweroffice:sync'], maintain: ['context:read', 'poweroffice:read', 'poweroffice:maintain'] });
  assert.equal(POWEROFFICE_ERROR_CODES.length, 27);
  assert.ok(POWEROFFICE_ATTEMPT_CODES.every(c => (POWEROFFICE_ERROR_CODES as readonly string[]).includes(c)));
  assert.deepEqual(powerOfficeError('POWEROFFICE_DTO_INVALID').details, {});
  const sqlError = Object.assign(new Error('duplicate key value violates unique constraint "x" detail: (secret)=(...)'), { code: '23505' });
  for (const [error, code] of [[sqlError, 'UNEXPECTED_ERROR'], [Object.assign(new Error('x'), { code: '40P01' }), 'POWEROFFICE_DB_CONFLICT'],
    [Object.assign(new Error('x'), { code: 'AT001' }), 'POWEROFFICE_RUNTIME_NOT_READY'], [Object.assign(new Error('late'), { code: 'PO007' }), 'POWEROFFICE_DEADLINE'],
    [Object.assign(new Error('cap'), { code: 'PO006' }), 'POWEROFFICE_SYNC_LIMIT'], [Object.assign(new Error('guard'), { code: 'PO002' }), 'UNEXPECTED_ERROR'], [new AtlasError('ACTION_DB_CONFLICT', 'CONFLICT'), 'UNEXPECTED_ERROR'],
    [new AtlasError('POWEROFFICE_SYNC_BUSY', 'CONFLICT', { echo: 'secret' }), 'POWEROFFICE_SYNC_BUSY']] as const) {
    const mapped = powerOfficeFailure(error);
    assert.equal(mapped.code, code); assert.deepEqual(mapped.details, {}, 'never echoes details');
  }
});

test('private credential: malformed bearer refused before SQL; a forged or cloned credential object never authenticates (zero DB calls)', async () => {
  let calls = 0;
  const db = new Proxy({}, { get: () => { calls++; throw new Error('database must not be used'); } }) as unknown as PrismaClient;
  for (const bad of ['short', 'has space in it 12345678901234567890', '', null, 42]) assert.throws(() => powerOfficeCredential(bad), /POWEROFFICE_AUTHENTICATION_FAILED/);
  const real = powerOfficeCredential('atl_' + 'x'.repeat(40));
  const steps = { lock: async () => undefined, run: async () => ({ ok: 'data' }) };
  for (const forged of [{ kind: 'PowerOfficeCredential' }, { ...real }, Object.freeze({ kind: 'PowerOfficeCredential' as const })]) {
    await assert.rejects(withPowerOfficeAuthority(db, forged as never, { clientId: 'c', connectionId: 'p', operation: 'read' }, steps), /POWEROFFICE_AUTHENTICATION_FAILED/);
  }
  await assert.rejects(withPowerOfficeAuthority(db, real, { clientId: 'c', connectionId: 'p', operation: 'toString' as never }, steps), /POWEROFFICE_AUTHENTICATION_FAILED/);
  assert.equal(calls, 0);
  assert.equal(actionSetLocal, sharedSetLocal, 'Stage 3 actions use the shared transaction-local helper verbatim');
});
