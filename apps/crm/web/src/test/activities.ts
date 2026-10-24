import type { Activity } from '../features/activities/types';

export function syntheticActivity(id = 'task-one', overrides: Partial<Activity> = {}): Activity {
  return { id, type: 'Task', organizationId: 'customer-one', organizationName: 'Synthetic customer', opportunityId: null,
    contractId: null, contactId: null, contactName: null, subject: `Synthetic ${id}`, body: null, dueAt: null,
    durationMinutes: null, location: null, priority: 'Normal', assignee: { id: 'u1', name: 'Kari Nordmann' }, status: 'Open',
    completedAt: null, isOverdue: false, inCalendar: false, calendarSyncedAt: null, webLink: null, fromAddress: null,
    createdAt: '2026-10-16T10:00:00Z', createdBy: null, etag: '"synthetic-version"', hasTechnicalSource: true, ...overrides };
}
