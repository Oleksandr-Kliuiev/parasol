import { mockVendor, vendorFixture } from './mock-http.ts';
import type { Reply } from './mock-http.ts';

/**
 * Programmable mock of both vendors for the Gasta tenants (Huntress organization 7001, Atera customer 5001). A route only
 * matches WITH its tenant filter (organization_id, customerId or the customer path), so an unscoped request falls through
 * to 404 and fails the test. `overrides` replace single endpoints (failures, foreign records); `extra` serves other tenants.
 */
export type Endpoint = 'huntressOrganization' | 'huntressAgentsPage1' | 'huntressAgentsPage2' | 'huntressIncidents' | 'huntressIncidentsPage2'
  | 'ateraCustomer' | 'ateraAgents' | 'ateraTicketsPage1' | 'ateraTicketsPage2';
const ok = (fixture: string): Reply => ({ status: 200, body: vendorFixture(fixture) });

export function gastaVendor() {
  const overrides: Partial<Record<Endpoint, Reply>> = {};
  const state: { extra: ((url: URL) => Reply | undefined) | null } = { extra: null };
  const pick = (endpoint: Endpoint, fallback: string): Reply => overrides[endpoint] ?? ok(fallback);
  const { transport, requests } = mockVendor(url => {
    const extra = state.extra?.(url);
    if (extra) return extra;
    const q = url.searchParams;
    if (url.host === 'api.huntress.io') {
      if (url.pathname === '/v1/organizations/7001') return pick('huntressOrganization', 'huntress/organization.json');
      if (url.pathname === '/v1/agents' && q.get('organization_id') === '7001') {
        return q.get('page_token') ? pick('huntressAgentsPage2', 'huntress/agents-page-2.json') : pick('huntressAgentsPage1', 'huntress/agents-page-1.json');
      }
      if (url.pathname === '/v1/incident_reports' && q.get('organization_id') === '7001' && q.get('status') === 'sent') {
        // The fixture is one page; a second page exists only when a test overrides both pages
        return q.get('page_token') ? overrides.huntressIncidentsPage2 : pick('huntressIncidents', 'huntress/incident-reports-sent.json');
      }
    }
    if (url.host === 'app.atera.com') {
      if (url.pathname === '/api/v3/customers/5001') return pick('ateraCustomer', 'atera/customer.json');
      if (url.pathname === '/api/v3/agents/customer/5001') return pick('ateraAgents', 'atera/agents-customer.json');
      if (url.pathname === '/api/v3/tickets' && q.get('customerId') === '5001' && q.get('ticketStatus') === 'Open') {
        return q.get('page') === '2' ? pick('ateraTicketsPage2', 'atera/tickets-open-page-2.json') : pick('ateraTicketsPage1', 'atera/tickets-open-page-1.json');
      }
    }
    return undefined;
  });
  return { transport, requests, overrides, state };
}

/** Test credentials for the mock vendor only: an api key:secret pair (Huntress) and a bearer token (Atera). */
export const testSecrets = { HUNTRESS_GASTA: 'test-key:test-secret', ATERA_GASTA: `test-token-${'x'.repeat(30)}` };
