import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { APPLICATION_NAME } from '../../packages/reval/codes.ts';
import { loadOwnerConfig } from '../../packages/reval/config.ts';
import { loadFrozenDataset } from '../../packages/reval/dataset.ts';
import { runMaintain } from '../../packages/reval/maintain-cli.ts';
import type { MaintainDeps } from '../../packages/reval/maintain-cli.ts';
import { readSecretFile } from '../../packages/reval/secret-file.ts';
import { PRICE } from '../support/ask-remote-pg.ts';
import { ACTOR, BUILD, CLIENT, WS, provisionSandbox } from '../support/reval-fixture-pg.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { dockerPhysical, privateDir, tcpVerify, writeOwnerConfig } from '../support/reval-test-deps.ts';

// R-EVAL RS-B owner maintenance CLI (rs-b brief §1.3/B7) with the Docker TCP seam (test-only; production is unix-socket
// only): closed grammar, the closed owner config and secret file, TWO independent owner connections (both admitted by the
// census, nothing else), one JSON line per run with no credential, row or SQL text.
const ns = await nonsuperDatabase();
const { db } = ns;
const physical = await dockerPhysical(ns.admin);
await ns.admin.end();
after(async () => { await ns.cleanup(); });
const { admissionId } = await provisionSandbox(db.owner);
await db.owner.end(); // the CLI's own two connections are the only backends during maintenance
const dir = await privateDir('maint');
const u = new URL(db.ownerUrl); const t = { host: u.hostname, port: Number(u.port || 5432) };
const { path } = await writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: randomUUID(), databaseInstanceId: randomUUID(), workspaceId: WS,
  clientId: CLIENT, actorId: ACTOR, admissionId, approvedPriceRevision: PRICE, nativePeerHelper: '/docker-test-only/helper', nativePeerHelperSha256: 'e'.repeat(64),
  endpoint: { socketDir: '/docker-test-only', port: t.port, database: db.name }, roles: { reader: db.revalReaderRole, runtime: db.runtimeRole, owner: ns.ownerRole },
  physical, server: { mode: 'NONE', apiEntry: '/docker-test-only/main.js', port: 3999 } } as never,
{ reader: db.revalReaderPassword, runtime: new URL(db.runtimeUrl).password, owner: ns.ownerPassword });
const out: string[] = [];
const deps: MaintainDeps = {
  loadConfig: loadOwnerConfig, readSecret: readSecretFile,
  connectOwner: (config, password, label) => tcpVerify(t, config.endpoint, config.physical, config.roles.owner, password,
    label === 'primary' ? APPLICATION_NAME.maintain : APPLICATION_NAME.confirm, 5000),
  observePhysical: async () => physical, buildManifestSha256: async () => BUILD, loadDataset: () => loadFrozenDataset(), out: line => { out.push(line); },
};
const run = async (...argv: string[]) => { out.length = 0; const code = await runMaintain(argv, deps); return { code, json: JSON.parse(out.join('')) } as const; };

test('grammar: closed commands only; anything else is USAGE before any config, secret or DB access', async () => {
  for (const argv of [[], ['probe'], ['--config', path], ['--config', path, 'install', 'FX12', '0'], ['--config', path, 'install', 'FX01', '-1'],
    ['--config', path, 'install', 'FX01'], ['--config', path, 'register', 'now'], ['--config', path, 'sql', 'DROP TABLE x'], ['--config', path, 'probe', 'x']]) {
    assert.deepEqual(await run(...argv), { code: 2, json: { ok: false, code: 'USAGE' } }, argv.join(' '));
  }
});

test('probe → register → install × 3 → refused stale install; output is one fixed-key JSON line without secrets', async () => {
  assert.deepEqual((await run('--config', path, 'probe')).json, { ok: true, physical });
  const config = await loadOwnerConfig(path);
  const reg = await run('--config', path, 'register');
  assert.deepEqual(reg, { code: 0, json: { ok: true, registrationId: config.registrationId, databaseInstanceId: config.databaseInstanceId } });
  assert.deepEqual((await run('--config', path, 'register')).json, { ok: false, code: 'ALREADY_REGISTERED' });
  let gen = '0';
  for (const id of ['FX01', 'FX08', 'FX10']) {
    const r = await run('--config', path, 'install', id, gen);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual(Object.keys(r.json), ['ok', 'fixtureId', 'generation', 'seedMappingSha256', 'fenceAdvanced']);
    assert.equal(r.json.fixtureId, id); gen = r.json.generation as string;
  }
  assert.equal(gen, '3');
  assert.deepEqual(await run('--config', path, 'install', 'FX02', '2'), { code: 1, json: { ok: false, code: 'GENERATION_MISMATCH' } });
  assert.equal((await run('--config', path, 'install', 'FX04', '3')).json.generation, '4', 'FX04 via the owner-approved mapping exception');
  for (const secret of [ns.ownerPassword, db.revalReaderPassword]) assert.ok(!out.join('').includes(secret));
});

test('a wrong owner secret or a mismatching physical tuple refuses with a fixed code (no partial work)', async () => {
  const bad: MaintainDeps = { ...deps, readSecret: async () => Buffer.from('x'.repeat(24)) };
  out.length = 0;
  assert.equal(await runMaintain(['--config', path, 'install', 'FX02', '4'], bad), 1);
  assert.deepEqual(JSON.parse(out.join('')), { ok: false, code: 'OWNER_REQUIRED' });
  const other: MaintainDeps = { ...deps, connectOwner: (config, password, label) => tcpVerify(t, config.endpoint, { ...config.physical, databaseOid: '1' },
    config.roles.owner, password, label === 'primary' ? APPLICATION_NAME.maintain : APPLICATION_NAME.confirm, 5000) };
  out.length = 0;
  assert.equal(await runMaintain(['--config', path, 'install', 'FX02', '4'], other), 1);
  assert.deepEqual(JSON.parse(out.join('')), { ok: false, code: 'REGISTRATION_MISMATCH' });
  assert.equal((await run('--config', path, 'install', 'FX02', '4')).json.generation, '5', 'state intact after the refusals');
});
