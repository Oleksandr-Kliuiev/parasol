import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CLIENT, MARKERS, WS, count, getCapability, inProcessApi, postAsk, askBody } from '../support/ask-pg.ts';
import { revise, setClient } from '../support/ask-remote-pg.ts';
import { DEFAULT_COST, KEY, Q_MARKER, ScriptedProvider, currentConsent, databaseText, envelope, ledger, remoteApi, remoteBody, remoteDatabase, response }
  from '../support/ask-remote-api.ts';

// ASK-REMOTE R-B Q-journey on PostgreSQL 17 through the compiled API in ATLAS_ASK_MODE=remote (in-process, real confined
// runtime role, real fence/policy/ledger routines). The provider is the scripted in-process seam only. Proves: exact V2
// capability/answer, local facts identical to MOCK, all-of permission and denials, consent tuple before any reservation,
// settlement of verified usage, fixed audit vocabulary, V1 refusal and question-only egress. No network, no real key.

const db = await remoteDatabase();
const owner = db.pgdb.owner;
const provider = new ScriptedProvider();
const api = await remoteApi(db.pgdb.runtimeUrl, provider.seams());
const mock = await inProcessApi(db.pgdb.runtimeUrl);
after(async () => { await api.close(); await mock.close(); await db.pgdb.drop(); });
const attempts = async () => (await ledger(owner, WS)).attempts;
const audits = async (where = 'true') => (await owner.query(`SELECT "eventType", metadata FROM "AuditEvent" WHERE "workspaceId" = $1 AND "eventType" LIKE 'ask.%' AND ${where}
  ORDER BY "recordedAt", id`, [WS])).rows as { eventType: string; metadata: Record<string, string> }[];
const ask = (token: string | null, body: unknown, client = CLIENT) => postAsk(api.base, token, client, body);

test('capability: exact AskCapabilityV2 from the current workspace policy; no source/charge/audit; 401 without a bearer', async () => {
  const before = [await count(owner, 'AuditEvent'), await count(owner, 'SecurityAuditEvent'), (await attempts()).length];
  const consent = await currentConsent(owner);
  const cap = await getCapability(api.base, db.tokens.both);
  assert.equal(cap.status, 200); assert.equal(cap.headers.get('cache-control'), 'no-store');
  assert.equal(cap.text, JSON.stringify({ contractVersion: 'AskCapabilityV2', mode: 'remote', questionMaxCodepoints: 2000, disclosure: { contractVersion: 'AskRemoteDisclosureV1',
    admissionId: consent.admissionId, policyVersion: consent.policyVersion, provider: 'openai', model: 'gpt-6-luna', profile: 'ask-remote-openai-luna-v1',
    sent: 'QUESTION_AND_FOCUS_FLAG', dataClass: 'SYNTHETIC', region: 'EU', retention: 'OWNER_VERIFIED_ACCOUNT_POLICY', reserveMicroUsd: 300000 } }));
  assert.equal((await getCapability(api.base, null)).json.code, 'ASK_AUTHENTICATION_FAILED');
  assert.deepEqual([await count(owner, 'AuditEvent'), await count(owner, 'SecurityAuditEvent'), (await attempts()).length], before);
  assert.equal(provider.captures.length, 0);
});

test('every intent: V2 answer = exact MOCK local facts + fixed provenance; question+hasFocus only on the wire; usage settled; fixed audit', async () => {
  const consent = await currentConsent(owner);
  const cases = [['SUMMARY', null, 'what needs attention'], ['WHY_URGENT', 'ask-crit', 'why is this urgent'], ['SOURCE_STATE', 'ask-crit', 'how fresh is the evidence'],
    ['ENTITY', 'ask-crit', 'which device is confirmed'], ['UNSUPPORTED', 'ask-crit', 'what is the root cause']] as const;
  for (const [intent, focus, phrase] of cases) {
    provider.next = () => response(envelope(intent));
    const question = `Paraphrased ${intent} ${Q_MARKER} «${phrase}»?`;
    const before = provider.captures.length;
    const r = await ask(db.tokens.both, remoteBody(question, focus, consent));
    assert.equal(r.status, 200, `${intent}: ${r.text.slice(0, 200)}`);
    assert.equal(provider.captures.length, before + 1, 'exactly one provider call, no retry');
    const json = r.json;
    assert.deepEqual(Object.keys(json), ['contractVersion', 'requestId', 'correlationId', 'workspaceId', 'clientId', 'mode', 'sourceMode', 'status', 'intent',
      'generatedAt', 'focusObservationId', 'coverage', 'urgentRefs', 'claims', 'evidence', 'provenance']);
    assert.deepEqual([json.contractVersion, json.mode, json.sourceMode, json.intent], ['AskAnswerV2', 'remote', 'db', intent]);
    assert.deepEqual(json.provenance, { provider: 'openai', model: 'gpt-6-luna', profile: 'ask-remote-openai-luna-v1', dataPolicy: 'QUESTION_ONLY_V1' });
    const m = (await postAsk(mock.base, db.tokens.both, CLIENT, askBody(phrase, focus))).json;
    for (const key of ['status', 'intent', 'workspaceId', 'clientId', 'focusObservationId', 'coverage', 'urgentRefs', 'claims', 'evidence']) {
      assert.deepEqual(json[key], m[key], `${intent}.${key} equals the accepted MOCK compiler output`);
    }
    const sent = JSON.parse(provider.captures.at(-1)!.bytes);
    assert.deepEqual(JSON.parse(sent.messages[1].content), { question, hasFocus: focus !== null });
    assert.equal(provider.captures.at(-1)!.key, KEY);
    for (const marker of [MARKERS.fact, MARKERS.email, MARKERS.device, MARKERS.title, 'ask-crit', 'Credential theft', CLIENT, WS, 'rem-both', consent.admissionId,
      json.correlationId, json.requestId, 'demo-huntress-connection', 'E1']) assert.equal(provider.captures.at(-1)!.bytes.includes(marker), false, `${intent} wire: ${marker}`);
  }
  const all = await attempts();
  assert.equal(all.length, 5);
  for (const a of all) assert.deepEqual([a.state, a.outcome, a.accounted, a.promptTokens, a.completionTokens], ['SETTLED', 'USAGE_VERIFIED', DEFAULT_COST, '777', '9']);
  assert.deepEqual((await ledger(owner, WS)).counters.map(c => c.charged), [String(5 * Number(DEFAULT_COST)), String(5 * Number(DEFAULT_COST))]);
  const remoteAudits = (await audits()).filter(a => a.metadata.provider === 'openai');
  assert.equal(remoteAudits.length, 5);
  for (const a of remoteAudits) {
    assert.equal(a.eventType, 'ask.completed');
    assert.deepEqual(Object.keys(a.metadata).sort(), ['itemCount', 'outcome', 'provider', 'ruleVersion']);
    assert.equal(a.metadata.ruleVersion, 'ask-remote-intent-v1');
  }
});

test('V1 in REMOTE is 400; all-of context:read+ask:remote on ONE membership; denials audited in the workspace; nothing reserved or sent', async () => {
  const consent = await currentConsent(owner);
  const before = [provider.captures.length, (await attempts()).length];
  const v1 = await ask(db.tokens.both, askBody('what needs attention'));
  assert.deepEqual([v1.status, v1.json.code], [400, 'ASK_REQUEST_INVALID']);
  const denials = await count(owner, 'SecurityAuditEvent', `"eventType" = 'ask.scope_denied'`);
  for (const [token, client, reason] of [[db.tokens.context, CLIENT, 'PERMISSION_DENIED'], [db.tokens.remote, CLIENT, 'PERMISSION_DENIED'],
    [db.tokens.other, CLIENT, 'SCOPE_DENIED'], [db.tokens.both, 'rem-other-client', 'SCOPE_DENIED']] as const) {
    const r = await ask(token, remoteBody('What needs attention?', null, consent), client);
    assert.deepEqual([r.status, r.json.code], [403, 'ASK_SCOPE_DENIED'], reason);
  }
  assert.equal(await count(owner, 'SecurityAuditEvent', `"eventType" = 'ask.scope_denied'`), denials + 4);
  assert.equal((await ask(null, remoteBody('q', null, consent))).json.code, 'ASK_AUTHENTICATION_FAILED');
  assert.equal((await ask('not-a-token', remoteBody('q', null, consent))).json.code, 'ASK_AUTHENTICATION_FAILED');
  assert.deepEqual([provider.captures.length, (await attempts()).length], before);
});

test('consent tuple is compared BEFORE any reservation: stale/foreign tuple 409; revoke+reactivate never restores it; inactive/unadmitted 503', async () => {
  const start = await currentConsent(owner);
  const before = [provider.captures.length, (await attempts()).length];
  const status = async (consent: { admissionId: string; policyVersion: string }) => {
    const r = await ask(db.tokens.both, remoteBody('What needs attention?', null, consent));
    return [r.status, r.json.code ?? r.json.status];
  };
  assert.deepEqual(await status({ ...start, policyVersion: String(BigInt(start.policyVersion) - 1n) }), [409, 'ASK_REMOTE_POLICY_CHANGED']);
  assert.deepEqual(await status({ ...start, policyVersion: String(BigInt(start.policyVersion) + 1n) }), [409, 'ASK_REMOTE_POLICY_CHANGED']);
  assert.deepEqual(await status({ ...start, admissionId: randomUUID() }), [409, 'ASK_REMOTE_POLICY_CHANGED']);
  const revised = await revise(owner, WS, { ownerApprovalRef: 'synthetic-owner-approval-2' });
  assert.deepEqual(await status(start), [409, 'ASK_REMOTE_POLICY_CHANGED'], 'a material revision invalidates the captured consent');
  await revise(owner, WS, { state: 'REVOKED' });
  assert.deepEqual(await status({ ...start, policyVersion: String(BigInt(revised) + 1n) }), [503, 'ASK_REMOTE_NOT_ADMITTED']);
  assert.equal((await getCapability(api.base, db.tokens.both)).json.code, 'ASK_REMOTE_NOT_ADMITTED');
  const reactivated = await revise(owner, WS, { state: 'ACTIVE' });
  assert.deepEqual(await status(start), [409, 'ASK_REMOTE_POLICY_CHANGED'], 'revoke/reactivate cannot restore an old tuple');
  assert.deepEqual(await status({ ...start, policyVersion: revised }), [409, 'ASK_REMOTE_POLICY_CHANGED']);
  const removed = await setClient(owner, WS, CLIENT, false);
  assert.deepEqual(await status({ ...start, policyVersion: removed }), [503, 'ASK_REMOTE_NOT_ADMITTED'], 'client allowlist entry removed');
  const readmitted = await setClient(owner, WS, CLIENT, true);
  assert.notEqual(readmitted, reactivated);
  assert.deepEqual([provider.captures.length, (await attempts()).length], before, 'no reservation and no provider call on any refusal');
  provider.next = () => response(envelope('SUMMARY'));
  assert.deepEqual(await status({ ...start, policyVersion: readmitted }), [200, 'ANSWER'], 'an explicit refresh with the current tuple works');
});

test('expired policy and cross-workspace equal epoch/client/actor: never admitted with another workspace policy', async () => {
  const consent = await currentConsent(owner);
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ('rem-ws-x', 'Synthetic other workspace')`);
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ('rem-ws-x', $1, 'Same client ID')`, [CLIENT]);
  const { addActor } = await import('../support/ask-pg.ts');
  const twin = await addActor(owner, 'rem-both', ['context:read', 'ask:remote'], { workspace: 'rem-ws-x', client: CLIENT });
  // Equalize the fence epochs of both workspaces: the epoch of another workspace never binds this policy or admission.
  const epoch = async (w: string) => Number((await owner.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [w])).rows[0].version);
  while (await epoch('rem-ws-x') < await epoch(WS)) await owner.query(`UPDATE "ActionAuthorityFence" SET version = version + 1 WHERE "workspaceId" = 'rem-ws-x'`);
  assert.equal(await epoch('rem-ws-x'), await epoch(WS));
  const before = provider.captures.length;
  const r = await ask(twin, remoteBody('What needs attention?', null, consent));
  assert.deepEqual([r.status, r.json.code], [503, 'ASK_REMOTE_NOT_ADMITTED'], 'same client/actor IDs and epoch in another workspace: its own (missing) policy');
  assert.equal(provider.captures.length, before);
  await revise(owner, WS, { expiresAt: new Date(Date.now() + 1500).toISOString() });
  const fresh = await currentConsent(owner);
  await new Promise(resolve => setTimeout(resolve, 1700));
  const expired = await ask(db.tokens.both, remoteBody('What needs attention?', null, fresh));
  assert.deepEqual([expired.status, expired.json.code], [503, 'ASK_REMOTE_NOT_ADMITTED'], 'DB-clock expiry');
  await revise(owner, WS, { expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString() });
  assert.equal(provider.captures.length, before);
});

test('privacy: the question marker and synthetic key exist ONLY in the captured synthetic request; no upstream metadata persisted', async () => {
  const text = await databaseText(owner);
  for (const marker of [Q_MARKER, KEY, 'UPSTREAM-ID-MARKER-7f3', 'UPSTREAM-FP-MARKER-7f3', 'Paraphrased', 'gpt-6-luna', 'chatcmpl']) {
    assert.equal(text.includes(marker), false, `database: ${marker}`);
  }
  assert.ok(provider.captures.some(c => c.bytes.includes(Q_MARKER)), 'the explicit allowed outbound question marker is present in the capture');
  assert.ok(provider.captures.every(c => !c.bytes.includes(KEY)), 'the key travels only as the Authorization header argument');
});
