import { expect, test } from '@playwright/test';
import { fixture, json, staffContext } from './support';
import { parseObservationQueue } from '../src/features/parasol/observationQueueContract';

test('a device opens its complete actual history, keeps source uncertainty and cannot borrow another device continuation', async ({ browser }) => {
  const f = fixture(); const staff = await staffContext(browser, 'Crm.Admin', `/organizations/${f.target.customerId}`);
  const page = staff.page;
  const path = `/api/v1/parasol/customers/${f.target.customerId}/observations`;
  try {
    const panel = page.getByRole('region', { name: 'Technical workspace · Atlas', exact: true });
    await panel.getByRole('tab', { name: 'Atlas devices', exact: true }).click();
    const devices = () => panel.getByRole('region', { name: 'Atlas devices', exact: true });
    const action = (id: string) => devices().getByRole('listitem').filter({ has: page.getByText(`Atlas device ID: ${id}`, { exact: true }) }).getByRole('button');
    const ready = page.waitForResponse(r => new URL(r.url()).pathname === path && new URL(r.url()).searchParams.get('deviceId') === f.target.confirmedDeviceId);
    await action(f.target.confirmedDeviceId).click();
    const first = parseObservationQueue(await (await ready).json(), f.target.customerId,
      { severity: 'ALL', status: 'ACTIVE', cursor: null, deviceId: f.target.confirmedDeviceId });
    expect(first.status).toBe('READY'); if (!first.queue) throw new Error('A validated actual device page is required.');
    expect(first.queue.total).toBe(125); expect(first.queue.severityCounts.MEDIUM).toBe(119);
    const queue = panel.getByRole('region', { name: 'Observation queue and history', exact: true });
    await expect(queue.getByText(`Selected device: ${f.target.duplicateHostname}`, { exact: true })).toBeVisible();
    await expect(queue.getByText('Page 1 · 25 records loaded', { exact: true })).toBeVisible();
    const all = [...first.queue.items]; let current = first.queue; let pages = 1;
    while (current.nextCursor !== null) {
      const cursor = current.nextCursor;
      const pending = page.waitForResponse(r => {
        const url = new URL(r.url()); return url.pathname === path && url.searchParams.get('cursor') === cursor;
      });
      await queue.getByRole('button', { name: 'Next page', exact: true }).click();
      const next = parseObservationQueue(await (await pending).json(), f.target.customerId,
        { severity: 'ALL', status: 'ACTIVE', cursor, deviceId: f.target.confirmedDeviceId });
      expect(next.status).toBe('READY'); if (!next.queue) throw new Error('A validated actual continuation is required.');
      current = next.queue; all.push(...current.items); pages++;
      expect(pages).toBeLessThanOrEqual(5);
      await expect(queue.getByText(`Page ${pages} · ${current.items.length} records loaded`, { exact: true })).toBeVisible();
    }
    expect(pages).toBe(5); expect(new Set(all.map(o => o.id)).size).toBe(125);
    expect(all.every(o => o.deviceId === f.target.confirmedDeviceId)).toBe(true);
    expect(all.some(o => o.id === f.target.unconfirmedObservationId)).toBe(false);
    expect(all.some(o => o.id === f.target.observationIdOutsideFirst100)).toBe(true);
    await expect(queue.getByText(f.target.observationSummaryOutsideFirst100, { exact: true })).toBeVisible();
    const changed = await json(await page.request.get(`${path}?deviceId=${encodeURIComponent(f.target.unconfirmedDeviceId)}&cursor=${encodeURIComponent(first.queue.nextCursor!)}`), 'Actual cross-device continuation') as { status: string; queue: unknown };
    expect(changed.status).toBe('INVALID_CURSOR'); expect(changed.queue).toBeNull();
    await queue.getByLabel('Queue state', { exact: true }).selectOption('RESOLVED');
    await expect(queue.getByText(f.target.resolvedSummary, { exact: true })).toBeVisible();
    await expect(queue.getByText('Matching observations across Atlas: 1', { exact: true })).toBeVisible();
    await queue.getByRole('button', { name: 'Back to device', exact: true }).click();
    await expect(action(f.target.confirmedDeviceId)).toBeFocused();
    await action(f.target.unconfirmedDeviceId).click();
    await expect(queue.getByText(f.target.unconfirmedSummary, { exact: true })).toBeVisible();
    await expect(queue.getByText('No confirmed device for this source in the current registry', { exact: true })).toBeVisible();
    await expect(queue.getByText('Matching observations across Atlas: 1', { exact: true })).toBeVisible();
    await queue.getByRole('button', { name: 'All devices · keep other filters', exact: true }).click();
    await expect(queue.getByRole('heading', { name: 'Observation queue and history', exact: true })).toBeFocused();
    await expect(queue.getByText('Matching observations across Atlas: 126', { exact: true })).toBeVisible();
    const unavailable = await json(await page.request.get(`${path}?deviceId=${encodeURIComponent(f.clients[1]!.deviceIds[0]!)}`), 'Foreign device admission in the current customer') as { status: string; queue: unknown };
    expect(unavailable.status).toBe('DEVICE_NOT_AVAILABLE'); expect(unavailable.queue).toBeNull();
  } finally { await staff.context.close(); }
});
