// Resolves the existing Development role identities after local.py serve; no production auth changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { request } = require('playwright');
const path = process.argv[2];
if (!path) throw new Error('Usage: node tools/load-test/provision.mjs /tmp/dev16-smoke/dataset.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const origin = new URL(manifest.baseUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' ||
    !/^crm_load_dev16_[a-z0-9_]+$/.test(manifest.database.name) || manifest.auth.mode !== 'Development') throw new Error('Only isolated local Development environments are supported');
for (const user of manifest.auth.users) {
  if (!['Crm.Sales', 'Crm.Technician', 'Crm.ServiceLead', 'Crm.Finance', 'Crm.Management', 'Crm.Admin', 'Crm.ReadOnly'].includes(user.role)) throw new Error('Unknown synthetic role');
  const client = await request.newContext({ baseURL: manifest.baseUrl, ignoreHTTPSErrors: true });
  try {
    const login = await client.get(`/bff/dev-login?role=${user.role}&returnUrl=/`, { maxRedirects: 0 });
    if (login.status() !== 302) throw new Error(`Development sign-in failed: ${login.status()}`);
    const response = await client.get('/bff/user');
    if (!response.ok()) throw new Error(`Identity lookup failed: ${response.status()}`);
    const profile = await response.json();
    if (!profile.roles.includes(user.role) || profile.authMode !== 'Development') throw new Error('Unexpected authentication context');
    user.userId = profile.id;
  } finally { await client.dispose(); }
}
manifest.auth.distinctIdentities = manifest.auth.users.length;
manifest.auth.note = 'Concurrent virtual users have separate sessions; the existing Development harness reuses one identity per role. Real Entra and 50 distinct identities require EXT-05.';
writeFileSync(path, JSON.stringify(manifest, null, 2)+'\n');
console.log(`Provisioned ${manifest.auth.users.length} synthetic role identities; no credentials saved to the manifest.`);
