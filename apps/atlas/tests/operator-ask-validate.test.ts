import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateAnswer, validateAskError, validateCapability } from '../apps/operator/src/validate-ask.ts';
import type { AskExpectation } from '../apps/operator/src/validate-ask.ts';
import { Invalid } from '../apps/operator/src/validate-core.ts';
import type { AskAnswerV1 } from '../packages/ask/contracts.ts';
import { observation, WS } from './support/operator-journey.ts';
import { askHeaders, compiledAnswer, dbRead, fixtureRead, hostile, link, resource } from './support/operator-ask.ts';
import type { DbRead } from './support/operator-ask.ts';

// ASK-B Q3/Q4 browser validation: every answer the ACCEPTED server compiler produces validates into an exact projection; any
// hostile change (unknown/extra key, enum, time, scope, request/focus binding, ref order/duplicate, bank composition, coverage
// lie, urgency set, claim matrix, cap) discards the WHOLE answer. The planner's private selection is not re-derived here.
const CL = 'c-db';
const EXAMPLES = ['What needs attention?', 'что требует внимания', 'WHY IS THIS URGENT', 'Почему это срочно?', 'how fresh is the evidence?',
  'Насколько свежи данные?', 'Which device is confirmed?', 'какое устройство подтверждено?'];
const UNSUPPORTED = ['Why did this happen?', 'What is the root cause?', 'Show me client demo-other', ' ', 'what needs attention??'];

/** DB-shaped read: CRITICAL huntress (device d-1), MEDIUM atera alert (d-1), ACKNOWLEDGED atera ticket (no entity). */
function journey(focus: DbRead['focus'] = null, patch: Partial<DbRead> = {}) {
  return dbRead({ workspaceId: WS, clientId: CL, focus,
    page: [
      observation('obs-crit', { source: 'huntress', connectionId: 'conn-huntress', resourceType: 'incident', externalEventId: 'inc-1', kind: 'SECURITY_INCIDENT',
        domain: 'SECURITY', severity: 'CRITICAL', route: 'MONITOR', confidence: 0.05, conflictOfEventKey: 'key-earlier', supersededById: 'obs-newer' }),
      observation('obs-alert', { externalEventId: 'alert-1' }),
      observation('obs-ticket', { resourceType: 'ticket', externalEventId: 'ticket-7', entityId: null, status: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-10T08:00:00.000Z' })
    ],
    people: [{ id: 'p-1', label: 'Person (synthetic)' }], devices: [{ id: 'd-1', label: 'HOST-01' }],
    links: [link('d-1', 'DEVICE', 'huntress', 'agent', 'conn-huntress', 'hagent-1'), link('d-1', 'DEVICE', 'atera', 'agent', 'conn-atera', 'agent-1')],
    resources: [resource('atera', 'alert', 'conn-atera', 'OK'), resource('atera', 'ticket', 'conn-atera', 'MISSING'),
      resource('huntress', 'incident', 'conn-huntress', 'STALE', { truncated: true }), resource('atera', 'agent', null, 'MISSING')],
    ...patch });
}
function frame(answer: AskAnswerV1): AskExpectation {
  return { requestId: answer.requestId, workspaceId: answer.workspaceId, clientId: answer.clientId, sourceMode: answer.sourceMode, focusObservationId: answer.focusObservationId };
}
function outcome(body: unknown, expected: AskExpectation, headers: Headers): string {
  try { validateAnswer(body, headers, expected); return 'OK'; } catch (error) {
    if (error instanceof Invalid) return error.tooLarge ? 'TOO_LARGE' : 'INVALID';
    throw error;
  }
}
/** Validation of `change(answer)` with the ORIGINAL request expectation and correlation header. */
const after = (answer: AskAnswerV1, change: (copy: any) => void, expected: Partial<AskExpectation> = {}) =>
  outcome(hostile(answer, change), { ...frame(answer), ...expected }, askHeaders(answer.correlationId));
const ask = (question: string, focus: DbRead['focus'] = null, patch: Partial<DbRead> = {}) => {
  const { source, focusId } = journey(focus, patch);
  return compiledAnswer(source, question, focusId, { workspaceId: WS, clientId: CL });
};

test('every server-compiled answer (fixture and DB, every intent/status, focus cases) validates into the exact projection', async () => {
  const focusCases: DbRead['focus'][] = [null, { id: 'obs-crit' }, { id: 'obs-alert' }, { id: 'obs-ticket' }, { missing: 'obs-missing' },
    { extra: observation('obs-resolved', { status: 'RESOLVED', resolvedAt: '2026-10-10T08:00:00.000Z', severity: 'HIGH', entityId: 'd-gone' }) }];
  const statuses = new Set<string>();
  for (const focus of focusCases) {
    for (const question of [...EXAMPLES, ...UNSUPPORTED]) {
      const answer = ask(question, focus);
      const view = validateAnswer(JSON.parse(JSON.stringify(answer)), askHeaders(answer.correlationId), frame(answer));
      statuses.add(`${answer.intent}/${answer.status}`);
      assert.deepEqual([view.status, view.intent, view.focusObservationId, view.correlationId], [answer.status, answer.intent, answer.focusObservationId, answer.correlationId]);
      assert.deepEqual(view.claims, answer.claims.map(c => ({ code: c.code, ref: c.refs[0] })));
      assert.deepEqual(JSON.parse(JSON.stringify(view.evidence)), answer.evidence);
      assert.deepEqual({ ...view.coverage }, answer.coverage);
      assert.deepEqual([...view.urgentRefs], answer.urgentRefs);
      assert.ok(Object.isFrozen(view) && Object.isFrozen(view.evidence) && view.evidence.every(f => Object.isFrozen(f) && Object.isFrozen(f.data)));
    }
  }
  for (const expected of ['SUMMARY/ANSWER', 'WHY_URGENT/ANSWER', 'WHY_URGENT/INSUFFICIENT', 'SOURCE_STATE/ANSWER', 'SOURCE_STATE/INSUFFICIENT',
    'ENTITY/ANSWER', 'ENTITY/INSUFFICIENT', 'UNSUPPORTED/UNSUPPORTED']) assert.ok(statuses.has(expected), expected);
  const fixture = await fixtureRead(null);
  const id = fixture.page[0]!.observationId;
  for (const focusId of [null, id, 'not-in-fixture']) {
    const source = await fixtureRead(focusId);
    for (const question of EXAMPLES.concat(UNSUPPORTED)) {
      const answer = compiledAnswer(source, question, focusId, { workspaceId: 'demo-vardahei', clientId: 'demo-gasta' });
      assert.equal(outcome(answer, frame(answer), askHeaders(answer.correlationId)), 'OK', `${focusId} ${question}`);
      assert.equal(answer.coverage.fixture, true);
    }
  }
});

test('request binding: requestId, focus (incl. missing/null), workspace, client, sourceMode, mode, version and correlation header', () => {
  const answer = ask('Why is this urgent?', { id: 'obs-crit' });
  const headers = askHeaders(answer.correlationId);
  assert.equal(outcome(answer, frame(answer), headers), 'OK');
  for (const expected of [{ requestId: randomUUID() }, { focusObservationId: null }, { focusObservationId: 'obs-alert' }, { workspaceId: 'other-ws' },
    { clientId: 'c-two' }, { sourceMode: 'fixture' as const }]) assert.equal(outcome(answer, { ...frame(answer), ...expected }, headers), 'INVALID', JSON.stringify(expected));
  const missing = ask('Why is this urgent?', { missing: 'obs-missing' });
  assert.equal(missing.status, 'INSUFFICIENT');
  assert.equal(outcome(missing, { ...frame(missing), focusObservationId: null }, askHeaders(missing.correlationId)), 'INVALID', 'missing focus is not "no focus"');
  for (const change of [(c: any) => { c.contractVersion = 'AskAnswerV2'; }, (c: any) => { c.mode = 'live'; }, (c: any) => { c.correlationId = randomUUID(); },
    (c: any) => { c.correlationId = c.correlationId.toUpperCase(); }, (c: any) => { c.generatedAt = 'yesterday'; }, (c: any) => { c.status = 'PARTIAL'; },
    (c: any) => { c.intent = 'ROOT_CAUSE'; }]) assert.equal(after(answer, change), 'INVALID');
  for (const bad of [new Headers({ 'x-atlas-correlation-id': answer.correlationId.toUpperCase() }), new Headers(), new Headers({ 'x-atlas-correlation-id': randomUUID() })]) {
    assert.equal(outcome(answer, frame(answer), bad), 'INVALID');
  }
});

test('exact keys everywhere: an unknown, missing or __proto__ key at any level invalidates the whole answer', () => {
  const answer = ask('Which device is confirmed?', { id: 'obs-alert' });
  const entity = answer.evidence.length - 1;
  const places: ((c: any) => any)[] = [c => c, c => c.coverage, c => c.evidence[0], c => c.evidence[0].data, c => c.evidence[3].data,
    c => c.evidence[entity].data, c => c.evidence[entity].data.confirmation, c => c.claims[0]];
  for (const [i, place] of places.entries()) {
    assert.equal(after(answer, c => { place(c).extra = 'x'; }), 'INVALID', `extra ${i}`);
    assert.equal(after(answer, c => { const o = place(c); delete o[Object.keys(o)[0]!]; }), 'INVALID', `missing ${i}`);
  }
  const proto = JSON.stringify(answer).replace('"coverage":{', '"coverage":{"__proto__":{"x":1},');
  assert.equal(outcome(JSON.parse(proto), frame(answer), askHeaders(answer.correlationId)), 'INVALID');
  for (const key of ['question', 'plan', 'model', 'tool', 'url', 'answerText', 'message']) assert.equal(after(answer, c => { c[key] = 'x'; }), 'INVALID', key);
});

test('bank: consecutive E-refs, kind order, unique IDs/tuples, enums, times, nullability, scope IDs and active non-focus rows', () => {
  const answer = ask('What needs attention?', { id: 'obs-alert' });
  const cases: [string, (c: any) => void][] = [
    ['gap', c => { c.evidence[1].ref = 'E3'; }], ['dup ref', c => { c.evidence[1].ref = 'E1'; }], ['E0', c => { c.evidence[0].ref = 'E0'; }],
    ['kind order', c => { [c.evidence[2], c.evidence[3]] = [c.evidence[3], c.evidence[2]]; c.evidence[2].ref = 'E3'; c.evidence[3].ref = 'E4'; }],
    ['unknown kind', c => { c.evidence[0].kind = 'NOTE'; }], ['dup observation', c => { c.evidence[1].data.observationId = c.evidence[0].data.observationId; }],
    ['dup tuple', c => { c.evidence[4].data = { ...c.evidence[3].data }; }], ['source m365', c => { c.evidence[0].data.source = 'microsoft365'; }],
    ['source poweroffice', c => { c.evidence[3].data.source = 'poweroffice'; }], ['type', c => { c.evidence[0].data.resourceType = 'm365_user'; }],
    ['severity', c => { c.evidence[0].data.severity = 'SEVERE'; }], ['route', c => { c.evidence[0].data.route = 'AUTO'; }],
    ['priority', c => { c.evidence[0].data.priority = 'P1'; }], ['confidence', c => { c.evidence[0].data.confidence = 1.5; }],
    ['status', c => { c.evidence[0].data.status = 'CLOSED'; }], ['time', c => { c.evidence[0].data.createdAt = '2026-10-10'; }],
    ['null time', c => { c.evidence[0].data.occurredAt = null; }], ['reason type', c => { c.evidence[0].data.reasonCodes = [1]; }],
    ['connection pattern', c => { c.evidence[0].data.connectionId = 'conn atera'; }], ['null connection', c => { c.evidence[3].data.connectionId = null; }],
    ['resource items', c => { c.evidence[3].data.items = []; }], ['truncated type', c => { c.evidence[3].data.truncated = 'no'; }],
    ['fixture status in db', c => { c.evidence[3].data.status = 'FIXTURE'; }], ['empty id', c => { c.evidence[0].data.observationId = ''; }],
    ['non-focus resolved', c => { c.evidence[1].data.status = 'RESOLVED'; }], ['focus not first', c => { [c.evidence[0].data, c.evidence[1].data] = [c.evidence[1].data, c.evidence[0].data]; }],
    ['facts not array', c => { c.evidence = {}; }]
  ];
  for (const [name, change] of cases) assert.equal(after(answer, change), 'INVALID', name);
  // Refs are positional (E<n> = n-th fact): a CONSISTENT renaming of every ref, claim and urgent ref is still invalid.
  const rename = (map: (ref: string) => string) => (c: any) => {
    for (const fact of c.evidence) fact.ref = map(fact.ref);
    for (const claim of c.claims) claim.refs = claim.refs.map(map);
    c.urgentRefs = c.urgentRefs.map(map);
  };
  assert.equal(after(answer, rename(ref => ref === 'E1' ? 'E2' : ref === 'E2' ? 'E1' : ref)), 'INVALID', 'consistent permutation');
  assert.equal(after(answer, rename(ref => `E${Number(ref.slice(1)) + 1}`)), 'INVALID', 'consistent shift E2..E8');
  assert.equal(after(answer, rename(ref => `F${ref.slice(1)}`)), 'INVALID', 'consistent foreign ref names');
  // R3 (RC1 review): only an actual extra focus row may have any lifecycle; an on-page focus is an active row (see below).
  assert.equal(after(answer, c => { c.evidence[0].data.status = 'RESOLVED'; }), 'INVALID', 'on-page focus (focusExtra false) cannot be RESOLVED');
  assert.equal(after(answer, c => { c.evidence[0].data.observationId = 'x'.repeat(256); c.focusObservationId = 'x'.repeat(256); c.evidence.at(-1).data.observationId = 'x'.repeat(256); },
    { focusObservationId: 'x'.repeat(256) }), 'OK', '256-character IDs are used unshortened');
  assert.equal(after(answer, c => { c.evidence[1].data.observationId = 'x'.repeat(257); }), 'INVALID', 'an overlong identity is invalid, not shortened');
  assert.equal(after(answer, c => { c.evidence[1].data.externalEventId = 'x'.repeat(257); }), 'INVALID');
});

test('caps: facts/observations/resources/claims/reasonCodes/display text are TOO_LARGE or INVALID, never partial', () => {
  const answer = ask('What needs attention?');
  const obs = (c: any, i: number) => ({ ref: `E${i + 1}`, kind: 'OBSERVATION', data: { ...c.evidence[1].data, observationId: `o-${i}` } });
  assert.equal(after(answer, c => { c.evidence = Array.from({ length: 33 }, (_, i) => obs(c, i)); }), 'TOO_LARGE');
  assert.equal(after(answer, c => { c.evidence = Array.from({ length: 25 }, (_, i) => obs(c, i)); c.coverage.observationsRead = 25; }), 'INVALID', '25 observations');
  assert.equal(after(answer, c => { c.evidence[0].data.summary = 'é'.repeat(4001); }), 'TOO_LARGE');
  assert.equal(after(answer, c => { c.evidence[0].data.summary = '😀'.repeat(4000); }), 'OK', '4000 code points (astral) is within the cap');
  assert.equal(after(answer, c => { c.evidence[0].data.reasonCodes = Array(101).fill('R'); }), 'TOO_LARGE');
  assert.equal(after(answer, c => { c.evidence[0].data.reasonCodes = ['x'.repeat(4001)]; }), 'TOO_LARGE');
  assert.equal(after(answer, c => { c.claims = Array(9).fill(c.claims[0]); }), 'TOO_LARGE');
  assert.equal(after(answer, c => { c.urgentRefs = Array(25).fill('E1'); }), 'TOO_LARGE');
  const resources = Array.from({ length: 8 }, (_, i) => resource('atera', 'alert', `conn-${i}`, 'OK'));
  const many = ask('What needs attention?', null, { resources });
  assert.equal(many.evidence.filter(f => f.kind === 'RESOURCE_STATE').length, 7);
  assert.equal(after(many, c => { const r = c.evidence.find((f: any) => f.kind === 'RESOURCE_STATE'); c.evidence.push({ ...r, ref: `E${c.evidence.length + 1}`, data: { ...r.data, connectionId: 'conn-x' } }); }), 'INVALID');
});

test('coverage honesty: counters, omission flags, focus extra, fixture and truncation agree with the bank', () => {
  const answer = ask('What needs attention?', { id: 'obs-alert' });
  const extra = ask('What needs attention?', { extra: observation('obs-resolved', { status: 'RESOLVED', resolvedAt: '2026-10-10T08:00:00.000Z' }) });
  assert.equal(extra.coverage.focusExtra, true);
  assert.equal(after(extra, () => undefined), 'OK');
  const cases: [AskAnswerV1, string, (c: any) => void][] = [
    [answer, 'observationsRead', c => { c.coverage.observationsRead = 2; }], [answer, 'over 100', c => { c.coverage.observationsRead = 101; }],
    [answer, 'limit', c => { c.coverage.observationLimit = 50; }], [answer, 'bank limit', c => { c.coverage.bankLimit = 64; }],
    [answer, 'facts omitted', c => { c.coverage.observationFactsOmitted = true; }], [answer, 'urgent omitted alone', c => { c.coverage.urgentFactsOmitted = true; }],
    [answer, 'resource omitted lie', c => { c.coverage.resourceFactsOmitted = false; }], [answer, 'resourcesRead', c => { c.coverage.resourcesRead = 1; }],
    [answer, 'focus extra lie', c => { c.coverage.focusExtra = true; }], [answer, 'fixture lie', c => { c.coverage.fixture = true; }],
    [answer, 'truncated short page', c => { c.coverage.observationPageTruncated = true; }], [answer, 'negative', c => { c.coverage.resourcesRead = -1; }],
    [answer, 'float', c => { c.coverage.observationsRead = 2.5; }], [extra, 'extra hidden', c => { c.coverage.focusExtra = false; }]
  ];
  for (const [base, name, change] of cases) assert.equal(after(base, change), 'INVALID', name);
  assert.equal(answer.coverage.resourceFactsOmitted, true, 'a null-connection placeholder is read but never an explicit-tuple fact');
  const big = ask('What needs attention?', null, { page: Array.from({ length: 30 }, (_, i) => observation(`m-${String(i).padStart(2, '0')}`, { severity: i === 29 ? 'HIGH' : 'LOW' })), truncated: false });
  assert.deepEqual([big.coverage.observationFactsOmitted, big.coverage.urgentFactsOmitted], [true, true]);
  assert.equal(after(big, () => undefined), 'OK');
  assert.equal(after(big, c => { c.coverage.observationFactsOmitted = false; }), 'INVALID');
});

test('urgency: urgentRefs is exactly every HIGH/CRITICAL observation fact, for every status, each once', () => {
  for (const question of ['Why is this urgent?', 'How fresh is the evidence?', 'Who is the attacker?']) {
    const answer = ask(question, { id: 'obs-alert' });
    const critical = answer.evidence.find(f => f.kind === 'OBSERVATION' && f.data.severity === 'CRITICAL')!.ref;
    assert.deepEqual(answer.urgentRefs, [critical], `${question}: the notice is independent of the plan`);
    for (const change of [(c: any) => { c.urgentRefs = []; }, (c: any) => { c.urgentRefs.push('E1'); }, (c: any) => { c.urgentRefs.push(critical); },
      (c: any) => { c.urgentRefs = ['E4']; }, (c: any) => { c.urgentRefs = ['E99']; }, (c: any) => { c.urgentRefs = [1]; }]) {
      assert.equal(after(answer, change), 'INVALID', question);
    }
  }
});

test('claim matrix: WHY_URGENT LOW focus + unrelated HIGH cannot cite [focus, other] or [other]; codes follow severity', () => {
  const low = observation('obs-low', { severity: 'LOW' });
  const high = observation('obs-high', { severity: 'HIGH', externalEventId: 'alert-h' });
  const answer = ask('Why is this urgent?', { id: 'obs-low' }, { page: [high, low] });
  assert.deepEqual([answer.status, answer.claims], ['ANSWER', [{ code: 'SOURCE_NOT_URGENT_IN_READ', refs: ['E1'] }]]);
  assert.deepEqual(answer.urgentRefs, ['E2']);
  for (const [name, claims] of [['[focus, other]', [{ code: 'SOURCE_NOT_URGENT_IN_READ', refs: ['E1'] }, { code: 'SOURCE_URGENT', refs: ['E2'] }]],
    ['[other]', [{ code: 'SOURCE_URGENT', refs: ['E2'] }]], ['LOW as urgent', [{ code: 'SOURCE_URGENT', refs: ['E1'] }]],
    ['two refs in one claim', [{ code: 'SOURCE_NOT_URGENT_IN_READ', refs: ['E1', 'E2'] }]], ['no ref', [{ code: 'SOURCE_NOT_URGENT_IN_READ', refs: [] }]],
    ['resource ref', [{ code: 'SOURCE_NOT_URGENT_IN_READ', refs: ['E3'] }]]] as const) {
    assert.equal(after(answer, c => { c.claims = claims; }), 'INVALID', name);
  }
  const urgent = ask('Why is this urgent?', { id: 'obs-high' }, { page: [high, low] });
  assert.deepEqual(urgent.claims, [{ code: 'SOURCE_URGENT', refs: ['E1'] }]);
  assert.equal(after(urgent, c => { c.claims[0].code = 'SOURCE_NOT_URGENT_IN_READ'; }), 'INVALID');
  // No focus: a supported question with no eligible fact is INSUFFICIENT with zero claims even with a non-empty bank.
  const none = ask('Why is this urgent?', null, { page: [high, low] });
  assert.deepEqual([none.status, none.claims.length, none.evidence.length > 0], ['INSUFFICIENT', 0, true]);
  assert.equal(after(none, c => { c.status = 'ANSWER'; c.claims = [{ code: 'SOURCE_URGENT', refs: ['E1'] }]; }), 'INVALID', 'unrelated ref in place of a missing focus');
  assert.equal(after(none, c => { c.claims = [{ code: 'SOURCE_URGENT', refs: ['E1'] }]; }), 'INVALID', 'INSUFFICIENT has no claims');
});

test('SOURCE_STATE needs the exact focus source/type/non-null connection tuple; paired goldens with two same-system connections', () => {
  const two = [resource('atera', 'alert', 'atera-two', 'OK'), resource('atera', 'alert', 'conn-atera', 'MISSING')];
  const matching = ask('How fresh is the evidence?', { id: 'obs-alert' }, { resources: two });
  const cited = matching.evidence.find(f => f.ref === matching.claims[0]!.refs[0])!;
  assert.deepEqual([matching.status, cited.kind === 'RESOURCE_STATE' && cited.data.connectionId, cited.kind === 'RESOURCE_STATE' && cited.data.status],
    ['ANSWER', 'conn-atera', 'MISSING'], 'the exact tuple is cited, and MISSING stays MISSING');
  const other = matching.evidence.find(f => f.kind === 'RESOURCE_STATE' && f.data.connectionId === 'atera-two')!.ref;
  assert.equal(after(matching, c => { c.claims[0].refs = [other]; }), 'INVALID', 'an unrelated same-system connection cannot stand in');
  const unrelated = ask('How fresh is the evidence?', { id: 'obs-alert' }, { resources: [resource('atera', 'alert', 'atera-two', 'OK')] });
  assert.deepEqual([unrelated.status, unrelated.claims.length], ['INSUFFICIENT', 0]);
  assert.equal(after(unrelated, c => { c.status = 'ANSWER'; c.claims = [{ code: 'RESOURCE_RECORDED', refs: [other] }]; }), 'INVALID');
  for (const status of ['ERROR', 'STALE', 'OK']) {
    const answer = ask('How fresh is the evidence?', { id: 'obs-alert' }, { resources: [resource('atera', 'alert', 'conn-atera', status)] });
    assert.deepEqual([answer.status, after(answer, () => undefined)], ['ANSWER', 'OK'], status);
    assert.equal(after(answer, c => { c.claims[0].code = 'OBSERVATION_RECORDED'; }), 'INVALID');
  }
  const noFocus = ask('How fresh is the evidence?');
  assert.equal(after(noFocus, c => { c.status = 'ANSWER'; c.claims = [{ code: 'RESOURCE_RECORDED', refs: ['E4'] }]; }), 'INVALID');
});

test('ENTITY: confirmed via any confirmed same-entity Atera/Huntress link; unresolved/unavailable shapes; bindings to the focus', () => {
  const confirmed = ask('Which device is confirmed?', { id: 'obs-alert' });
  const entity = confirmed.evidence.at(-1)!;
  assert.ok(entity.kind === 'ENTITY');
  assert.deepEqual([confirmed.claims[0]!.code, entity.data.confirmation?.source], ['ENTITY_CONFIRMED', 'huntress'],
    'the first confirmed link in link order qualifies even though the focus is an Atera alert');
  const e = confirmed.evidence.length - 1;
  for (const [name, change] of [['code', (c: any) => { c.claims[0].code = 'ENTITY_UNRESOLVED'; }], ['no confirmation', (c: any) => { c.evidence[e].data.confirmation = null; }],
    ['no kind', (c: any) => { c.evidence[e].data.entityKind = null; }], ['no label', (c: any) => { c.evidence[e].data.displayName = null; }],
    ['other observation', (c: any) => { c.evidence[e].data.observationId = 'obs-crit'; }], ['other entity id', (c: any) => { c.evidence[e].data.entityId = 'd-2'; }],
    ['m365 link', (c: any) => { c.evidence[e].data.confirmation.source = 'microsoft365'; }], ['link extra', (c: any) => { c.evidence[e].data.confirmation.status = 'CANDIDATE'; }],
    ['state', (c: any) => { c.evidence[e].data.state = 'PROBABLE'; }], ['kind enum', (c: any) => { c.evidence[e].data.entityKind = 'USER'; }],
    ['cite observation', (c: any) => { c.claims[0].refs = ['E1']; }]] as const) assert.equal(after(confirmed, change), 'INVALID', name);
  const unresolved = ask('Which device is confirmed?', { id: 'obs-ticket' });
  assert.deepEqual([unresolved.claims[0]!.code, unresolved.evidence.at(-1)!.kind], ['ENTITY_UNRESOLVED', 'ENTITY']);
  const u = unresolved.evidence.length - 1;
  assert.equal(after(unresolved, c => { c.evidence[u].data.displayName = 'Guess'; }), 'INVALID', 'no name guess');
  assert.equal(after(unresolved, c => { c.claims[0].code = 'ENTITY_CONFIRMED'; }), 'INVALID');
  const unavailable = ask('Which device is confirmed?', { extra: observation('obs-gone', { status: 'SUPPRESSED', entityId: 'd-gone' }) });
  assert.deepEqual([unavailable.claims[0]!.code, after(unavailable, () => undefined)], ['ENTITY_UNAVAILABLE', 'OK']);
  assert.equal(after(unavailable, c => { c.evidence.at(-1).data.entityId = null; }), 'INVALID', 'UNAVAILABLE keeps the stored ID');
  const noFocus = ask('Which device is confirmed?');
  assert.equal(noFocus.status, 'INSUFFICIENT');
  assert.equal(after(noFocus, c => { c.evidence.push({ ref: `E${c.evidence.length + 1}`, kind: 'ENTITY', data: confirmed.evidence.at(-1)!.data }); }), 'INVALID', 'no entity fact without a focus');
});

test('status/intent pairing: UNSUPPORTED has zero claims and only with its intent; ANSWER needs claims; SUMMARY codes follow kinds', () => {
  const unsupported = ask('What is the root cause?', { id: 'obs-crit' });
  assert.deepEqual([unsupported.status, unsupported.intent, unsupported.claims.length, unsupported.urgentRefs.length > 0], ['UNSUPPORTED', 'UNSUPPORTED', 0, true]);
  assert.equal(after(unsupported, c => { c.claims = [{ code: 'OBSERVATION_RECORDED', refs: ['E1'] }]; }), 'INVALID');
  assert.equal(after(unsupported, c => { c.status = 'INSUFFICIENT'; }), 'INVALID');
  assert.equal(after(unsupported, c => { c.intent = 'SUMMARY'; }), 'INVALID');
  const summary = ask('What needs attention?');
  assert.equal(summary.claims.length, 3);
  for (const change of [(c: any) => { c.claims = []; }, (c: any) => { c.claims[0].code = 'RESOURCE_RECORDED'; }, (c: any) => { c.claims[1].refs = ['E1']; },
    (c: any) => { c.claims[0].refs = ['E99']; }, (c: any) => { c.claims[0].refs = [1]; }, (c: any) => { c.claims[0].code = 'HEALTHY'; },
    (c: any) => { c.claims[0].refs = 'E1'; }, (c: any) => { c.intent = 'UNSUPPORTED'; }]) assert.equal(after(summary, change), 'INVALID');
  const onlyResources = ask('What needs attention?', null, { page: [] });
  assert.deepEqual([onlyResources.status, onlyResources.claims.every(c => c.code === 'RESOURCE_RECORDED')], ['ANSWER', true]);
  const empty = ask('What needs attention?', null, { page: [], resources: [] });
  assert.deepEqual([empty.status, empty.evidence.length, after(empty, () => undefined)], ['INSUFFICIENT', 0, 'OK']);
});

test('capability and AskErrorV1: exact bodies, header correlation, fixed code/status pairs; nothing else is read', () => {
  const id = randomUUID();
  const h = new Headers({ 'x-atlas-correlation-id': id });
  assert.equal(validateCapability({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 }, h), 'mock');
  const bad = (f: () => unknown) => assert.throws(f, Invalid);
  for (const body of [{ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000, correlationId: id },
    { contractVersion: 'AskCapabilityV1', mode: 'live', questionMaxCodepoints: 2000 }, { contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 4000 },
    { contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000, model: 'x' }, { contractVersion: 'AskCapabilityV2', mode: 'mock', questionMaxCodepoints: 2000 }, []]) {
    bad(() => validateCapability(body, h));
  }
  for (const headers of [new Headers(), new Headers({ 'x-atlas-correlation-id': id.toUpperCase() }), new Headers({ 'x-atlas-correlation-id': 'corr-1' })]) {
    bad(() => validateCapability({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 }, headers));
  }
  assert.deepEqual(validateAskError({ contractVersion: 'AskErrorV1', code: 'ASK_SCOPE_CHANGED', correlationId: id }, h, 409), { code: 'ASK_SCOPE_CHANGED', correlationId: id });
  bad(() => validateAskError({ contractVersion: 'AskErrorV1', code: 'ASK_SCOPE_CHANGED', correlationId: id }, h, 503));
  bad(() => validateAskError({ contractVersion: 'AskErrorV1', code: 'ASK_SECRET', correlationId: id }, h, 503));
  bad(() => validateAskError({ contractVersion: 'AskErrorV1', code: 'ASK_BUSY', correlationId: id, message: 'detail' }, h, 429));
  bad(() => validateAskError({ contractVersion: 'AskErrorV1', code: 'ASK_BUSY', correlationId: randomUUID() }, h, 429));
  bad(() => validateAskError({ message: 'Not Found', statusCode: 404 }, h, 404));
});

test('R3: focus lifecycle agrees with coverage — DB extra focus any lifecycle; on-page or fixture focus active only; whole answer rejected', async () => {
  const resolved = observation('obs-resolved', { status: 'RESOLVED', resolvedAt: '2026-10-10T08:00:00.000Z' });
  const extraOpen = observation('obs-beyond', { status: 'OPEN', summary: 'Active row beyond the page (synthetic)' });
  const extraAck = observation('obs-beyond-ack', { status: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-10T08:00:00.000Z' });
  const suppressed = observation('obs-suppressed', { status: 'SUPPRESSED' });
  for (const [row, question] of [[resolved, 'Why is this urgent?'], [extraOpen, 'What needs attention?'], [extraAck, 'Which device is confirmed?'],
    [suppressed, 'How fresh is the evidence?']] as const) {
    const answer = ask(question, { extra: row });
    assert.equal(answer.coverage.focusExtra, true);
    assert.equal(after(answer, () => undefined), 'OK', `DB extra focus ${String(row.status)} is valid`);
    // The same nonactive/active focus claimed to be ON the page (focusExtra false, page count adjusted to keep the bank equation).
    const onPage = after(answer, c => { c.coverage.focusExtra = false; c.coverage.observationsRead += 1; });
    assert.equal(onPage, row.status === 'OPEN' || row.status === 'ACKNOWLEDGED' ? 'OK' : 'INVALID', `${String(row.status)} focus without focusExtra`);
  }
  const onPage = ask('Why is this urgent?', { id: 'obs-alert' });
  assert.equal(onPage.coverage.focusExtra, false);
  assert.equal(after(onPage, () => undefined), 'OK', 'active on-page DB focus');
  for (const status of ['RESOLVED', 'SUPPRESSED']) assert.equal(after(onPage, c => { c.evidence[0].data.status = status; }), 'INVALID', `on-page ${status}`);
  const fixture = await fixtureRead(null);
  const focusId = fixture.page[0]!.observationId;
  const fixtureAnswer = compiledAnswer(await fixtureRead(focusId), 'Why is this urgent?', focusId, { workspaceId: 'demo-vardahei', clientId: 'demo-gasta' });
  assert.equal(outcome(fixtureAnswer, frame(fixtureAnswer), askHeaders(fixtureAnswer.correlationId)), 'OK', 'fixture active focus');
  for (const status of ['RESOLVED', 'SUPPRESSED']) {
    assert.equal(after(fixtureAnswer, c => { c.evidence[0].data.status = status; }), 'INVALID', `fixture ${status} focus`);
    assert.equal(after(fixtureAnswer, c => { c.evidence[0].data.status = status; c.coverage.focusExtra = true; }), 'INVALID', 'fixture never has an extra focus');
  }
});
