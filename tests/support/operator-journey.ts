import type { Page, Route } from '@playwright/test';
import { dbContext } from './operator-fixtures.ts';
import { submitToken } from './operator-ui.ts';

// Synthetic DB-shaped responses for S5-B browser cases (tests/ui). They follow packages/core/contracts.ts shapes for a
// route-intercepted client of the real built console; nothing here exists in any account and no source is contacted.
export const WS = 'demo-vardahei';
export const DB_CLIENT = { id: 'c-db', name: 'DB client (synthetic)' };
const AT = '2026-10-10T08:00:00.000Z';

export function observation(id: string, patch: Record<string, unknown> = {}, clientId = DB_CLIENT.id): Record<string, unknown> {
  return { workspaceId: WS, clientId, id, eventKey: `key-${id}`, source: 'atera', connectionId: 'conn-atera', resourceType: 'alert', externalEventId: `alert-${id}`,
    revision: '1', entityId: 'd-1', decisionRunId: null, kind: 'DISK_CAPACITY', domain: 'OPERATIONS', severity: 'MEDIUM', priority: 'NORMAL', route: 'MONITOR',
    confidence: 0.9, provider: 'rules', reasonCodes: ['RULES_BASELINE'], conflictOfEventKey: null, status: 'OPEN', acknowledgedAt: null, resolvedAt: null,
    supersededById: null, summary: `Synthetic observation ${id}`, occurredAt: AT, createdAt: AT, updatedAt: AT, ...patch };
}

/** Default DB journey page: an urgent low-confidence MONITOR Huntress incident with a conflicting NORMAL label, an alert and a ticket. */
export function journeyItems(): Record<string, unknown>[] {
  return [
    observation('obs-crit', { source: 'huntress', connectionId: 'conn-huntress', resourceType: 'incident', externalEventId: 'inc-1', kind: 'SECURITY_INCIDENT',
      domain: 'SECURITY', severity: 'CRITICAL', priority: 'NORMAL', route: 'MONITOR', confidence: 0.05, reasonCodes: ['SOURCE_URGENCY_FLOOR'],
      summary: 'Possible credential theft (synthetic)', conflictOfEventKey: 'key-earlier', supersededById: 'obs-newer' }),
    observation('obs-alert', { externalEventId: 'alert-1', summary: 'Disk usage high (synthetic)' }),
    observation('obs-ticket', { resourceType: 'ticket', externalEventId: 'ticket-7', entityId: null, status: 'ACKNOWLEDGED', acknowledgedAt: AT, summary: 'Ticket (synthetic)' })
  ];
}

export function page(items: Record<string, unknown>[], patch: Record<string, unknown> = {}): Record<string, unknown> {
  const counts: Record<string, number> = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const item of items) counts[item.severity as string]! += 1;
  return { items, counts, total: items.length, truncated: false, nextCursor: null, ...patch };
}

export function resourceView(status: string, items: unknown[] | null, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { source: 'atera', resourceType: 'alert', connectionId: 'conn-atera', status, asOf: status === 'OK' || status === 'STALE' ? AT : null,
    lastSuccessAt: status === 'MISSING' ? null : AT, safeErrorCode: status === 'OK' ? null : 'SAFE-CODE-SENTINEL', truncated: false, items, ...patch };
}
export function snapshotAlert(externalId: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { source: 'atera', resourceType: 'alert', externalId, title: `Stored alert ${externalId} (synthetic)`, status: 'Open', severity: 'MEDIUM', priority: null,
    device: { resourceType: 'agent', externalId: 'agent-1' }, occurredAt: AT, updatedAt: null, ...patch };
}

export type EvidenceCase = 'ok' | 'stale-truncated-empty';
const EVIDENCE: Record<EvidenceCase, () => Record<string, unknown>> = {
  ok: () => resourceView('OK', [snapshotAlert('alert-0'), snapshotAlert('alert-1', { severity: 'HIGH' })]),
  'stale-truncated-empty': () => resourceView('STALE', [snapshotAlert('alert-0')], { truncated: true })
};

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/** Intercepts the API for one DB-shaped client with synthetic responses (no hold), so a state can be shown at once. */
export async function serveDbClient(target: Page, evidence: EvidenceCase): Promise<void> {
  await target.route(url => /^\/(clients|tools)(\/|$)/.test(url.pathname), route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/clients') return json(route, 200, [DB_CLIENT]);
    if (path === `/clients/${DB_CLIENT.id}/overview`) return json(route, 200, dbContext(DB_CLIENT.id, WS));
    if (path === `/clients/${DB_CLIENT.id}/observations`) return json(route, 200, page(journeyItems(), { total: 40, truncated: true, nextCursor: 'opaque-cursor_2' }));
    if (path === '/tools/execute') return json(route, 201, EVIDENCE[evidence](), { 'x-atlas-correlation-id': 'corr-synthetic-1', 'x-atlas-tool-execution-id': 'exec-synthetic-1' });
    return route.fulfill({ status: 404, body: '' });
  });
}

/** Connects, selects the DB-shaped client, selects its Atera alert observation and reads its evidence. */
export async function dbJourney(target: Page, consoleUrl: string, token: string, options: { evidence: EvidenceCase }): Promise<void> {
  await serveDbClient(target, options.evidence);
  await target.goto(consoleUrl);
  await submitToken(target, token);
  await target.getByRole('button', { name: /DB client/ }).click();
  await target.locator('#queue-body .obs').filter({ hasText: 'Disk usage high' }).click();
  await target.getByRole('button', { name: 'Read the stored Atera alert list and find this alert' }).click();
  await target.locator('#evidence-body .notice').first().waitFor();
}
