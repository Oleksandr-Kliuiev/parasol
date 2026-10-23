import { describe, expect, it } from 'vitest';
import {
  choiceValid, createRequest, emailValid, estimateValid, initialChoice, keyValid, lineStart, lineValid, openContract, withContract,
  type CustomerService, type LineChoice,
} from './connectServices';
import { entityTypeOf } from '../integrations/labels';

const service = (changes: Partial<CustomerService>): CustomerService => ({
  system: 'huntress', kind: 'organization.create', enabled: true, link: null, block: null, simulated: false,
  defaults: { key: 'fjord-it' }, consoleUrl: null, ...changes,
});

describe('connect services (M43)', () => {
  it('starts with a creation where the server lets it through, and its defaults', () => {
    expect(initialChoice(service({}))).toMatchObject({ create: true, key: 'fjord-it' });
    expect(initialChoice(service({ block: 'VND_KIND_DISABLED' })).create).toBe(false);
    expect(initialChoice(service({ link: { externalId: '7', name: 'Fjord IT', linkedAt: '2026-10-23T08:00:00Z', method: 'Manual' } })).create).toBe(false);
    // A data center outside the EU list the wizard offers falls back to EU.
    expect(initialChoice(service({ system: 'cloudally', kind: 'account.create', defaults: { region: 'US_EST', email: null } })).region).toBe('EU');
    expect(initialChoice(service({ system: 'cloudally', kind: 'account.create', defaults: { region: 'EU_STOCKHOLM', email: null } })).region).toBe('EU_STOCKHOLM');
  });

  it('takes the Huntress key and the CloudAlly address the server takes', () => {
    expect(keyValid('fjord-it')).toBe(true);
    expect(keyValid('Fjord-IT')).toBe(false);
    expect(keyValid('-fjord')).toBe(false);
    expect(keyValid('a'.repeat(65))).toBe(false);
    expect(emailValid('backup@fjordit.no')).toBe(true);
    expect(emailValid('backup@fjordit')).toBe(false);
    const cloudAlly = { system: 'cloudally', kind: 'account.create', create: true, key: '', email: 'backup@fjordit.no', region: 'EU' };
    expect(choiceValid(cloudAlly)).toBe(true);
    expect(choiceValid({ ...cloudAlly, region: 'LONDON' })).toBe(false);
    expect(choiceValid({ ...cloudAlly, create: false, email: '' })).toBe(true);
  });

  it('asks each vendor to create the CRM organization with the fields of its kind only', () => {
    const base = { create: true, key: ' fjord-it ', email: ' backup@fjordit.no ', region: 'EU_PARIS' };
    expect(createRequest({ ...base, system: 'atera', kind: 'customer.create' }, 'o1'))
      .toEqual({ system: 'atera', kind: 'customer.create', targetType: 'organization', targetId: 'o1', parameters: {} });
    expect(createRequest({ ...base, system: 'huntress', kind: 'organization.create' }, 'o1').parameters).toEqual({ key: 'fjord-it' });
    expect(createRequest({ ...base, system: 'cloudally', kind: 'account.create' }, 'o1').parameters).toEqual({ email: 'backup@fjordit.no', region: 'EU_PARIS' });
  });

  it('adds a line the contract lacks until the person decides, and checks what a line needs', () => {
    const line: LineChoice = { system: 'huntress', model: 'PerHuntressAgent', add: true, product: null, estimate: '0' };
    const existing = [{ isCurrent: true, quantityModel: 'PerHuntressAgent' }];
    expect(withContract([line], existing)[0]!.add).toBe(false);
    expect(withContract([line], [{ isCurrent: false, quantityModel: 'PerHuntressAgent' }])[0]!.add).toBe(true);
    expect(withContract([{ ...line, decided: true }], existing)[0]!.add).toBe(true);
    expect(lineValid(line)).toBe(false);
    expect(lineValid({ ...line, product: { id: 'p1', sku: 'HNT', name: 'Huntress' } })).toBe(true);
    expect(lineValid({ ...line, add: false })).toBe(true);
    expect(estimateValid('12')).toBe(true);
    expect(estimateValid('1,5')).toBe(false);
    expect(estimateValid('-1')).toBe(false);
  });

  it('starts a line when the contract line form would', () => {
    expect(lineStart({ status: 'Draft', startDate: '2026-11-01' }, '2026-10-23')).toBe('2026-11-01');
    expect(lineStart({ status: 'Active', startDate: '2026-01-01' }, '2026-10-23')).toBe('2026-10-23');
    expect(lineStart({ status: 'Active', startDate: '2026-12-01' }, '2026-10-23')).toBe('2026-12-01');
    expect(openContract({ status: 'Ended' })).toBe(false);
    expect(openContract({ status: 'Suspended' })).toBe(true);
  });

  it('lets the mapping screen link a Huntress organization to a customer', () => {
    expect(entityTypeOf('Organization')).toBe('Organization');
    expect(entityTypeOf('Customer')).toBe('Organization');
  });
});
