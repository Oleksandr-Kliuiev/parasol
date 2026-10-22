import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../../../i18n';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import { alertPage, alertRead, syntheticAlert } from '../../../test/alerts';
import { urgentAlert, urgentAlerts } from '../../../test/urgentAlerts';
import { formatDate, formatDateTime } from '../../../shared/utils/format';
import { UrgentAlertsPanel } from '../../dashboard/UrgentAlertsPanel';
import type { Alert, CoverageRule } from '../types';
import { AlertDetailDrawer } from './AlertDetailDrawer';
import { AlertQueuePage } from './AlertQueuePage';
import { alertTitle, gapKey } from './alertText';
import { CoverageRulesDialog } from './CoverageRulesDialog';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };
const t = i18n.t.bind(i18n);

const closedAt = '2026-10-22T07:00:00Z';
/** An urgent Huntress incident Huntress closed: it waits in Parasoll for a person to confirm the closing (M41). */
const waiting = syntheticAlert({
  id: 'h1', system: 'huntress', kind: 'Security', externalId: 'incident:7001', title: 'HIGH - Incident on PC-17 (Fjord IT AS)', deviceName: 'PC-17',
  sourceClosedAt: closedAt,
});
const closedIncident = {
  id: 'i1', system: 'huntress', externalId: 7001, organizationId: 'o1', organizationName: 'Fjord IT AS', externalOrganizationId: 501, agentExternalId: '4711',
  deviceName: 'PC-17', status: 'closed', isOpen: false, severity: 'high', subject: 'HIGH - Incident on PC-17 (Fjord IT AS)', summary: null, body: null,
  platform: 'windows', indicators: [], sentAt: '2026-10-21T06:00:00Z', closedAt, updatedAt: closedAt, url: null, readAt: '2026-10-22T07:05:00Z',
  remediationsReadAt: null, commentsReadAt: null, remediations: [], comments: [],
};
const closedFact = `Closed in Huntress ${formatDateTime(closedAt)} – needs confirming`;

afterEach(() => vi.unstubAllGlobals());

describe('An urgent alert its source closed waits for a person (M41)', () => {
  it('explains in the panel why it is still open and confirms the closing with the ETag it reads first', async () => {
    const user = userEvent.setup();
    let alert: Alert = waiting;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/service/alerts/h1/confirm-closed' && init?.method === 'POST') {
        alert = { ...waiting, state: 'Resolved', resolvedAt: '2026-10-22T08:00:00Z', sourceClosedAt: null };
        return json(alert);
      }
      if (url === '/api/v1/service/alerts/h1') return json({ ...alert, etag: '"AAAAAAAAH2E="' });
      if (url === '/api/v1/service/alerts?limit=1') return json(alertPage([], null, 0, [alertRead({ system: 'huntress' })]));
      if (url === '/api/v1/security/huntress/incidents/7001') return json(closedIncident);
      if (url.startsWith('/api/v1/actions/kinds')) return json([]);
      if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
      return json(empty);
    });
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<AlertDetailDrawer alertId="h1" onClose={() => {}} />)], '/', testUser(['service.read', 'service.write']));
    const own = within(await screen.findByRole('region', { name: 'In Parasoll' }));
    expect(own.getByText(`Huntress closed it ${formatDateTime(closedAt)}. As an urgent alert it stays open in Parasoll until someone confirms it is done with.`))
      .toBeVisible();
    // What was asked of the source is named after the alert's own source, never Atera's.
    expect(await within(screen.getByRole('region', { name: 'In Huntress' })).findByText('Nothing has been asked of Huntress for this alert.')).toBeVisible();
    await user.click(own.getByRole('button', { name: 'Confirm closing' }));

    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/service/alerts/h1/confirm-closed')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/service/alerts/h1/confirm-closed')!;
    expect(new Headers(init!.headers).get('If-Match')).toBe('"AAAAAAAAH2E="');
    // The panel reads the alert again: it is resolved, nothing waits, and focus lands on the section that says what is true now.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm closing' })).not.toBeInTheDocument());
    expect(screen.queryByText(/stays open in Parasoll until someone confirms/)).not.toBeInTheDocument();
  });

  it('says so in the queue row and offers the confirmation first in the row’s menu', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'https://parasoll.invalid');
      if (url.pathname === '/api/v1/service/alerts/h1/confirm-closed' && init?.method === 'POST') return json({ ...waiting, state: 'Resolved', sourceClosedAt: null });
      if (url.pathname === '/api/v1/service/alerts/h1') return json({ ...waiting, etag: '"AAAAAAAAH3E="' });
      if (url.pathname === '/api/v1/service/alerts') return json(alertPage([waiting], null, 1, [alertRead(), alertRead({ system: 'huntress' })]));
      if (url.pathname === '/api/v1/actions/kinds') return json([]);
      if (url.pathname === '/api/v1/activities/source-tasks/lookup') return json({ items: [] });
      return json(empty);
    });
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<AlertQueuePage />, '/alerts')], '/alerts', testUser(['service.read', 'service.write']));
    const table = await screen.findByRole('table', { name: 'Alerts' });
    const row = within(within(table).getAllByRole('row')[1]!);
    expect(row.getByText(closedFact)).toBeVisible();
    expect(row.getByText('Source: Huntress')).toBeVisible();

    await user.click(row.getByRole('button', { name: 'Actions for HIGH - Incident on PC-17 (Fjord IT AS)' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Confirm closing', 'Hide until…']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Confirm closing' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/service/alerts/h1/confirm-closed')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/service/alerts/h1/confirm-closed')!;
    expect(new Headers(init!.headers).get('If-Match')).toBe('"AAAAAAAAH3E="');
  });

  it('says so beside the urgent row of My day', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/v1/service/alerts/urgent?limit=5'
      ? json(urgentAlerts({ items: [urgentAlert('h1', { system: 'huntress', kind: 'Security', externalId: 'incident:7001', title: 'HIGH - Incident on PC-17',
        deviceName: 'PC-17', sourceClosedAt: closedAt }), urgentAlert('a2')] }))
      : json(empty))));
    renderRoutes([page(<UrgentAlertsPanel />)], '/', testUser(['service.read']));
    const panel = within(await screen.findByRole('region', { name: 'Urgent alerts' }));
    const rows = await panel.findAllByRole('listitem');
    expect(within(rows[0]!).getByText(closedFact)).toBeVisible();
    expect(within(rows[1]!).queryByText(/needs confirming/)).not.toBeInTheDocument();
  });

  it('offers nothing to confirm for a resolved alert or to a person who may only read', async () => {
    const answer = (alert: Alert) => vi.fn(async (url: string) => {
      if (url === `/api/v1/service/alerts/${alert.id}`) return json({ ...alert, etag: '"AAAAAAAAH4E="' });
      if (url === '/api/v1/service/alerts?limit=1') return json(alertPage([], null, 0, [alertRead({ system: 'huntress' })]));
      if (url === '/api/v1/security/huntress/incidents/7001') return json(closedIncident);
      if (url.startsWith('/api/v1/actions/kinds')) return json([]);
      if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
      return json(empty);
    });
    vi.stubGlobal('fetch', answer({ ...waiting, state: 'Resolved', resolvedAt: '2026-10-22T08:00:00Z' }));
    renderRoutes([page(<AlertDetailDrawer alertId="h1" onClose={() => {}} />)], '/', testUser(['service.read', 'service.write']));
    expect(await screen.findByRole('region', { name: 'Security incident' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm closing' })).not.toBeInTheDocument();
    expect(screen.queryByText(/stays open in Parasoll until someone confirms/)).not.toBeInTheDocument();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', answer(waiting));
    renderRoutes([page(<AlertDetailDrawer alertId="h1" onClose={() => {}} />)], '/', testUser(['service.read']));
    const own = within(await screen.findByRole('region', { name: 'In Parasoll' }));
    expect(own.getByText(/stays open in Parasoll until someone confirms it is done with/)).toBeVisible();
    expect(own.queryByRole('button', { name: 'Confirm closing' })).not.toBeInTheDocument();
  });
});

describe('The coverage gaps of M41 in the reader’s language', () => {
  const gap = (rule: string, facts: Record<string, string>) => alertTitle(t, { title: `stored title of ${rule}`, rule, facts });

  it('words each new rule’s gap from its facts, with dates as the interface writes them', () => {
    expect(gap('huntress.agent-missing', { device: 'SRV-01', since: '2026-10-20T08:00:00Z' }))
      .toBe(`SRV-01 has had the Atera agent since ${formatDate('2026-10-20T08:00:00Z')} but no Huntress agent`);
    expect(gap('atera.agent-missing', { device: 'PC-22', since: '2026-10-19T08:00:00Z' }))
      .toBe(`PC-22 has had the Huntress agent since ${formatDate('2026-10-19T08:00:00Z')} but no Atera agent`);
    expect(gap('huntress.agent-silent', { device: 'LAPTOP-09', lastSeenAt: '2026-10-12T08:00:00Z' }))
      .toBe(`The Huntress agent on LAPTOP-09 has not reported since ${formatDate('2026-10-12T08:00:00Z')}`);
    expect(gap('huntress.agent-outdated', { device: 'PC-22', version: '0.13.100', newest: '0.13.140', since: '2026-10-01T08:00:00Z' }))
      .toBe(`The Huntress agent on PC-22 runs version 0.13.100; 0.13.140 has run on other machines since ${formatDate('2026-10-01T08:00:00Z')}`);
    expect(gap('huntress.defender-off', { device: 'PC-17', status: 'Unmanaged' })).toBe('Microsoft Defender does not protect PC-17: Another antivirus is in charge');
  });

  it('keeps a Defender word the interface does not know as Huntress wrote it, and the stored title when facts are missing', () => {
    expect(gap('huntress.defender-off', { device: 'PC-17', status: 'Quarantined' })).toBe('Microsoft Defender does not protect PC-17: Quarantined');
    expect(gap('huntress.agent-outdated', { device: 'PC-22', version: '0.13.100' })).toBe('stored title of huntress.agent-outdated');
    expect(gap('huntress.unknown-rule', { device: 'PC-22' })).toBe('stored title of huntress.unknown-rule');
  });

  it('knows the key of every rule’s words, and none for a rule it does not know', () => {
    expect(['atera.agent-silent', 'huntress.agent-missing', 'atera.agent-missing', 'huntress.agent-silent', 'huntress.agent-outdated', 'huntress.defender-off',
      'cloudally.backup-failed'].map(gapKey))
      .toEqual(['ateraAgentSilent', 'huntressAgentMissing', 'ateraAgentMissing', 'huntressAgentSilent', 'huntressAgentOutdated', 'defenderOff', null]);
  });
});

describe('The coverage checks dialog with the rules of M41', () => {
  const rule = (code: string, system: string, kind: CoverageRule['kind'], threshold: CoverageRule['threshold']): CoverageRule => ({
    code, system, kind, threshold, enabled: true, value: threshold?.default ?? null, openGaps: 0, changedAt: null, changedByName: null, etag: '"AAAAAAAAC2E="',
  });

  it('names each rule with its own limit: days before an alert, days behind, days without contact, and no limit for Defender', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([
      rule('atera.agent-missing', 'atera', 'Monitoring', { default: 2, min: 1, max: 30, unit: 'Days' }),
      rule('atera.agent-silent', 'atera', 'Monitoring', { default: 7, min: 1, max: 90, unit: 'Days' }),
      rule('huntress.agent-missing', 'huntress', 'Security', { default: 2, min: 1, max: 30, unit: 'Days' }),
      rule('huntress.agent-outdated', 'huntress', 'Security', { default: 14, min: 1, max: 90, unit: 'Days' }),
      rule('huntress.agent-silent', 'huntress', 'Security', { default: 7, min: 1, max: 90, unit: 'Days' }),
      rule('huntress.defender-off', 'huntress', 'Security', null),
    ])));
    renderRoutes([page(<CoverageRulesDialog onClose={() => {}} />)], '/', testUser(['service.read', 'service.write']));
    const dialog = within(await screen.findByRole('dialog', { name: 'Coverage checks' }));
    const limitOf = async (name: string) => within(await dialog.findByRole('region', { name })).queryByRole('spinbutton');

    expect(await limitOf('Machine without Atera')).toHaveAccessibleName(expect.stringContaining('Days before an alert'));
    expect(await limitOf('Machine without Huntress')).toHaveAccessibleName(expect.stringContaining('Days before an alert'));
    expect(await limitOf('Outdated Huntress agent')).toHaveAccessibleName(expect.stringContaining('Days behind'));
    expect(await limitOf('Silent Huntress agent')).toHaveAccessibleName(expect.stringContaining('Days without contact'));
    expect(await limitOf('Silent Atera agent')).toHaveAccessibleName(expect.stringContaining('Days without contact'));
    expect(await limitOf('Defender does not protect')).toBeNull();
    expect(within(dialog.getByRole('region', { name: 'Machine without Huntress' }))
      .getByText(/for customers linked to a Huntress organization\./)).toBeVisible();
    expect(within(dialog.getByRole('region', { name: 'Outdated Huntress agent' })).getByRole('spinbutton')).toHaveValue(14);
  });
});
