/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIdentityImport, canConfirmIdentityPlan, IDENTITY_REQUEST_LIMIT, parseIdentitySnapshot, readIdentityFile, type IdentityPlan } from './identityImport';

const fixture = readFileSync('../../../contracts/customer-identity/atlas-export.v1.example.json', 'utf8');
const snapshot = parseIdentitySnapshot(fixture);
const selected = new Map([[snapshot.clients[0]!.clientId, { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic CRM' }]]);

describe('Atlas identity import boundary', () => {
  it('accepts the shared cross-service fixture and sends only explicitly selected pairs', () => {
    const body = buildIdentityImport(snapshot, selected);
    expect(body.snapshot).toEqual(JSON.parse(fixture));
    expect(body.mappings).toEqual([{ atlasClientId: snapshot.clients[0]!.clientId, customerId: selected.values().next().value!.id }]);
    expect(JSON.stringify(body)).not.toContain('Synthetic CRM');
  });

  it.each([
    '{broken', JSON.stringify({ ...snapshot, token: 'must-not-leave-browser' }),
    JSON.stringify({ ...snapshot, clients: [{ ...snapshot.clients[0], password: 'must-not-leave-browser' }] }),
    JSON.stringify({ ...snapshot, clients: [snapshot.clients[0], snapshot.clients[0]] }),
    JSON.stringify({ ...snapshot, workspaceId: '../other' }), JSON.stringify({ ...snapshot, schemaVersion: 2 }),
    JSON.stringify({ ...snapshot, clients: Array.from({ length: 1001 }, (_, i) => ({ clientId: `c-${i}`, name: 'Synthetic' })) }),
  ])('rejects invalid or overbroad exports without exposing their contents', text => {
    expect(() => parseIdentitySnapshot(text)).toThrow('invalidFile');
  });

  it('allows an empty export but refuses an empty or duplicate selection', () => {
    expect(parseIdentitySnapshot(JSON.stringify({ ...snapshot, clients: [] })).clients).toEqual([]);
    expect(() => buildIdentityImport(snapshot, new Map())).toThrow('noSelection');
    const duplicate = { ...snapshot, clients: [{ clientId: 'one', name: 'One' }, { clientId: 'two', name: 'Two' }] };
    const customer = { id: 'AAAAAAAA-1111-4111-8111-111111111111', name: 'Synthetic' };
    expect(() => buildIdentityImport(duplicate, new Map([['one', customer], ['two', { ...customer, id: customer.id.toLowerCase() }]]))).toThrow('duplicateCustomer');
  });

  it('limits UTF-8 bytes before parsing, file reading and sending the assembled request', async () => {
    expect(() => parseIdentitySnapshot('ø'.repeat(IDENTITY_REQUEST_LIMIT))).toThrow('tooLarge');
    await expect(readIdentityFile(new File(['x'.repeat(IDENTITY_REQUEST_LIMIT + 1)], 'large.json'))).rejects.toThrow('tooLarge');
    const large = { ...snapshot, clients: Array.from({ length: 1000 }, (_, i) => ({ clientId: `client-${i}`, name: '界'.repeat(256) })) };
    // JSON escaping can enlarge a valid in-memory export; the assembled request is checked again.
    large.clients.forEach(c => { c.name = '\u0001'.repeat(256); });
    expect(() => buildIdentityImport(large, new Map(large.clients.map((c, i) => [c.clientId, { id: String(i), name: 'CRM' }])))).toThrow('tooLarge');
  });

  it('will not confirm an unknown outcome, a conflict, an applied result or an invalid hash', () => {
    const plan: IdentityPlan = { sha256: 'a'.repeat(64), dryRun: true, canApply: true, unmappedClients: 0,
      rows: [{ atlasClientId: 'one', customerId: 'one', outcome: 'READY' }] };
    expect(canConfirmIdentityPlan(plan)).toBe(true);
    for (const invalid of [{ ...plan, sha256: '' }, { ...plan, dryRun: false }, { ...plan, canApply: false }, { ...plan, rows: [] },
      { ...plan, rows: [{ ...plan.rows[0]!, outcome: 'UNRECOGNIZED' }] }]) expect(canConfirmIdentityPlan(invalid)).toBe(false);
  });
});
