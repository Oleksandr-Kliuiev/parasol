import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CurrentUserContext } from '../auth/CurrentUserContext';
import { testUser } from '../test/renderWithProviders';
import { selectedNavValue, useNavGroups } from './navigation';

function groupsFor(permissions: string[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CurrentUserContext.Provider value={testUser(permissions)}>{children}</CurrentUserContext.Provider>
  );
  return renderHook(() => useNavGroups(), { wrapper }).result.current.map((group) => [group.key, group.items.map((item) => item.value)]);
}

describe('navigation groups', () => {
  it('shows only the common entries to someone without rights', () => {
    expect(groupsFor([])).toEqual([
      ['work', ['my-day']],
      ['customers', ['organizations']],
    ]);
  });

  it('keeps each entry behind the permission it had before the regrouping', () => {
    expect(groupsFor(['time.own', 'contracts.read', 'billing.read', 'reports.read', 'finance.cost.read', 'service.read'])).toEqual([
      ['work', ['my-day', 'timesheet']],
      ['customers', ['organizations', 'contracts']],
      ['finance', ['billing', 'invoices', 'dashboard', 'margins', 'sla']],
    ]);
  });

  it('lists administration entries under System only for a holder of an administration right', () => {
    expect(groupsFor(['customers.delete', 'customfields.manage'])).toEqual([
      ['work', ['my-day']],
      ['customers', ['organizations']],
    ]);
    expect(groupsFor(['audit.read', 'customers.delete'])).toEqual([
      ['work', ['my-day']],
      ['customers', ['organizations']],
      ['system', ['audit', 'record-access', 'migration']],
    ]);
  });

  it('lists Connections under System for an Atlas member or an integration manager, without the other administration entries', () => {
    expect(groupsFor(['parasol.atlas.read'])).toEqual([
      ['work', ['my-day']],
      ['customers', ['organizations']],
      ['system', ['connections']],
    ]);
  });

  it('marks the Hangfire dashboard as an external page', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CurrentUserContext.Provider value={testUser(['integrations.manage'])}>{children}</CurrentUserContext.Provider>
    );
    const system = renderHook(() => useNavGroups(), { wrapper }).result.current.find((group) => group.key === 'system');
    expect(system?.items.find((item) => item.value === 'jobs')).toMatchObject({ path: '/admin/jobs', external: true });
  });
});

describe('selectedNavValue', () => {
  it.each([
    ['/', 'my-day'],
    ['/organizations/abc', 'organizations'],
    ['/connections', 'connections'],
    ['/contacts/abc', 'organizations'],
    ['/billing', 'billing'],
    ['/billing/invoices', 'invoices'],
    ['/time', 'timesheet'],
    ['/time/entries', 'time-entries'],
    ['/admin/pipeline', 'pipeline-stages'],
    ['/pipeline', 'pipeline'],
    ['/reports/margins', 'margins'],
    ['/unknown', 'my-day'],
  ])('%s selects %s', (path, value) => {
    expect(selectedNavValue(path)).toBe(value);
  });
});
