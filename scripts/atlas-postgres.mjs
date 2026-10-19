// Disposable PostgreSQL 17 for the complete Atlas suite (native Unix + loopback TCP).
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const action = process.argv[2];
if (action === 'stop') {
  const statePath = process.env.ATLAS_TEST_POSTGRES_STATE;
  if (statePath && existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    execFileSync(join(state.bin, 'pg_ctl'), ['-D', state.data, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit' });
    rmSync(state.directory, { recursive: true, force: true });
  }
} else if (action === 'start') {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Complete native tests require macOS arm64.');
  const bin = process.env.PG_BIN ?? join(execFileSync('brew', ['--prefix', 'postgresql@17'], { encoding: 'utf8' }).trim(), 'bin');
  if (!execFileSync(join(bin, 'postgres'), ['--version'], { encoding: 'utf8' }).includes('PostgreSQL) 17.')) throw new Error('PostgreSQL 17 required.');
  const directory = realpathSync(mkdtempSync('/tmp/parasol-pg-')); chmodSync(directory, 0o700);
  const data = join(directory, 'data'); const passwordFile = join(directory, 'admin-password');
  const password = 'parasol_ci_fixture_only'; // Only this disposable local cluster, never an application credential.
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const statePath = join(directory, 'state.json');
  writeFileSync(statePath, JSON.stringify({ directory, data, bin }), { mode: 0o600 });
  const descriptor = join(directory, 'fixture.json');
  const environment = {
    ATLAS_TEST_POSTGRES_STATE: statePath,
    ATLAS_PG_ADMIN_URL: `postgresql://parasol_test:${password}@127.0.0.1:${port}/postgres`,
    DATABASE_URL: `postgresql://parasol_test:${password}@127.0.0.1:${port}/postgres`,
    ATLAS_REVAL_NATIVE_PG_FIXTURE: descriptor,
  };
  // Register cleanup before starting the server, including when a later workflow step fails.
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, Object.entries(environment).map(([k, v]) => `${k}=${v}\n`).join(''));
  let started = false;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'parasol_test', `--pwfile=${passwordFile}`, '--auth=scram-sha-256', '--no-locale', '-E', 'UTF8'], { stdio: 'pipe' });
    // Atlas timestamp columns and DB-clock expiry checks use UTC. initdb otherwise inherits the host's timezone.
    execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(directory, 'server.log'), '-o',
      `-k ${directory} -p ${port} -h 127.0.0.1 -c timezone=UTC -c log_timezone=UTC`, '-w', 'start'], { stdio: 'inherit' });
    started = true;
    writeFileSync(descriptor, JSON.stringify({ socketDir: directory, port, dataDirectory: data, adminRole: 'parasol_test', adminSecretFile: passwordFile }), { mode: 0o600 });
    writeFileSync(join(directory, 'env.json'), JSON.stringify(environment, null, 2), { mode: 0o600 });
    console.log(`Atlas disposable PostgreSQL ready. Environment: ${join(directory, 'env.json')}`);
  } catch (error) {
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit' });
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
} else throw new Error('Usage: node scripts/atlas-postgres.mjs start|stop');
