import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const token = randomBytes(24).toString('hex');
const child = spawn(process.execPath, ['dist/apps/api/src/main.js'], {
  env: { ...process.env, ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe']
});
let startup = '';
child.stderr.on('data', data => { startup += String(data).slice(0, 2000); });
const base = 'http://127.0.0.1:3100';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`API startup failed: ${startup}`);
    try { ready = (await fetch(`${base}/clients`, { headers })).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'API becomes ready');
  assert.equal((await fetch(`${base}/clients`)).status, 401);
  const overview = await fetch(`${base}/clients/demo-gasta/overview`, { headers });
  assert.equal(overview.status, 200);
  const body = await overview.json() as { contractVersion: string; clientId: string; observations: { items: unknown[]; total: number; truncated: boolean }; resources: { status: string }[] };
  assert.equal(body.contractVersion, 'ClientContextV1'); assert.equal(body.clientId, 'demo-gasta');
  assert.equal(body.observations.items.length, 2); assert.equal(body.observations.total, 2); assert.equal(body.observations.truncated, false);
  assert.ok(body.resources.every(r => r.status === 'FIXTURE'));
  assert.equal((await fetch(`${base}/clients/other-client/overview`, { headers })).status, 403);
  const execute = (payload: unknown) => fetch(`${base}/tools/execute`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const tickets = await execute({ clientId: 'demo-gasta', tool: 'atera.ticket.list' });
  assert.equal(tickets.status, 201);
  const ticketView = await tickets.json() as { status: string; items: unknown[] | null };
  assert.equal(ticketView.status, 'FIXTURE'); assert.equal(ticketView.items?.length, 1);
  assert.equal((await execute({ clientId: 'demo-gasta', tool: 'atera.ticket.create' })).status, 403);
  assert.equal((await execute({ clientId: 'demo-gasta', tool: 'atera.ticket.list', risk: 0 })).status, 400);
  assert.equal((await execute({ clientId: 'other-client', tool: 'atera.ticket.list' })).status, 403);
  const audit = await (await fetch(`${base}/clients/demo-gasta/audit`, { headers })).json() as { eventType: string; metadata: Record<string, string> }[];
  assert.ok(audit.some(a => a.eventType === 'tool.succeeded')); assert.ok(audit.some(a => a.eventType === 'tool.denied'));
  assert.ok(audit.every(a => !('summary' in a) && !('facts' in a)), 'client audit never carries payload fields');
  const security = await (await fetch(`${base}/audit/security`, { headers })).json() as { eventType: string; requestedClientId: string | null }[];
  assert.ok(security.some(s => s.eventType === 'client.overview_denied' && s.requestedClientId === 'other-client'));
  assert.ok(security.some(s => s.eventType === 'tool.scope_denied' && s.requestedClientId === 'other-client'));
  console.log('PASS: API auth, ClientContextV1 overview, client isolation, read tool resource view, write denial, DTO validation, client audit without payload, workspace security audit of denials.');
} finally {
  child.kill('SIGTERM');
  await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
}
