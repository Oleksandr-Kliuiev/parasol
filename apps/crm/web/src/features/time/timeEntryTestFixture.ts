import { createElement } from 'react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { TimeEntryTestHost } from './TimeEntryTestHost';
import type { TimeEntry } from './types';

export const entry: TimeEntry = { id: 'entry-one', source: 'Crm', organizationId: 'customer-one', organizationName: 'Synthetic customer',
  technicianId: 'current-technician', technicianName: 'Synthetic current employee', externalTicketId: 701,
  ticketTitle: 'Synthetic saved ticket', workDate: '2026-10-17', startedAt: null, hours: 0.75, workType: 'Remote support',
  billable: true, onsite: false, afterHours: false, description: 'Synthetic previous notes', projectId: 'project-one', projectName: 'Synthetic project',
  status: 'New', reviewNote: null, isLocked: false, allocations: [], etag: '"entry-version"', ticketId: 'ticket-one', sourceActivityId: 'task-one' };


export const renderTimeEntry = (initial: TimeEntry | null = entry, permissions = ['time.own'], probeRead = () => Promise.resolve('Synthetic time cache')) =>
  renderRoutes([page(createElement(TimeEntryTestHost, { initial: initial ?? undefined, permissions, probeRead, nextEntry: { ...entry, id: 'entry-two', hours: 2, description: 'Synthetic next entry', etag: '"next-version"' } }))], '/', testUser(permissions));
