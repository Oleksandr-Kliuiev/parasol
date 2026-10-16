// Client list from Atera (owner decision 2026-10-14), run in the one-shot `admin` container (docs/deploy/DEPLOY.md "Клиенты").
//   node --experimental-strip-types deploy/sync-clients.ts [--apply]
// Every Atera customer becomes an Atlas client (id = slug of the name; an existing client bound to that customer is kept), with the
// memberships of the template client copied, and an Atera connection (tenant = Atera customer ID, the MSP-wide key ATERA_VARDAHEI).
// A Huntress organization is bound ONLY on a unique exact normalized name match (a name is a proposal for binding the client, never
// identity proof of an entity link). Microsoft 365 is not bound here: it needs the customer's consent or GDAP; the script only reports
// the tenant candidates that the Atera domain resolves to. Customers named like a test are skipped. Idempotent; without --apply it plans.
// Writes /secrets/jobs.auto (one scheduler job per connection) that deploy/setup.ts merges into ATLAS_SYNC_JOBS. Prints names and counts only.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const apply = process.argv.includes('--apply');
const S = process.env.ATLAS_SECRETS_DIR ?? '/secrets';
const readEnv = (file: string): Record<string, string> => !existsSync(`${S}/${file}`) ? {} : Object.fromEntries(readFileSync(`${S}/${file}`, 'utf8').split('\n')
  .filter(l => /^[A-Z][A-Z0-9_]*=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const gen = readEnv('generated.env'); const owner = readEnv('secrets.env'); const site = readEnv('atlas.env'); const tokens = readEnv('tokens.env'); const sched = readEnv('scheduler.env');
const WORKSPACE = site.ATLAS_WORKSPACE ?? 'vardahei'; const TEMPLATE = (site.ATLAS_CLIENTS ?? 'vardahei-it=x').split(';')[0]!.split('=')[0]!;
const need = (o: Record<string, string>, k: string) => { if (!o[k]) throw new Error(`missing ${k}`); return o[k]!; };

const strip = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a');
const norm = (s: string) => strip(s).replace(/\([^)]*\)/g, ' ').replace(/\b(as|asa|ab|ltd|inc|gmbh|sa|ans|da)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (s: string) => strip(s).replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'client';

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${new URL(url).host}`);
  return r.json();
}
const ateraH = { Authorization: `Bearer ${need(owner, 'ATERA_VARDAHEI')}` };
const huntressH = { Authorization: `Basic ${Buffer.from(need(owner, 'HUNTRESS_VARDAHEI')).toString('base64')}` };

const customers: { id: number; name: string; domain: string | null }[] = [];
for (let p = 1; p <= 40; p++) {
  const b = await getJson(`https://app.atera.com/api/v3/customers?page=${p}&itemsInPage=50`, ateraH);
  for (const c of b.items ?? []) customers.push({ id: c.CustomerID, name: String(c.CustomerName), domain: c.Domain ? String(c.Domain).toLowerCase() : null });
  if (p >= (b.totalPages ?? 1)) break;
}
const orgs: { id: number; name: string }[] = []; let token: string | null = null;
for (let i = 0; i < 40; i++) {
  const b = await getJson(`https://api.huntress.io/v1/organizations?limit=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`, huntressH);
  for (const o of b.organizations ?? []) orgs.push({ id: o.id, name: String(o.name) });
  token = b.pagination?.next_page_token ?? null; if (!token) break;
}
const orgByName = new Map<string, { id: number; name: string }[]>();
for (const o of orgs) orgByName.set(norm(o.name), [...(orgByName.get(norm(o.name)) ?? []), o]);

const db = new pg.Client({ connectionString: need(gen, 'ATLAS_OWNER_DATABASE_URL') }); await db.connect();
const existingClients = new Set<string>((await db.query(`SELECT id FROM "Client" WHERE "workspaceId" = $1`, [WORKSPACE])).rows.map(r => r.id));
const conns = (await db.query(`SELECT "clientId", system, "externalTenantId" FROM "Connection" WHERE "workspaceId" = $1`, [WORKSPACE])).rows as { clientId: string; system: string; externalTenantId: string }[];
const clientOf = (system: string, tenant: string) => conns.find(c => c.system === system && c.externalTenantId === tenant)?.clientId;

const plan: { customer: typeof customers[number]; client: string; isNew: boolean; atera: boolean; huntress: { id: number; name: string } | null }[] = [];
const skipped: string[] = []; const ambiguous: string[] = []; const used = new Set(existingClients);
for (const c of customers) {
  if (/test/i.test(c.name)) { skipped.push(c.name); continue; }
  let client = clientOf('atera', String(c.id)); const isNew = !client;
  if (!client) { client = slug(c.name); if (used.has(client)) client = `${client.slice(0, 45)}-${c.id}`; used.add(client); }
  const matches = orgByName.get(norm(c.name)) ?? [];
  if (matches.length > 1) ambiguous.push(c.name);
  const huntress = matches.length === 1 && !conns.some(x => x.clientId === client && x.system === 'huntress') && !clientOf('huntress', String(matches[0]!.id)) ? matches[0]! : null;
  plan.push({ customer: c, client, isNew, atera: !conns.some(x => x.clientId === client && x.system === 'atera'), huntress });
}
const msCandidates = new Map<string, string>();
for (const p of plan) if (p.customer.domain) {
  try { const j = await getJson(`https://login.microsoftonline.com/${encodeURIComponent(p.customer.domain)}/.well-known/openid-configuration`, {});
    const m = /login\.microsoftonline\.com\/([0-9a-f-]{36})\//.exec(String(j.issuer ?? j.token_endpoint)); if (m) msCandidates.set(p.client, p.customer.domain); } catch { /* no tenant for that domain */ }
}
console.log(`Atera customers ${customers.length}; test-like skipped ${skipped.length}; planned ${plan.length} (new clients ${plan.filter(p => p.isNew).length}, Atera binds ${plan.filter(p => p.atera).length}); `
  + `Huntress orgs ${orgs.length}, unique exact name matches to bind ${plan.filter(p => p.huntress).length}, ambiguous ${ambiguous.length}; Microsoft tenants resolvable from the Atera domain ${msCandidates.size}`);
const unmatched = plan.filter(p => !p.huntress && !conns.some(x => x.clientId === p.client && x.system === 'huntress')).map(p => p.customer.name);
console.log(`without a Huntress organization by name (${unmatched.length}): ${unmatched.join('; ')}`);
if (!apply) { await db.end(); console.log('plan only (no --apply)'); process.exit(0); }

await db.query('BEGIN');
try {
  for (const p of plan.filter(x => x.isNew)) {
    await db.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [WORKSPACE, p.client, p.customer.name.slice(0, 200)]);
    await db.query(`INSERT INTO "ClientMembership" ("workspaceId", "clientId", "actorId", permissions)
      SELECT "workspaceId", $2, "actorId", permissions FROM "ClientMembership" WHERE "workspaceId" = $1 AND "clientId" = $3 ON CONFLICT DO NOTHING`, [WORKSPACE, p.client, TEMPLATE]);
  }
  await db.query('COMMIT');
} catch (e) { await db.query('ROLLBACK'); throw e; }
await db.end();

const childEnv = { ...process.env, ...sched, ATLAS_OPERATOR_TOKEN: need(tokens, 'ATLAS_SCHEDULER_TOKEN') };
const ops = (args: string[]) => { const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/ops.ts', ...args], { env: childEnv, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').slice(0, 300) }; };
let bound = 0; const failures: string[] = [];
for (const p of plan) {
  if (p.atera) { const r = ops(['bind', '--client', p.client, '--connection', `${p.client}-atera`, '--system', 'atera', '--tenant', String(p.customer.id), '--secret-ref', 'env://ATERA_VARDAHEI']);
    if (r.code === 0) bound++; else failures.push(`${p.customer.name}: atera bind exit ${r.code}`); }
  if (p.huntress) { const r = ops(['bind', '--client', p.client, '--connection', `${p.client}-huntress`, '--system', 'huntress', '--tenant', String(p.huntress.id), '--secret-ref', 'env://HUNTRESS_VARDAHEI']);
    if (r.code === 0) bound++; else failures.push(`${p.customer.name}: huntress bind exit ${r.code}`); }
}
console.log(`bound connections: ${bound}; failures: ${failures.length}${failures.length ? ' → ' + failures.join('; ') : ''}`);
// One scheduler job per Atera/Huntress connection that the hand-written ATLAS_SYNC_JOBS does not already name.
const db2 = new pg.Client({ connectionString: need(gen, 'ATLAS_OWNER_DATABASE_URL') }); await db2.connect();
const all = (await db2.query(`SELECT "clientId", id, system FROM "Connection" WHERE "workspaceId" = $1 AND system IN ('atera', 'huntress') ORDER BY "clientId", id`, [WORKSPACE])).rows as { clientId: string; id: string; system: string }[];
await db2.end();
const manual = site.ATLAS_SYNC_JOBS ?? '';
const jobs = all.map(c => `live-read:${c.clientId}:${c.id}@15m`).filter(j => !manual.includes(j.slice(0, j.lastIndexOf('@'))));
writeFileSync(`${S}/jobs.auto`, jobs.join('\n') + '\n', { mode: 0o600 }); chmodSync(`${S}/jobs.auto`, 0o600);
console.log(`jobs.auto written: ${jobs.length} job(s); next: deploy/setup.ts, then restart the scheduler`);
