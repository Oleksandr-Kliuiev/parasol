import { createElement } from 'react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { syntheticActivity } from '../../test/activities';
import { ActivityNavigationTestHost } from './ActivityNavigationTestHost';
import type { Activity } from './types';

export const organizationId = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
export const otherOrganizationId = 'bbbbbbbb-1111-2222-3333-cccccccccccc';
export const activityId = '11111111-2222-abcd-cdef-333333333333';
export const otherActivityId = '22222222-3333-bcde-def0-444444444444';
export const first = syntheticActivity(activityId, { organizationId });
export const second = syntheticActivity(otherActivityId, { organizationId, subject: 'Synthetic second activity' });
export const permissions = ['activities.read', 'activities.write'];
export const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
export const result = (items: Activity[] = [first]) => response({ items, nextCursor: null, totalCount: items.length });
export const isActivityRead = (url: string) => new URL(url, 'https://synthetic.invalid').pathname === '/api/v1/activities/';
export const selectedPath = (id = activityId, extra = '') => `/organizations/${organizationId}?tab=activities&activityId=${id}${extra}`;

export const renderSelection = (path = selectedPath(), allowed = permissions) =>
  renderRoutes([page(createElement(ActivityNavigationTestHost, { allowed, otherActivityId, otherOrganizationId, activityId }), '/organizations/:id')], path, testUser(allowed));

export function auxiliary(url: string): Response | null {
  if (url.endsWith('/outlook/status')) return response({ calendar: false, mail: false });
  if (url.startsWith('/api/v1/identity/users')) return response({ items: [], nextCursor: null, totalCount: 0 });
  return null;
}
