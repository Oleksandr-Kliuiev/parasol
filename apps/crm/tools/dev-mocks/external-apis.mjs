// Local stand-ins for external APIs, for demos, UI work and end-to-end tests without keys or internet. One server routes to a
// module per vendor:
//   PowerOffice Go API v2  — poweroffice.mjs (token, customers, contact persons, products, sales orders, outgoing invoices)
//   Atera API v3           — atera.mjs with its seed data in atera-data.mjs, plus test-only control routes under /_mock/atera
//   Enhetsregisteret       — brreg.mjs (/enhetsregisteret/api/enheter)
//   Huntress API v1        — huntress.mjs with its seed data in huntress-data.mjs (M41), test-only control routes under /_mock/huntress
//   CloudAlly partner v2   — cloudally.mjs (/cloudally/v2, M42), plus test-only control routes under /_mock/cloudally
//   Teams channel webhooks — teams.mjs (/teams/{channel}, M43), the cards read back under /_mock/teams
// Run: node tools/dev-mocks/external-apis.mjs [port]   (default 5299). Data is in memory and new on every start.
import http from 'node:http';
import { createAtera } from './atera.mjs';
import { createBrreg } from './brreg.mjs';
import { createCloudAlly } from './cloudally.mjs';
import { createHuntress } from './huntress.mjs';
import { createPowerOffice } from './poweroffice.mjs';
import { createTeams } from './teams.mjs';

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 5299);
const startedAt = new Date().toISOString();
const run = Math.random().toString(36).slice(2, 7).toUpperCase();

function orgNumber(seed) {
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  for (let n = seed; ; n++) {
    const digits = String(80000000 + (n % 19999999)).padStart(8, '0').split('').map(Number);
    let check = 11 - (digits.reduce((sum, d, i) => sum + d * weights[i], 0) % 11);
    if (check === 11) check = 0;
    if (check !== 10) return digits.join('') + check;
  }
}
const seed = Math.floor(Math.random() * 10_000_000);
// Ids differ per run so links created in an earlier run never match this run's customers.
const base = 1000 + Math.floor(Math.random() * 900_000);
// Records created through any vendor take their ids from one counter, so no two created records share an id.
let nextId = base + 100;
const newId = () => nextId++;

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const powerOffice = createPowerOffice({ base, run, seed, orgNumber, startedAt, newId, send });
// The Atera customers mirror the PowerOffice ones (same organization numbers), so both link to the same organizations.
const atera = createAtera({ customers: powerOffice.customers, base, run, orgNumber, newId, send });
const brreg = createBrreg({ send });
const huntress = createHuntress({ base, run, send });
const cloudAlly = createCloudAlly({ base, run, send });
const teams = createTeams({ send });

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      if (process.env.MOCK_LOG) console.log(new Date().toISOString(), req.method, url.pathname + url.search, body.slice(0, 300));

      if (url.pathname === '/health') return send(res, 200, { status: 'ok', run });
      if (brreg(req, res, url, body) || atera(req, res, url, body) || huntress(req, res, url, body) || cloudAlly(req, res, url, body)
        || teams(req, res, url, body) || powerOffice.handle(req, res, url, body)) return;
      send(res, 404, { title: 'Unknown mock route' });
    });
  })
  .listen(port, () => console.log(`External API mocks on http://localhost:${port} (run ${run})`));
