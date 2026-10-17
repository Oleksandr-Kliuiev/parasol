import { createElement } from 'react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { syntheticActivity } from '../../test/activities';
import { TaskTicketTestHost } from './TaskTicketTestHost';
import type { TaskTicketAssociation, TicketWorkRef } from './taskTicketTypes';

export const task = syntheticActivity('task-one', { assignee: { id: 'another-employee', name: 'Synthetic other employee' }, dueAt: '2026-01-01T12:00:00Z' });
export const ticket: TicketWorkRef = { id: 'ticket-one', organizationId: task.organizationId, externalId: 701,
  title: 'Synthetic saved ticket', status: 'Open', importedAt: '2026-10-17T08:00:00Z' };
export const otherTicket: TicketWorkRef = { ...ticket, id: 'ticket-two', externalId: 702, title: 'Synthetic second saved ticket' };
export const allowed = ['activities.read', 'activities.write', 'service.read', 'time.own'];
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
export const association = (saved: TicketWorkRef | null = null, overrides: Partial<TaskTicketAssociation> = {}): TaskTicketAssociation => ({
  activityId: task.id, organizationId: task.organizationId, ticketId: saved?.id ?? null, ticket: saved,
  available: Boolean(saved), etag: '"association-version"', ...overrides,
});
export const pageOf = (items: TicketWorkRef[] = [ticket], nextCursor: string | null = null, totalCount = items.length) => json({ items, nextCursor, totalCount });
export const auxiliary = (url: string) => url.endsWith('/work-types') ? json(['Remote support'])
  : url.startsWith('/api/v1/projects') ? json({ items: [], nextCursor: null, totalCount: 0 })
    : url.startsWith('/api/v1/customers/organizations') ? json({ items: [{ id: 'customer-one', name: 'Synthetic customer' }, { id: 'customer-two', name: 'Synthetic customer two' }], nextCursor: null, totalCount: 2 }) : null;


export const renderTaskTicket = (permissions = allowed, activity = task) =>
  renderRoutes([page(createElement(TaskTicketTestHost, { permissions, activity }))], '/', testUser(permissions));
