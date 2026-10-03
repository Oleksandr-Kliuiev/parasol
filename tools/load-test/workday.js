// k6 scenario "a working day" (NFR-01, NFR-01b): the reads a CRM user actually makes, at the pace 50 people would.
// Run against a test environment with development sign-in, never production:
//   k6 run -e BASE_URL=http://localhost:5180 tools/load-test/workday.js
//   k6 run -e BASE_URL=https://crm-test.example.no -e VUS=50 -e DURATION=10m tools/load-test/workday.js
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const baseUrl = (__ENV.BASE_URL ?? 'http://localhost:5180').replace(/\/$/, '');
const vus = Number(__ENV.VUS ?? 20);
const duration = __ENV.DURATION ?? '2m';
// Roles are weighted the way the company works: mostly service and sales, a few in finance.
const roles = ['Crm.Sales', 'Crm.Sales', 'Crm.Technician', 'Crm.Technician', 'Crm.ServiceLead', 'Crm.Finance', 'Crm.Management'];

const readTrend = new Trend('crm_read_ms', true);
const searchTrend = new Trend('crm_search_ms', true);

export const options = {
  scenarios: {
    workday: { executor: 'constant-vus', vus, duration },
  },
  thresholds: {
    // NFR-01: p95 of a read stays under 500 ms, the global search under a second (NFR-01b).
    crm_read_ms: ['p(95)<500'],
    crm_search_ms: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

/** Signs in through the development endpoint and keeps the session cookie for this virtual user. */
export function setup() {
  const role = roles[0];
  const response = http.get(`${baseUrl}/bff/dev-login?role=${role}&returnUrl=/`, { redirects: 0 });
  check(response, { 'dev sign-in is available': (r) => r.status === 302 || r.status === 200 });
  return { ready: true };
}

function read(name, path, trend = readTrend) {
  const response = http.get(`${baseUrl}${path}`, { headers: { Accept: 'application/json' }, tags: { name } });
  trend.add(response.timings.duration);
  check(response, { [`${name} answers`]: (r) => r.status === 200 || r.status === 403 });
  return response;
}

export default function workday() {
  const role = roles[Math.floor(Math.random() * roles.length)];
  // Each iteration is one person picking up the CRM: sign in, look at the day, open a customer, search.
  http.get(`${baseUrl}/bff/dev-login?role=${role}&returnUrl=/`, { redirects: 0 });

  group('my day', () => {
    read('bff/user', '/bff/user');
    read('reminders', '/api/v1/contracts/reminders?mine=true');
    read('notifications', '/api/v1/notifications?unreadOnly=true&limit=15');
    read('my organizations', '/api/v1/customers/organizations?limit=25');
  });

  group('customer card', () => {
    const list = read('organizations', '/api/v1/customers/organizations?limit=25');
    let organizationId = null;
    try {
      organizationId = list.json('items.0.id');
    } catch {
      organizationId = null;
    }

    if (organizationId) {
      read('organization', `/api/v1/customers/organizations/${organizationId}`);
      read('contacts', `/api/v1/customers/organizations/${organizationId}/contacts`);
      read('contracts', `/api/v1/contracts?organizationId=${organizationId}`);
      read('service summary', `/api/v1/service/organizations/${organizationId}/summary`);
      read('subscriptions', `/api/v1/licensing/subscriptions?organizationId=${organizationId}`);
      read('invoices', `/api/v1/billing/invoices?organizationId=${organizationId}`);
    }
  });

  group('search and reports', () => {
    read('search', '/api/v1/search?q=as', searchTrend);
    read('pipeline', '/api/v1/sales/pipeline');
    read('dashboard', '/api/v1/reports/dashboard?months=6');
    read('time entries', '/api/v1/time/entries?mine=true');
  });

  // A person reads a screen for a few seconds before the next click.
  sleep(Math.random() * 3 + 2);
}
