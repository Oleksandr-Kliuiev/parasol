import { expect, it } from 'vitest';
import i18n from '../../i18n';
import { notificationText } from './text';
import type { Notification } from './types';

const notice = (parameters: Record<string, string>): Notification => ({
  id: 'n1', kind: 'VendorActionUncertain', parameters, organizationId: 'o1', link: '/tickets?ticket=t1&action=a1', dueDate: null, warning: true,
  isUnread: true, createdAt: '2026-10-21T12:00:00Z', emailStatus: 'Pending',
});

it('names the vendor, the action and its ticket of an action without a clear answer', () => {
  expect(notificationText(notice({ system: 'atera', kind: 'ticket.reply', ticket: '4711', organization: 'Havbris AS' }), i18n.t.bind(i18n)))
    .toBe('Atera gave no clear answer to “Reply to the customer” on ticket #4711 (Havbris AS). Check there and record what you found.');
});

it('says an action without a ticket, or of a kind the interface does not know, without inventing either', () => {
  expect(notificationText(notice({ system: 'atera', kind: 'agent.isolate' }), i18n.t.bind(i18n)))
    .toBe('Atera gave no clear answer to “agent.isolate”. Check there and record what you found.');
  expect(notificationText(notice({ system: 'atera', kind: 'time.record', ticket: '4711' }), i18n.t.bind(i18n)))
    .toBe('Atera gave no clear answer to “Record time in Atera” on ticket #4711 (—). Check there and record what you found.');
});
