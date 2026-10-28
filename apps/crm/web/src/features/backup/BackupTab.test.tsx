import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { syntheticAlert } from '../../test/alerts';
import { alertTitle } from '../service/alerts/alertText';
import { AlertDetailDrawer } from '../service/alerts/AlertDetailDrawer';
import { BackupTab } from './BackupTab';
import type { BackupEntity, BackupOverview } from './types';
import i18n from '../../i18n';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

const overview = (changes: Partial<BackupOverview> = {}): BackupOverview => ({
  organizationId: 'o1', lateAfterHours: 26,
  read: { system: 'cloudally', startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), complete: true, late: false },
  accounts: [{ id: 'a1', externalId: 'acc-1', name: 'Fjord IT AS', email: 'admin@fjord.test', status: 'ACTIVE', region: 'EU', outsideRegion: false, tasks: 2 }],
  services: [
    { service: 'OneDrive', total: 2, ok: 2, failed: 0, late: 0, paused: 0, notInBackup: 0, waiting: 0, newestBackupAt: null, oldestBackupAt: null },
    { service: 'Mail', total: 2, ok: 1, failed: 1, late: 0, paused: 0, notInBackup: 1, waiting: 0, newestBackupAt: null, oldestBackupAt: null },
  ],
  tasks: [
    { id: 't1', externalId: 'task-mail', accountExternalId: 'acc-1', accountName: 'Fjord IT AS', service: 'Mail', source: 'MS365', alias: 'Exchange', status: 'ACTIVE',
      paused: false, running: false, lastBackupAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), nextBackup: null, entities: 3, problems: 2 },
    { id: 't2', externalId: 'task-drive', accountExternalId: 'acc-1', accountName: 'Fjord IT AS', service: 'OneDrive', source: 'ONEDRIVE', alias: null, status: 'PAUSED',
      paused: true, running: false, lastBackupAt: null, nextBackup: null, entities: 2, problems: 0 },
  ],
  licences: { state: 'Checked', licensed: 4, backedUp: 2, missing: 2, readOn: '2026-10-21' },
  ...changes,
});

const entity = (changes: Partial<BackupEntity>): BackupEntity => ({
  id: 'e1', externalId: 'ent-1', taskExternalId: 'task-mail', accountExternalId: 'acc-1', service: 'Mail', name: 'ola@fjord.test', fullName: 'Ola Nordmann',
  state: 'Ok', status: 'ACTIVE', running: false, lastBackupAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), lastAttemptAt: null, error: null,
  errorLink: null, licensing: 'LICENSED', ...changes,
});

const entities = [
  entity({ id: 'e1', externalId: 'ent-1', state: 'Failed', error: 'Mailbox is full', errorLink: 'https://support.cloudally.test/faq' }),
  entity({ id: 'e2', externalId: 'ent-2', name: 'nina@fjord.test', fullName: null, state: 'NotInBackup', status: 'NOTACTIVE', lastBackupAt: null }),
  entity({ id: 'e3', externalId: 'ent-3', name: 'kari@fjord.test', fullName: 'Kari Nordmann' }),
];

const allKinds = ['backup.run', 'backup.activate', 'backup.pause', 'backup.resume', 'account.deactivate', 'restore.export', 'restore.other', 'restore.in-place'];

function stub(body: BackupOverview = overview(), kinds: string[] = allKinds, linked = true) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/backup/organizations/o1') return json(body);
    if (url.startsWith('/api/v1/integrations/links')) return json(linked ? [{ id: 'l1', system: 'cloudally', externalType: 'Customer', externalId: 'acc-1' }] : []);
    if (url.startsWith('/api/v1/backup/organizations/o1/entities')) return json({ items: entities, nextCursor: null, totalCount: entities.length });
    if (url.startsWith('/api/v1/actions/kinds')) return json(kinds.map((kind) => ({ system: 'cloudally', kind, targetType: 'backup-entity', level: 'Standard' })));
    if (url === '/api/v1/actions/preview' && init?.method === 'POST') {
      return json({
        previewToken: null, expiresAt: null, system: 'cloudally', kind: 'restore.other', level: 'Disruptive',
        target: { type: 'backup-entity', id: 'ent-3', name: 'kari@fjord.test', organizationId: 'o1', organizationName: 'Fjord IT AS', externalCustomerId: 'acc-1', url: null },
        effects: [], block: { code: 'VND_KIND_DISABLED', message: 'off' },
        confirmation: { reason: true, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
      });
    }
    return json({ items: [], nextCursor: null, totalCount: 0 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const render = (permissions = ['service.read', 'service.write']) =>
  renderRoutes([page(<BackupTab organizationId="o1" />)], '/', testUser(permissions));

describe('The Sikkerhetskopi tab (M42)', () => {
  it('shows each service, the licence check, the read time and the users that need someone first', async () => {
    stub();
    render();
    const summary = within(await screen.findByRole('region', { name: 'Backup at a glance' }));
    expect(await summary.findByText(/CloudAlly read at/)).toBeVisible();
    // Mail before OneDrive, whatever order the server listed them in.
    expect(summary.getAllByRole('term').map((term) => term.textContent)).toEqual(['Mail', 'OneDrive']);
    expect(summary.getByText('1 failed · 1 not in backup')).toBeVisible();
    expect(summary.getByText('All good')).toBeVisible();
    expect(summary.getByText(/2 licensed users have no mailbox in the backup: 4 licensed, 2 in backup/)).toBeVisible();
    expect(summary.getByText('Fjord IT AS')).toBeVisible();
    const users = within(screen.getByRole('region', { name: 'Users and sites' }));
    const rows = await users.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Ola Nordmann (ola@fjord.test)');
    expect(within(rows[0]!).getByText('CloudAlly: Mailbox is full')).toBeVisible();
    expect(within(rows[0]!).getByRole('link', { name: /CloudAlly’s help/ })).toHaveAttribute('href', 'https://support.cloudally.test/faq');
    expect(within(rows[1]!).getByText('Not in backup')).toBeVisible();
    const services = within(screen.getByRole('region', { name: 'Services in CloudAlly' }));
    expect(services.getByRole('button', { name: 'Back up now: Mail' })).toBeVisible();
    expect(services.getByRole('button', { name: 'Resume: OneDrive' })).toBeVisible();
  });

  it('says so when the installation keeps CloudAlly read-only, instead of leaving the actions to be looked for', async () => {
    stub(overview(), []);
    render();
    expect(await screen.findByText('Changes at CloudAlly are switched off in this installation, so the tab only shows the backups.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Back up now/ })).toBeNull();
    expect(screen.getByRole('region', { name: 'Actions at CloudAlly' })).toBeVisible();
  });

  it('offers a person without the right to change no action at all', async () => {
    stub();
    render(['service.read']);
    await screen.findByRole('region', { name: 'Users and sites' });
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(3));
    expect(screen.queryByRole('button', { name: /^Back up now/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });

  it('opens narrowed to the person a search hit named, with their list in view, and keeps its own search in the address', async () => {
    const fetch = stub();
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const user = userEvent.setup();
    const { router } = renderRoutes([page(<BackupTab organizationId="o1" />)], '/?tab=backup&search=kari%40fjord.test', testUser(['service.read']));

    const box = await screen.findByRole('searchbox', { name: 'Search name or address' });
    expect(box).toHaveValue('kari@fjord.test');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Users and sites' })).toHaveFocus());
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' });
    const reads = () => fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/v1/backup/organizations/o1/entities'));
    expect(reads().length).toBeGreaterThan(0);
    expect(reads().every((url) => url.includes('q=kari%40fjord.test')), 'never the whole list first').toBe(true);

    await user.clear(box);
    await user.type(box, 'ola');
    await waitFor(() => expect(router.state.location.search).toBe('?tab=backup&search=ola'));
    scrolled.mockRestore();
  });

  it('says when Partner Center has no licence data, when a linked account was not read yet, and when none is linked', async () => {
    stub(overview({ licences: { state: 'NoData', licensed: null, backedUp: 2, missing: null, readOn: null } }));
    const first = render();
    expect(await screen.findByText(/Partner Center has no licence data for this customer/)).toBeVisible();
    first.unmount();

    const nothing = overview({ accounts: [], services: [], tasks: [], licences: { state: 'NoAccount', licensed: null, backedUp: 0, missing: null, readOn: null } });
    stub(nothing);
    const second = renderRoutes([page(<BackupTab organizationId="o1" />)], '/', testUser(['service.read', 'integrations.manage']));
    expect(await screen.findByText('A CloudAlly account is linked to this customer; its backups appear after the next read of CloudAlly.')).toBeVisible();
    second.unmount();

    stub(nothing, allKinds, false);
    renderRoutes([page(<BackupTab organizationId="o1" />)], '/', testUser(['service.read', 'integrations.manage']));
    expect(await screen.findByText('No CloudAlly account is linked to this customer.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Link a CloudAlly account' })).toHaveAttribute('href', '/admin/mappings?system=cloudally&type=Customer');
    expect(screen.queryByRole('region', { name: 'Users and sites' })).toBeNull();
  });

  it('restores a mailbox into another account of the same domain only, and hands the request to the action confirmation', async () => {
    const user = userEvent.setup();
    const fetch = stub();
    render();
    const kari = (await within(await screen.findByRole('region', { name: 'Users and sites' })).findAllByRole('listitem'))[2]!;
    await user.click(within(kari).getByRole('button', { name: 'Actions for Kari Nordmann (kari@fjord.test)' }));
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Back up now', 'Restore …']);
    await user.click(screen.getByRole('menuitem', { name: 'Restore …' }));
    const wizard = within(await screen.findByRole('dialog', { name: 'Restore Kari Nordmann (kari@fjord.test)' }));
    expect(wizard.getByRole('radio', { name: 'Download as PST' })).toBeChecked();
    await user.click(wizard.getByRole('radio', { name: 'Into another account of the same domain' }));
    await user.type(wizard.getByRole('textbox', { name: /Account to restore into/ }), 'ola@elsewhere.test');
    await user.click(wizard.getByRole('button', { name: 'Continue' }));
    expect(wizard.getByText('CloudAlly restores only into an account in fjord.test.')).toBeVisible();

    await user.clear(wizard.getByRole('textbox', { name: /Account to restore into/ }));
    await user.type(wizard.getByRole('textbox', { name: /Account to restore into/ }), 'ola@fjord.test');
    await user.click(wizard.getByRole('checkbox', { name: 'Include deleted items' }));
    await user.click(wizard.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('dialog', { name: 'Restore elsewhere' })).toBeVisible();
    const preview = fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')!;
    expect(JSON.parse(String((preview[1] as RequestInit).body))).toMatchObject({
      system: 'cloudally', kind: 'restore.other', targetType: 'backup-entity', targetId: 'ent-3',
      parameters: { task: 'task-mail', includeDeleted: true, target: 'ola@fjord.test', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    });
  });

  it('adds a user who is not in the backup through the action confirmation', async () => {
    const user = userEvent.setup();
    const fetch = stub();
    render();
    const nina = (await within(await screen.findByRole('region', { name: 'Users and sites' })).findAllByRole('listitem'))[1]!;
    await user.click(within(nina).getByRole('button', { name: 'Actions for nina@fjord.test' }));
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Add to the backup']);
    await user.click(screen.getByRole('menuitem', { name: 'Add to the backup' }));
    expect(await screen.findByRole('dialog', { name: 'Add to the backup' })).toBeVisible();
    const preview = fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')!;
    expect(JSON.parse(String((preview[1] as RequestInit).body))).toMatchObject({ kind: 'backup.activate', targetId: 'ent-2', parameters: { task: 'task-mail' } });
  });
});

describe('Backup gaps in the alert queue (M42)', () => {
  const gap = syntheticAlert({
    id: 'g2', system: 'parasoll', kind: 'Backup', externalId: 'cloudally.backup-failed:t1', title: 'The CloudAlly backup of Mail failed for 1 of 2 at Fjord IT AS',
    rule: 'cloudally.backup-failed', facts: { service: 'Mail', failed: '1', total: '2', account: 'Fjord IT AS' }, deviceName: null, machineId: null,
  });

  it('words a gap from its rule and facts in the reader’s language', () => {
    expect(alertTitle(i18n.t, gap)).toBe('Mail: the CloudAlly backup failed for 1 of 2 (Fjord IT AS)');
    expect(alertTitle(i18n.t, { ...gap, rule: 'cloudally.user-not-backed-up', facts: { licensed: '4', backedUp: '3', missing: '1' } }))
      .toBe('1 licensed Microsoft 365 user has no mailbox backup (4 licensed, 3 in backup)');
    expect(alertTitle(i18n.t, { ...gap, rule: 'cloudally.backup-paused', facts: { service: 'SharePoint', whole: 'true', account: 'Fjord IT AS' } }))
      .toBe('SharePoint: the CloudAlly backup is paused (Fjord IT AS)');
  });

  it('leads from a backup gap’s panel to the customer’s backup', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/v1/service/alerts/g2') return json({ ...gap, etag: '"v1"' });
      if (url.startsWith('/api/v1/service/alerts')) return json({ items: [], nextCursor: null, totalCount: 0, critical: 0, warning: 0, reads: [] });
      if (url.startsWith('/api/v1/actions')) return json({ items: [], nextCursor: null, totalCount: 0, uncertain: 0, waiting: 0 });
      return json({ items: [] });
    }));
    renderRoutes([page(<AlertDetailDrawer alertId="g2" onClose={() => {}} />)], '/', testUser(['service.read']));
    expect(await screen.findByRole('link', { name: 'Open the customer’s backup' })).toHaveAttribute('href', '/organizations/o1?tab=backup');
  });
});
