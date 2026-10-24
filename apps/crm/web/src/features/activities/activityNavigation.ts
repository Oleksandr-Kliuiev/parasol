export type ActivitySelection = { kind: 'all' } | { kind: 'invalid' } | { kind: 'selected'; activityId: string };

// CRM uses COMB GUIDs; their version bits need not be an RFC UUID version.
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function activitySelection(params: URLSearchParams): ActivitySelection {
  const values = params.getAll('activityId');
  if (!values.length) return { kind: 'all' };
  const value = values[0];
  if (values.length !== 1 || value === undefined || !guid.test(value) || value === '00000000-0000-0000-0000-000000000000') return { kind: 'invalid' };
  return { kind: 'selected', activityId: value.toLowerCase() };
}

export function activityUrl(organizationId: string, activityId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}?${new URLSearchParams({ tab: 'activities', activityId })}`;
}
