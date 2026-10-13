// Owner-side setup of the deployed Atlas (docs/deploy/DEPLOY.md). Runs in the one-shot `admin` container with the secrets directory
// mounted at /secrets. Idempotent: an existing role, workspace, client, actor, membership or token is kept, never rotated or widened.
//   1. prisma migrate deploy (owner), 2. prisma/roles.sql with the generated role passwords (owner),
//   3. workspace, clients, actors (people, the scheduler, service clients) with per-client permissions and their API tokens,
//   4. renders the per-container env files (api.env, scheduler.env, oauth2.env) holding only what each container needs.
// Values are written to 0600 files and never printed; stdout carries names and counts only.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const S = process.env.ATLAS_SECRETS_DIR ?? '/secrets';
const readEnv = (file: string): Record<string, string> => !existsSync(`${S}/${file}`) ? {} : Object.fromEntries(readFileSync(`${S}/${file}`, 'utf8').split('\n')
  .filter(l => /^[A-Z][A-Z0-9_]*=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const writeEnv = (file: string, values: Record<string, string>) => {
  writeFileSync(`${S}/${file}`, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 }); chmodSync(`${S}/${file}`, 0o600);
};
const gen = readEnv('generated.env'); const owner = readEnv('secrets.env'); const site = readEnv('atlas.env');
const need = (o: Record<string, string>, k: string) => { if (!o[k]) throw new Error(`missing ${k}`); return o[k]!; };
const token = () => `atl_${randomBytes(32).toString('base64url')}`;
const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

const WORKSPACE = site.ATLAS_WORKSPACE ?? 'vardahei';
const CLIENTS: [string, string][] = (site.ATLAS_CLIENTS ?? 'vardahei-it=Vardahei IT (intern)').split(';').map(p => p.split('=') as [string, string]);
const PEOPLE = (site.ATLAS_PEOPLE ?? 'oleksandr@vardahei.no;asbjorn@vardahei.no;bjarte@vardahei.no').split(';').map(e => e.trim().toLowerCase());
const SERVICES = (site.ATLAS_SERVICES ?? 'svc-integration').split(';').map(s => s.trim()).filter(Boolean);
const FULL = ['connections:manage', 'events:ingest', 'context:read', 'm365:read', 'mapping:review'];
const actorId = (email: string) => email.split('@')[0]!.replace(/[^a-z0-9-]/g, '-');
const envName = (prefix: string, id: string) => `${prefix}_${id.toUpperCase().replace(/-/g, '_')}`;

// 1. migrations
const ownerUrl = need(gen, 'ATLAS_OWNER_DATABASE_URL');
const migrate = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: ownerUrl } });
if (migrate.status !== 0) throw new Error(`migrate deploy failed: ${(migrate.stderr || migrate.stdout).slice(-1500)}`);
console.log('migrations:', /No pending migrations/.test(migrate.stdout) ? 'up to date' : 'applied');

// 2. roles.sql (default role names) — the psql include and password variables substituted as psql would
const q = (v: string) => { if (!/^[A-Za-z0-9]{16,128}$/.test(v)) throw new Error('role password format'); return `'${v}'`; };
const rolesSql = readFileSync('prisma/roles.sql', 'utf8').split('\n').map(l => l === '\\ir roles/reval.sql' ? readFileSync('prisma/roles/reval.sql', 'utf8') : l).join('\n')
  .replace(":'atlas_app_password'", q(need(gen, 'ATLAS_APP_PASSWORD'))).replace(":'atlas_cleanup_runner_password'", q(need(gen, 'ATLAS_RUNNER_PASSWORD')))
  .replace(":'atlas_poweroffice_runner_password'", q(need(gen, 'ATLAS_PO_RUNNER_PASSWORD'))).replace(":'atlas_reval_reader_password'", q(need(gen, 'ATLAS_REVAL_READER_PASSWORD')));
const db = new pg.Client({ connectionString: ownerUrl }); await db.connect();
await db.query(rolesSql); console.log('roles.sql applied');

// 3. workspace, clients, actors, memberships, tokens (insert if absent)
const tokens: Record<string, string> = readEnv('tokens.env');
const ensureActor = async (id: string, name: string, workspacePermissions: string[], perms: string[], tokenEnv: string) => {
  await db.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName", status, "workspacePermissions") VALUES ($1, $2, $3, 'ACTIVE', $4) ON CONFLICT DO NOTHING`,
    [WORKSPACE, id, name, workspacePermissions]);
  for (const [client] of CLIENTS) await db.query(`INSERT INTO "ClientMembership" ("workspaceId", "clientId", "actorId", permissions) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [WORKSPACE, client, id, perms]);
  if (!tokens[tokenEnv]) {
    tokens[tokenEnv] = token();
    await db.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash", label) VALUES ($1, $2, $3, $4, $5)`,
      [WORKSPACE, `tok-${id}-${randomBytes(4).toString('hex')}`, id, hashToken(tokens[tokenEnv]!), `deploy ${new Date().toISOString().slice(0, 10)}`]);
  }
};
await db.query('BEGIN');
try {
  await db.query(`INSERT INTO "Workspace" (id, name) VALUES ($1, 'Vardahei') ON CONFLICT DO NOTHING`, [WORKSPACE]);
  for (const [id, name] of CLIENTS) await db.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [WORKSPACE, id, name]);
  for (const email of PEOPLE) await ensureActor(actorId(email), email, ['security_audit:read'], FULL, envName('ATLAS_USER_TOKEN', actorId(email)));
  await ensureActor('scheduler', 'Automatic sync', [], ['connections:manage', 'events:ingest'], 'ATLAS_SCHEDULER_TOKEN');
  for (const svc of SERVICES) await ensureActor(svc, `Service client ${svc}`, [], ['context:read', 'm365:read'], envName('ATLAS_SERVICE_TOKEN', svc));
  await db.query('COMMIT');
} catch (e) { await db.query('ROLLBACK'); throw e; }
await db.end();
writeEnv('tokens.env', tokens);
console.log(`actors: ${PEOPLE.length} people, scheduler, ${SERVICES.length} service client(s); clients: ${CLIENTS.map(c => c[0]).join(', ')}`);

// 4. per-container env files
const host = '@atlas-admin-db:5432/atlas';
const runtimeUrl = `postgresql://atlas_app:${need(gen, 'ATLAS_APP_PASSWORD')}${host}`;
const cursor = { ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://ATLAS_CORRELATION_CURSOR_SECRET', ATLAS_CORRELATION_CURSOR_SECRET: need(gen, 'ATLAS_CORRELATION_CURSOR_SECRET') };
const people = Object.fromEntries(PEOPLE.map(e => [envName('ATLAS_USER_TOKEN', actorId(e)), tokens[envName('ATLAS_USER_TOKEN', actorId(e))]!]));
writeEnv('api.env', { ATLAS_RUNTIME_DATABASE_URL: runtimeUrl, ...cursor, ATLAS_PROXY_SECRET: need(gen, 'ATLAS_PROXY_SECRET'),
  ATLAS_PROXY_USERS: PEOPLE.map(e => `${e}=${envName('ATLAS_USER_TOKEN', actorId(e))}`).join(';'), ...people });
const vendor = Object.fromEntries(Object.entries(owner).filter(([k]) => /^(ATERA|HUNTRESS|M365)_/.test(k)));
writeEnv('scheduler.env', { ATLAS_RUNTIME_DATABASE_URL: runtimeUrl, ATLAS_OPERATOR_TOKEN: tokens.ATLAS_SCHEDULER_TOKEN!, ...cursor, ...vendor,
  ATLAS_M365_CLEANUP_RUNNER_URL: `postgresql://atlas_m365_cleanup_runner:${need(gen, 'ATLAS_RUNNER_PASSWORD')}${host}`,
  ATLAS_M365_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_M365_CLEANUP_RUNNER_URL', ATLAS_SYNC_JOBS: site.ATLAS_SYNC_JOBS ?? '' });
const tenant = need(site, 'ATLAS_ENTRA_TENANT_ID');
writeEnv('oauth2.env', {
  OAUTH2_PROXY_PROVIDER: 'oidc', OAUTH2_PROXY_PROVIDER_DISPLAY_NAME: 'Microsoft', OAUTH2_PROXY_OIDC_ISSUER_URL: `https://login.microsoftonline.com/${tenant}/v2.0`,
  OAUTH2_PROXY_CLIENT_ID: need(site, 'ATLAS_ENTRA_LOGIN_CLIENT_ID'), OAUTH2_PROXY_CLIENT_SECRET: owner.OAUTH2_PROXY_CLIENT_SECRET ?? '',
  OAUTH2_PROXY_SCOPE: 'openid profile email', OAUTH2_PROXY_OIDC_EMAIL_CLAIM: 'preferred_username', OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL: 'true',
  OAUTH2_PROXY_EMAIL_DOMAINS: 'vardahei.no', OAUTH2_PROXY_COOKIE_SECRET: need(gen, 'OAUTH2_PROXY_COOKIE_SECRET'), OAUTH2_PROXY_COOKIE_NAME: '_atlas_auth',
  OAUTH2_PROXY_COOKIE_SECURE: 'true', OAUTH2_PROXY_PROXY_PREFIX: '/auth', OAUTH2_PROXY_REDIRECT_URL: 'https://admin.vardahei.tech/auth/callback',
  OAUTH2_PROXY_UPSTREAMS: 'http://atlas-admin-api:3100/', OAUTH2_PROXY_HTTP_ADDRESS: '0.0.0.0:4180', OAUTH2_PROXY_REVERSE_PROXY: 'true',
  OAUTH2_PROXY_PASS_BASIC_AUTH: 'true', OAUTH2_PROXY_PREFER_EMAIL_TO_USER: 'true', OAUTH2_PROXY_BASIC_AUTH_PASSWORD: need(gen, 'ATLAS_PROXY_SECRET'),
  OAUTH2_PROXY_PASS_ACCESS_TOKEN: 'false', OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: 'true', OAUTH2_PROXY_API_ROUTES: '^/(clients|tools|session|audit|ask)',
  OAUTH2_PROXY_SKIP_AUTH_ROUTES: 'GET=^/openapi\\.json$',
});
console.log('env files written: api.env, scheduler.env, oauth2.env, tokens.env', owner.OAUTH2_PROXY_CLIENT_SECRET ? '' : '(oauth2 client secret still missing)');
