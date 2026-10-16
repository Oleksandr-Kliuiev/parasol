// TEST-ONLY Node preload for actual ops CLI subprocesses (brief RC3 "Checks and stopping checkpoint"), loaded as
//   node --experimental-strip-types --import ./tests/support/m365-fetch-preload.ts scripts/ops.ts …
// It replaces the global fetch of that child process for EXACTLY the existing fixed routes — the token authority POST
// https://login.microsoftonline.com/<tenant GUID>/oauth2/v2.0/token and Graph v1.0 GETs of /organization, /users, /devices
// and /auditLogs/signIns — answering from a synthetic scenario file. Any other origin, method or path throws before any
// network access. Production code never imports this module; it adds no endpoint, transport or environment bypass:
// the production composition (packages/m365/io.ts) still builds its fixed URLs and calls fetch as always.
// Control is a file barrier in one temp directory (ATLAS_TEST_M365_PRELOAD_DIR): scenario.json (rewritten by the test
// between processes), calls.jsonl (receipts: method + path only), and hold/release files for one held response.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Reply { status: number; headers?: Record<string, string>; body?: unknown }
interface Scenario {
  tenant: string; users?: unknown[]; devices?: unknown[]; signIns?: { id: string; createdDateTime: string; [key: string]: unknown }[];
  /** Fixed reply per endpoint path (e.g. '/v1.0/users': 429 with retry-after) instead of the data reply. */
  replies?: Record<string, Reply>;
  /** Endpoint path whose FIRST request in this process waits for `<dir>/release` after writing `<dir>/held`. */
  hold?: string;
}
const dir = process.env.ATLAS_TEST_M365_PRELOAD_DIR;
if (!dir) throw new Error('m365-fetch-preload: ATLAS_TEST_M365_PRELOAD_DIR is required (test-only preload)');
const scenario = (): Scenario => JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) as Scenario;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRAPH_PATHS = new Set(['/v1.0/organization', '/v1.0/users', '/v1.0/devices', '/v1.0/auditLogs/signIns']);
let tokens = 0; let held = false;

const json = (reply: Reply) => new Response(reply.body === undefined ? null : JSON.stringify(reply.body),
  { status: reply.status, headers: { 'content-type': 'application/json', ...reply.headers } });
async function waitForRelease(): Promise<void> {
  writeFileSync(join(dir!, 'held'), String(process.pid));
  for (let i = 0; i < 600 && !existsSync(join(dir!, 'release')); i++) await new Promise(resolve => setTimeout(resolve, 50));
}
function signInPage(url: URL, s: Scenario): Reply {
  const filter = /^createdDateTime ge (\S+) and createdDateTime le (\S+)$/.exec(url.searchParams.get('$filter') ?? '');
  if (!filter) return { status: 400, body: { error: { code: 'BadRequest' } } };
  const from = Date.parse(filter[1]!); const to = Date.parse(filter[2]!);
  const top = Number(url.searchParams.get('$top') ?? '500');
  const rows = (s.signIns ?? []).filter(r => { const t = Date.parse(r.createdDateTime); return t >= from && t <= to; }).slice(0, top);
  return { status: 200, body: { value: rows } };
}

const original = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const url = new URL(raw);
  const token = url.origin === 'https://login.microsoftonline.com' && method === 'POST' && /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url.pathname);
  const graph = url.origin === 'https://graph.microsoft.com' && method === 'GET' && GRAPH_PATHS.has(url.pathname) && url.search.length > 1;
  if (!(token && TENANT.test(token[1]!) && url.search === '') && !graph) {
    throw new Error('m365-fetch-preload: unrecognized request refused before any network access');
  }
  appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ method, path: url.pathname })}\n`);
  const s = scenario();
  if (s.hold === url.pathname && !held) { held = true; await waitForRelease(); }
  if (token) return json({ status: 200, body: { token_type: 'Bearer', access_token: `synthetic-preload-token-${++tokens}`, expires_in: 3600 } });
  const fixed = s.replies?.[url.pathname];
  if (fixed) return json(fixed);
  if (url.pathname === '/v1.0/organization') return json({ status: 200, body: { value: [{ id: s.tenant }] } });
  if (url.pathname === '/v1.0/auditLogs/signIns') return json(signInPage(url, s));
  const top = Number(url.searchParams.get('$top') ?? '500');
  return json({ status: 200, body: { value: ((url.pathname === '/v1.0/users' ? s.users : s.devices) ?? []).slice(0, top) } });
}) as typeof fetch;
void original; // the real fetch is never called from this process
