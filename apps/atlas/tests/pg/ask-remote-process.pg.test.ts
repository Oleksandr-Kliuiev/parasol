import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startApiExpectingRefusal } from '../support/api-process.ts';
import { CLIENT, WS, askBody, askDatabase, addActor, getCapability, postAsk } from '../support/ask-pg.ts';
import { activate, ledger, revise } from '../support/ask-remote-pg.ts';
import { startTrappedApi, trapControl, trapDir } from '../support/poweroffice-process.ts';
import { Q_MARKER, remoteBody } from '../support/ask-remote-api.ts';

// ASK-REMOTE R-B production composition on the compiled API process (dist main.js, PRODUCTION seams: the dedicated env
// secret resolver + the direct HTTPS transport) under the test-only outbound network trap, with a clean environment. Proves:
// fixture+remote refuses to start; DB remote starts with the accepted readiness, activates nothing and makes no network call;
// missing/inactive admission is 503 not 404/OFF; with a synthetic ACTIVE policy whose secret reference does not resolve in
// production (fixture://, an unset dedicated env name) the committed admission is NEVER dispatched: proven in-process
// no-dispatch settles 0, the reply is the fixed 503, the trap stays empty and no input reaches any log. No key exists.

const db = await askDatabase();
const owner = db.pgdb.owner;
const trap = trapDir();
const both = await addActor(owner, 'rem-proc', ['context:read', 'ask:remote']);
const api = await startTrappedApi(trap, { ATLAS_ASK_MODE: 'remote', ATLAS_RUNTIME_DATABASE_URL: db.pgdb.runtimeUrl });
after(async () => { await api.stop(); trap.close(); await db.pgdb.drop(); });

test('fixture + remote refuses to start with a fixed message; the trap self-control records real attempts', async () => {
  const refused = await startApiExpectingRefusal({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: randomBytes(24).toString('hex'), ATLAS_ASK_MODE: 'remote' });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /ATLAS_ASK_MODE=remote requires ATLAS_MODE=db/);
  const control = trapDir();
  try { assert.match(await trapControl(control), /fetch/); } finally { control.close(); }
});

test('DB remote, no policy: startup readiness passes, nothing activated; capability/POST 503 NOT_ADMITTED; V1 400; no network', async () => {
  assert.match(api.captured.stdout, /Ask Atlas: REMOTE V2, policy-gated per request; no provider call at startup/);
  const cap = await getCapability(api.base, both);
  assert.deepEqual([cap.status, cap.json.code], [503, 'ASK_REMOTE_NOT_ADMITTED']);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "RemoteAskPolicy"`)).rows[0].n, 0, 'startup provisions nothing');
  const consent = { admissionId: '3f1e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5', policyVersion: '1' };
  const r = await postAsk(api.base, both, CLIENT, remoteBody(`What needs attention? ${Q_MARKER}`, null, consent));
  assert.deepEqual([r.status, r.json.code], [503, 'ASK_REMOTE_NOT_ADMITTED']);
  assert.deepEqual([(await postAsk(api.base, both, CLIENT, askBody('what needs attention'))).status], [400]);
  assert.equal((await fetch(`${api.base}/clients`, { headers: { Authorization: `Bearer ${both}` } })).status, 200, 'non-Ask routes unchanged');
  assert.equal(trap.trapped(), '');
});

test('synthetic ACTIVE policy with a non-resolving production secret reference: committed admission never dispatched, settles 0, 503', async () => {
  const policy = await activate(owner, WS, [CLIENT]);
  const cap = await getCapability(api.base, both);
  assert.equal(cap.status, 200); assert.equal(cap.json.disclosure.policyVersion, policy.policyVersion);
  const consent = { admissionId: policy.admissionId, policyVersion: policy.policyVersion };
  const r = await postAsk(api.base, both, CLIENT, remoteBody(`What needs attention? ${Q_MARKER}`, null, consent));
  assert.deepEqual([r.status, r.json.code], [503, 'ASK_REMOTE_UNAVAILABLE'], 'fixture:// never resolves in production (no fixture remote success)');
  const next = await revise(owner, WS, { secretRef: 'env://ATLAS_ASK_REMOTE_UNSET_SYNTHETIC' });
  const r2 = await postAsk(api.base, both, CLIENT, remoteBody(`Why is this urgent? ${Q_MARKER}`, 'ask-crit', { ...consent, policyVersion: next }));
  assert.deepEqual([r2.status, r2.json.code], [503, 'ASK_REMOTE_UNAVAILABLE'], 'an unset dedicated env name never resolves');
  const l = await ledger(owner, WS);
  assert.deepEqual(l.attempts.map(a => [a.state, a.outcome, a.accounted]), [['SETTLED', 'NO_DISPATCH', '0'], ['SETTLED', 'NO_DISPATCH', '0']]);
  assert.deepEqual(l.counters.map(c => c.charged), ['0', '0']);
  assert.equal(trap.trapped(), '', 'no DNS, socket, TLS, http(s) or fetch attempt');
  await new Promise(resolve => setTimeout(resolve, 100));
  const output = api.captured.stdout + api.captured.stderr;
  for (const marker of [Q_MARKER, both, consent.admissionId, 'fixture://', 'ATLAS_ASK_REMOTE_UNSET_SYNTHETIC']) assert.equal(output.includes(marker), false, marker);
});
