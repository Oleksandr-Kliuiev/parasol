import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_TABLES, CLIENT, MARKERS, WS, addActor, askBody, askDatabase, count, digest, inProcessApi, postAsk } from '../support/ask-pg.ts';
import type { AskDb, InProcessApi } from '../support/ask-pg.ts';

// ASK-A Q3/Q4/Q5 on real PostgreSQL 17 through the confined runtime role and actual HTTP (in-process DB API from dist, MOCK
// planner by default; a test planner replaces it in-process only). Positive cited answers, server-only eligibility refs,
// injected plans, whole-source validation and caps, privacy markers and unchanged business tables.

let db: AskDb; let api: InProcessApi;
let injected: ((input: any) => unknown) | null = null;
const planner = { plan: async (input: any) => injected ? injected(input) : (await import('../../packages/ask/planner.ts')).mockPlan(input) };
const digests: Record<string, string> = {};
/** Synthetic readers in rotation: each actor stays far below its 10 questions per rolling 60 s. */
const readers: string[] = [];
let turn = 0;
before(async () => {
  db = await askDatabase();
  for (let i = 0; i < 12; i += 1) readers.push(await addActor(db.pgdb.owner, `ask-reader-${i}`, ['context:read']));
  for (const table of BUSINESS_TABLES) digests[table] = await digest(db.pgdb.owner, table);
  api = await inProcessApi(db.pgdb.runtimeUrl, planner);
});
after(async () => { await api?.close(); await db?.pgdb.drop(); });

const ask = (question: string, focus: string | null = null, token = readers[turn++ % readers.length]!) => postAsk(api.base, token, CLIENT, askBody(question, focus));
const evidenceIds = (answer: any) => answer.evidence.map((f: any) => f.kind === 'OBSERVATION' ? f.data.observationId
  : f.kind === 'RESOURCE_STATE' ? `${f.data.connectionId}/${f.data.resourceType}:${f.data.status}` : `entity:${f.data.state}`);

test('SUMMARY over the active page: deterministic first observations, server order, honest coverage, urgent notice', async () => {
  const r = await ask('What needs attention?');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(r.headers.get('x-atlas-correlation-id'), r.json.correlationId);
  assert.deepEqual(Object.keys(r.json), ['contractVersion', 'requestId', 'correlationId', 'workspaceId', 'clientId', 'mode', 'sourceMode', 'status', 'intent',
    'generatedAt', 'focusObservationId', 'coverage', 'urgentRefs', 'claims', 'evidence']);
  assert.equal(r.json.sourceMode, 'db'); assert.equal(r.json.mode, 'mock'); assert.equal(r.json.workspaceId, WS); assert.equal(r.json.clientId, CLIENT);
  assert.match(r.json.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(evidenceIds(r.json), ['ask-crit', 'ask-high', 'ask-person', 'ask-notuple', 'ask-low', 'atera-two/alert:ERROR', 'atera-two/ticket:STALE',
    'demo-atera-connection/alert:OK', 'demo-atera-connection/ticket:MISSING', 'demo-huntress-connection/incident:MISSING']);
  assert.deepEqual(r.json.claims, ['E1', 'E2', 'E3', 'E4', 'E5'].map(ref => ({ code: 'OBSERVATION_RECORDED', refs: [ref] })));
  assert.deepEqual(r.json.urgentRefs, ['E1', 'E2']);
  assert.deepEqual(r.json.coverage, { observationLimit: 100, bankLimit: 32, observationsRead: 5, observationPageTruncated: false, focusExtra: false,
    observationFactsOmitted: false, urgentFactsOmitted: false, resourcesRead: 5, resourceFactsOmitted: false, fixture: false });
  const stale = r.json.evidence[6].data;
  assert.equal(stale.status, 'STALE'); assert.match(stale.asOf, /Z$/); assert.equal(stale.lastSuccessAt === null, false);
  assert.deepEqual(Object.keys(stale), ['source', 'resourceType', 'connectionId', 'status', 'asOf', 'lastSuccessAt', 'truncated']);
  const ru = await ask('что требует внимания');
  assert.deepEqual(ru.json.claims, r.json.claims, 'RU phrase, same deterministic selection');
});

test('WHY_URGENT: LOW focus is not urgent in this read; HIGH/CRITICAL facts stay in the independent notice; RESOLVED focus off-page counted', async () => {
  const r = await ask('Why is this urgent?', 'ask-low');
  assert.equal(r.json.status, 'ANSWER'); assert.equal(r.json.focusObservationId, 'ask-low');
  assert.deepEqual(evidenceIds(r.json).slice(0, 6), ['ask-low', 'ask-crit', 'ask-high', 'ask-person', 'ask-notuple', 'demo-atera-connection/alert:OK']);
  assert.deepEqual(r.json.claims, [{ code: 'SOURCE_NOT_URGENT_IN_READ', refs: ['E1'] }]);
  assert.deepEqual(r.json.urgentRefs, ['E2', 'E3']);
  const crit = await ask('почему это срочно?', 'ask-crit');
  assert.deepEqual(crit.json.claims, [{ code: 'SOURCE_URGENT', refs: ['E1'] }]);
  const resolved = await ask('Why is this urgent', 'ask-resolved');
  assert.deepEqual(resolved.json.claims, [{ code: 'SOURCE_NOT_URGENT_IN_READ', refs: ['E1'] }]);
  assert.equal(resolved.json.evidence[0].data.status, 'RESOLVED'); assert.equal(resolved.json.coverage.focusExtra, true);
  assert.equal(resolved.json.coverage.observationsRead, 5);
  for (const missing of ['no-such-observation', 'ask-crit ', 'ASK-CRIT', 'x'.repeat(256), 'a\u0000b']) {
    const m = await ask('Why is this urgent?', missing);
    assert.equal(m.status, 200); assert.equal(m.json.status, 'INSUFFICIENT'); assert.equal(m.json.intent, 'WHY_URGENT');
    assert.equal(m.json.focusObservationId, missing, 'focus echo is exact, never auto-selected');
    assert.deepEqual(m.json.urgentRefs, ['E1', 'E2']); assert.equal(m.json.evidence.length, 10);
  }
  const summary = await ask('What needs attention?', 'no-such-observation');
  assert.equal(summary.json.status, 'ANSWER', 'SUMMARY needs no focus even when the requested focus is missing');
});

test('SOURCE_STATE: exact focus tuple across two Atera connections, ERROR/STALE/OK recorded states, no tuple → INSUFFICIENT', async () => {
  const low = await ask('How fresh is the evidence?', 'ask-low');
  assert.deepEqual(low.json.claims, [{ code: 'RESOURCE_RECORDED', refs: ['E6'] }]);
  assert.deepEqual(low.json.evidence[5].data, { ...low.json.evidence[5].data, source: 'atera', resourceType: 'alert', connectionId: 'demo-atera-connection', status: 'OK' });
  const high = await ask('насколько свежи данные', 'ask-high');
  assert.deepEqual(high.json.claims, [{ code: 'RESOURCE_RECORDED', refs: ['E6'] }]);
  assert.equal(high.json.evidence[5].data.connectionId, 'atera-two'); assert.equal(high.json.evidence[5].data.status, 'ERROR');
  const person = await ask('how fresh is the evidence', 'ask-person');
  assert.equal(person.json.evidence[5].data.status, 'STALE');
  const none = await ask('How fresh is the evidence?', 'ask-notuple');
  assert.equal(none.json.status, 'INSUFFICIENT'); assert.deepEqual(none.json.claims, []);
});

test('ENTITY: device confirmed through another source tuple (Atera link of a Huntress focus); unresolved person and no entity', async () => {
  const crit = await ask('Which device is confirmed?', 'ask-crit');
  const entity = crit.json.evidence.at(-1);
  assert.deepEqual(entity, { ref: 'E11', kind: 'ENTITY', data: { observationId: 'ask-crit', entityId: 'demo-device-07', state: 'CONFIRMED', entityKind: 'DEVICE',
    displayName: 'GASTA-LT-07', confirmation: { source: 'atera', resourceType: 'agent', connectionId: 'demo-atera-connection', externalId: 'demo-atera-agent-107' } } });
  assert.deepEqual(crit.json.claims, [{ code: 'ENTITY_CONFIRMED', refs: ['E11'] }]);
  const person = await ask('какое устройство подтверждено', 'ask-person');
  assert.deepEqual(person.json.evidence.at(-1).data, { observationId: 'ask-person', entityId: 'demo-kari', state: 'UNRESOLVED', entityKind: null, displayName: null, confirmation: null });
  assert.deepEqual(person.json.claims, [{ code: 'ENTITY_UNRESOLVED', refs: [person.json.evidence.at(-1).ref] }]);
  const high = await ask('which device is confirmed', 'ask-high');
  assert.equal(high.json.evidence.at(-1).data.entityId, null); assert.equal(high.json.claims[0].code, 'ENTITY_UNRESOLVED');
});

test('UNSUPPORTED and empty plans: explicit status, no claims, evidence/coverage/urgency retained, no broader read or tool', async () => {
  const before = await count(db.pgdb.owner, 'ToolExecution');
  const r = await ask(`What is the root cause? ${MARKERS.question}`);
  assert.equal(r.json.status, 'UNSUPPORTED'); assert.equal(r.json.intent, 'UNSUPPORTED'); assert.deepEqual(r.json.claims, []);
  assert.deepEqual(r.json.urgentRefs, ['E1', 'E2']); assert.equal(r.json.evidence.length, 10);
  injected = () => ({ version: 'AskPlanV1', intent: 'SUMMARY', refs: [] });
  try {
    const empty = await ask('anything');
    assert.equal(empty.json.status, 'INSUFFICIENT'); assert.equal(empty.json.intent, 'SUMMARY'); assert.equal(empty.json.evidence.length, 10);
  } finally { injected = null; }
  assert.equal(await count(db.pgdb.owner, 'ToolExecution'), before);
});

test('injected plans: LOW focus + HIGH ref, unrelated same-system resource, tools/prose, planner exception → 503 ASK_PLANNER_INVALID + ask.failed', async () => {
  const failedBefore = await count(db.pgdb.owner, 'AuditEvent', `"eventType" = 'ask.failed'`);
  const cases: ((input: any) => unknown)[] = [
    () => ({ version: 'AskPlanV1', intent: 'WHY_URGENT', refs: ['E1', 'E3'] }),
    () => ({ version: 'AskPlanV1', intent: 'WHY_URGENT', refs: ['E3'] }),
    input => ({ version: 'AskPlanV1', intent: 'SOURCE_STATE', refs: [input.bank.find((d: any) => d.kind === 'RESOURCE_STATE' && d.ref !== input.focusResourceRef).ref] }),
    () => ({ version: 'AskPlanV1', intent: 'SUMMARY', refs: ['E1'], tool: 'get_alert', parameters: { clientId: 'other' } }),
    () => ({ version: 'AskPlanV1', intent: 'SUMMARY', refs: ['E1'], answer: 'The client is healthy. https://example.invalid' }),
    () => ({ version: 'AskPlanV1', intent: 'ENTITY', refs: ['E1'] }),
    () => { throw new Error(MARKERS.planner); }];
  for (const plan of cases) {
    injected = plan;
    try {
      const r = await ask('Why is this urgent?', 'ask-low');
      assert.equal(r.status, 503); assert.deepEqual(Object.keys(r.json), ['contractVersion', 'code', 'correlationId']);
      assert.equal(r.json.code, 'ASK_PLANNER_INVALID'); assert.equal(r.headers.get('x-atlas-correlation-id'), r.json.correlationId);
      assert.equal(r.text.includes(MARKERS.planner), false);
    } finally { injected = null; }
  }
  assert.equal(await count(db.pgdb.owner, 'AuditEvent', `"eventType" = 'ask.failed'`), failedBefore + cases.length);
});

test('privacy and preservation: excluded fields never answered; audits allowlisted; no question/planner text persisted; tables unchanged', async () => {
  const r = await ask('What needs attention?', 'ask-crit');
  for (const marker of [MARKERS.email, MARKERS.fact, MARKERS.device, MARKERS.title, 'receivedAt', 'externalDevice', 'facts', 'safeErrorCode', 'items', 'email']) {
    assert.equal(r.text.includes(marker), false, marker);
  }
  const rows = (await db.pgdb.owner.query(`SELECT "eventType", "correlationId", metadata FROM "AuditEvent" WHERE "eventType" LIKE 'ask.%'`)).rows;
  assert.ok(rows.length >= 10);
  for (const row of rows) {
    assert.ok(Object.keys(row.metadata).every((k: string) => ['provider', 'ruleVersion', 'itemCount', 'outcome', 'safeErrorCode'].includes(k)), JSON.stringify(row.metadata));
    assert.equal(row.metadata.provider, 'fixture'); assert.equal(row.metadata.ruleVersion, 'ask-mock-v1');
    assert.match(row.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  const everything = (await db.pgdb.owner.query(`SELECT string_agg(t::text, '|') AS all FROM (SELECT * FROM "AuditEvent") t`)).rows[0].all
    + (await db.pgdb.owner.query(`SELECT coalesce(string_agg(t::text, '|'), '') AS all FROM (SELECT * FROM "SecurityAuditEvent") t`)).rows[0].all;
  for (const marker of [MARKERS.question, MARKERS.planner, 'What needs attention', 'root cause', MARKERS.title, MARKERS.email]) assert.equal(everything.includes(marker), false, marker);
  for (const table of BUSINESS_TABLES) assert.equal(await digest(db.pgdb.owner, table), digests[table], `${table} unchanged`);
});

test('whole original source validation: malformed summary/kind/item → 503 ASK_SOURCE_INVALID with no completion audit; caps → 413', async () => {
  const owner = db.pgdb.owner;
  const audits = () => count(owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`);
  const expectFailure = async (mutate: string, restore: string, code: string, status: number) => {
    await owner.query(mutate);
    try {
      const before = await audits();
      const r = await ask('What needs attention?');
      assert.equal(r.status, status, mutate); assert.equal(r.json.code, code);
      assert.equal(await audits(), before, 'no planner/completion audit for an invalid or oversized source');
    } finally { await owner.query(restore); }
  };
  await expectFailure(`UPDATE "RawEvent" SET normalized = normalized - 'summary' WHERE id = 'ev-ask-low'`,
    `UPDATE "RawEvent" SET normalized = normalized || '{"summary":"Low disk warning (synthetic)"}' WHERE id = 'ev-ask-low'`, 'ASK_SOURCE_INVALID', 503);
  await expectFailure(`UPDATE "RawEvent" SET normalized = normalized || '{"summary":7}' WHERE id = 'ev-ask-high'`,
    `UPDATE "RawEvent" SET normalized = normalized || '{"summary":"Disk almost full (synthetic)"}' WHERE id = 'ev-ask-high'`, 'ASK_SOURCE_INVALID', 503);
  await expectFailure(`UPDATE "RawEvent" SET normalized = normalized || '{"kind":"UNKNOWN_KIND"}' WHERE id = 'ev-ask-person'`,
    `UPDATE "RawEvent" SET normalized = normalized || '{"kind":"DISK_CAPACITY"}' WHERE id = 'ev-ask-person'`, 'ASK_SOURCE_INVALID', 503);
  const items = (await owner.query(`SELECT items::text AS items FROM "ResourceSnapshot" WHERE "connectionId" = 'demo-atera-connection'`)).rows[0].items as string;
  await expectFailure(`UPDATE "ResourceSnapshot" SET items = '[{"source":"huntress","resourceType":"alert","externalId":"A-1","title":"t","status":"s","severity":null,"priority":null,"device":null,"occurredAt":null,"updatedAt":null}]' WHERE "connectionId" = 'demo-atera-connection'`,
    `UPDATE "ResourceSnapshot" SET items = '${items}' WHERE "connectionId" = 'demo-atera-connection'`, 'ASK_SOURCE_INVALID', 503);
  await expectFailure(`INSERT INTO "Connection" ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status)
      SELECT '${WS}','${CLIENT}','bulk-'||lpad(g::text,3,'0'),'atera','bulk-tenant-'||g,'fixture://no-credentials','FIXTURE' FROM generate_series(1,49) g`,
    `DELETE FROM "Connection" WHERE id LIKE 'bulk-%'`, 'ASK_TOO_LARGE', 413);
  await expectFailure(`INSERT INTO "Entity" ("workspaceId","clientId",id,kind) SELECT '${WS}','${CLIENT}','bulk-p'||g,'PERSON' FROM generate_series(1,1000) g;
      INSERT INTO "Person" ("workspaceId","clientId",id,"displayName") SELECT '${WS}','${CLIENT}','bulk-p'||g,'Synthetic' FROM generate_series(1,1000) g`,
    `DELETE FROM "Person" WHERE id LIKE 'bulk-p%'; DELETE FROM "Entity" WHERE id LIKE 'bulk-p%'`, 'ASK_TOO_LARGE', 413);
  await expectFailure(`UPDATE "RawEvent" SET normalized = normalized || jsonb_build_object('summary', repeat('x', 4500000)) WHERE id = 'ev-ask-crit'`,
    `UPDATE "RawEvent" SET normalized = normalized || '{"summary":"Credential theft suspected (synthetic)"}' WHERE id = 'ev-ask-crit'`, 'ASK_TOO_LARGE', 413);
  const ok = await ask('What needs attention?');
  assert.equal(ok.status, 200, 'restored source answers again');
});

test('display cap: a 5000-code-point stored summary is answered with 4000 code points and the marker; the console 300 cap is not applied', async () => {
  await db.pgdb.owner.query(`UPDATE "RawEvent" SET normalized = normalized || jsonb_build_object('summary', repeat('ж', 5000)) WHERE id = 'ev-ask-high'`);
  try {
    const r = await ask('What needs attention?');
    const summary = r.json.evidence[1].data.summary as string;
    assert.equal(Array.from(summary).length, 4000); assert.ok(summary.endsWith('…'));
  } finally {
    await db.pgdb.owner.query(`UPDATE "RawEvent" SET normalized = normalized || '{"summary":"Disk almost full (synthetic)"}' WHERE id = 'ev-ask-high'`);
  }
});

test('rc2 R3: PENDING/UNAVAILABLE → MISSING never hides an original snapshot — malformed 503, oversized 413 (no audit); valid stays MISSING', async () => {
  const owner = db.pgdb.owner;
  const key = `"workspaceId" = '${WS}' AND "clientId" = '${CLIENT}' AND "connectionId" = 'demo-atera-connection' AND "resourceType" = 'alert'`;
  const items = (await owner.query(`SELECT items::text AS items FROM "ResourceSnapshot" WHERE ${key}`)).rows[0].items as string;
  const [first] = JSON.parse(items);
  const states = {
    UNAVAILABLE: `UPDATE "SyncState" SET status = 'UNAVAILABLE', "safeErrorCode" = 'SOURCE_UNAVAILABLE' WHERE ${key}`,
    PENDING: `UPDATE "SyncState" SET status = 'PENDING', "safeErrorCode" = NULL, "lastSyncAt" = NULL, "lastSuccessAt" = NULL, "recordedSeq" = 0 WHERE ${key}`
  };
  const audits = () => count(owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`);
  try {
    for (const [state, sql] of Object.entries(states)) {
      await owner.query(sql);
      const valid = await ask('What needs attention?');
      assert.equal(valid.status, 200, state);
      const card = valid.json.evidence.find((f: any) => f.kind === 'RESOURCE_STATE' && f.data.connectionId === 'demo-atera-connection' && f.data.resourceType === 'alert');
      assert.deepEqual(card.data, { source: 'atera', resourceType: 'alert', connectionId: 'demo-atera-connection', status: 'MISSING', asOf: null,
        lastSuccessAt: state === 'PENDING' ? null : card.data.lastSuccessAt, truncated: false }, state);
      assert.equal(valid.json.coverage.resourcesRead, 5); assert.equal(valid.text.includes(MARKERS.title), false, 'no item leakage');
      for (const [variant, value, status, code] of [['malformed', [{ malformed: true }], 503, 'ASK_SOURCE_INVALID'],
        ['wrong source', [{ ...first, source: 'huntress' }], 503, 'ASK_SOURCE_INVALID'],
        ['oversized', [{ ...first, title: 'x'.repeat(4_500_000) }], 413, 'ASK_TOO_LARGE']] as const) {
        await owner.query(`UPDATE "ResourceSnapshot" SET items = $1 WHERE ${key}`, [JSON.stringify(value)]);
        const before = await audits();
        const r = await ask('What needs attention?');
        assert.equal(r.status, status, `${state} ${variant}`); assert.equal(r.json.code, code, `${state} ${variant}`);
        assert.equal(await audits(), before, `${state} ${variant}: no planner/completion audit`);
        await owner.query(`UPDATE "ResourceSnapshot" SET items = $1 WHERE ${key}`, [items]);
      }
    }
  } finally {
    await owner.query(`UPDATE "ResourceSnapshot" SET items = $1 WHERE ${key}`, [items]);
    await owner.query(`UPDATE "SyncState" SET status = 'OK', "safeErrorCode" = NULL, "lastSyncAt" = now(), "lastSuccessAt" = now() WHERE ${key}`);
  }
  const restored = await ask('What needs attention?');
  assert.equal(restored.status, 200);
  assert.equal(restored.json.evidence.find((f: any) => f.kind === 'RESOURCE_STATE' && f.data.connectionId === 'demo-atera-connection' && f.data.resourceType === 'alert').data.status, 'OK');
});
