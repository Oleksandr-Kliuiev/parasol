import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

// Secrets enter the process after container creation, never Docker Config.Env or command lines.
const mode = process.argv[2];
try {
  const config = JSON.parse(readFileSync('/run/secrets/atlas.json', 'utf8'));
  if (mode === 'migrate') {
    const run = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma'],
      { env: { ...process.env, DATABASE_URL: config.ownerUrl }, encoding: 'utf8' });
    if (run.status !== 0) throw new Error('Atlas migration failed');
    let sql = readFileSync('prisma/roles.sql', 'utf8').split('\n').map(line => line === '\\ir roles/reval.sql'
      ? readFileSync('prisma/roles/reval.sql', 'utf8') : line).join('\n');
    for (const name of ['atlas_app_password', 'atlas_cleanup_runner_password', 'atlas_poweroffice_runner_password', 'atlas_reval_reader_password']) {
      if (!/^[A-Za-z0-9]{32,128}$/.test(config[name])) throw new Error('Invalid role configuration');
      sql = sql.replaceAll(`:'${name}'`, `'${config[name]}'`);
    }
    const db = new pg.Client({ connectionString: config.ownerUrl });
    await db.connect();
    try { await db.query(sql); } finally { await db.end(); }
    console.log('Atlas migrations and restricted roles applied. No actors or provider connections seeded.');
  } else if (mode === 'probe') {
    const db = new pg.Client({ connectionString: config.runtimeUrl, connectionTimeoutMillis: 3000 });
    await db.connect();
    try { await db.query('SELECT 1'); } finally { await db.end(); }
    const result = await fetch('http://127.0.0.1:3100/clients', { signal: AbortSignal.timeout(3000) });
    if (result.status !== 401) throw new Error('Atlas authentication boundary failed');
  } else if (mode === 'serve') {
    process.env.ATLAS_RUNTIME_DATABASE_URL = config.runtimeUrl;
    process.env.ATLAS_CORRELATION_CURSOR_SECRET_REF = 'env://ATLAS_CORRELATION_CURSOR_SECRET';
    process.env.ATLAS_CORRELATION_CURSOR_SECRET = config.cursorSecret;
    await import('./dist/apps/api/src/main.js');
  } else { throw new Error('Unknown host command'); }
} catch {
  // Migration/driver errors can carry connection strings. Operator gets stage only.
  console.error(`Atlas ${mode} failed; check private configuration and database readiness.`);
  process.exitCode = 1;
}
