import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as browser from '../apps/operator/src/ask-contracts.ts';
import { validateAnswer, validateAskError, validateCapability, validateRemoteAnswer, validateRemoteCapability } from '../apps/operator/src/validate-ask.ts';
import type { AskExpectation } from '../apps/operator/src/validate-ask.ts';
import { Invalid } from '../apps/operator/src/validate-core.ts';
import * as server from '../packages/ask/remote/contracts.ts';
import { MAX_POLICY_VERSION, parsePolicyVersion } from '../packages/ask/remote/budget.ts';
import { ASK_INTENTS } from '../packages/ask/contracts.ts';
import type { AskIntent } from '../packages/ask/contracts.ts';
import { observation, WS } from './support/operator-journey.ts';
import { askHeaders, compiledAnswer, dbRead, fixtureRead, hostile, link, resource } from './support/operator-ask.ts';
import type { DbRead } from './support/operator-ask.ts';
import { ADMISSION, BIG_VERSION, remoteCapabilityBody, remoteCompiled } from './support/operator-ask-remote.ts';

// ASK-REMOTE R-C browser validation (docs/stage5/ask/remote/02): parity of the browser V2 copies with the accepted R-B server
// contracts; the exact AskCapabilityV2 (every disclosure key, BigInt-range canonical policyVersion string, never a Number);
// the exact AskAnswerV2 (15 V1 keys + fixed provenance, remote/db) validated through the SAME shared V1 predicates; remote
// error codes only where allowed. V1 (MOCK) validation is not loosened: a V2 body is never a MOCK answer and vice versa.
const CL = 'c-db';
const PHRASE: Record<Exclude<AskIntent, 'UNSUPPORTED'>, string> = { SUMMARY: 'What needs attention?', WHY_URGENT: 'Why is this urgent?',
  SOURCE_STATE: 'How fresh is the evidence?', ENTITY: 'Which device is confirmed?' };

function journey(focus: DbRead['focus'] = null, patch: Partial<DbRead> = {}) {
  return dbRead({ workspaceId: WS, clientId: CL, focus,
    page: [
      observation('obs-crit', { source: 'huntress', connectionId: 'conn-huntress', resourceType: 'incident', externalEventId: 'inc-1', kind: 'SECURITY_INCIDENT',
        domain: 'SECURITY', severity: 'CRITICAL', route: 'MONITOR', confidence: 0.05 }),
      observation('obs-alert', { externalEventId: 'alert-1' }),
      observation('obs-ticket', { resourceType: 'ticket', externalEventId: 'ticket-7', entityId: null, status: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-10T08:00:00.000Z' })
    ],
    devices: [{ id: 'd-1', label: 'HOST-01' }],
    links: [link('d-1', 'DEVICE', 'huntress', 'agent', 'conn-huntress', 'hagent-1'), link('d-1', 'DEVICE', 'atera', 'agent', 'conn-atera', 'agent-1')],
    resources: [resource('atera', 'alert', 'conn-atera', 'OK'), resource('huntress', 'incident', 'conn-huntress', 'STALE', { truncated: true })], ...patch });
}
const frame = (a: { requestId: string; workspaceId: string; clientId: string; sourceMode: 'db' | 'fixture'; focusObservationId: string | null }): AskExpectation =>
  ({ requestId: a.requestId, workspaceId: a.workspaceId, clientId: a.clientId, sourceMode: a.sourceMode, focusObservationId: a.focusObservationId });
function outcome(run: () => unknown): string {
  try { run(); return 'OK'; } catch (error) { if (error instanceof Invalid) return error.tooLarge ? 'TOO_LARGE' : 'INVALID'; throw error; }
}
const remote = (intent: AskIntent, focus: DbRead['focus'] = null) => {
  const { source, focusId } = journey(focus);
  return remoteCompiled(source, intent, focusId, { workspaceId: WS, clientId: CL });
};
const capHeaders = () => askHeaders(randomUUID());

test('parity: remote codes/statuses, provenance, fixed disclosure values and supported tasks are the accepted R-B server values', () => {
  assert.deepEqual([...browser.ASK_REMOTE_ERROR_CODES], [...server.ASK_REMOTE_ERROR_CODES]);
  assert.deepEqual({ ...browser.ASK_REMOTE_HTTP_STATUS }, { ...server.ASK_REMOTE_HTTP_STATUS });
  assert.deepEqual({ ...browser.REMOTE_PROVENANCE }, { ...server.ASK_REMOTE_PROVENANCE });
  const { admissionId, policyVersion, ...fixed } = server.capabilityV2(ADMISSION, '1').disclosure;
  assert.deepEqual([admissionId, policyVersion], [ADMISSION, '1']);
  assert.deepEqual({ ...browser.REMOTE_DISCLOSURE }, fixed);
  assert.deepEqual([...browser.REMOTE_TASKS], ASK_INTENTS.filter(i => i !== 'UNSUPPORTED'));
  assert.ok(browser.ASK_REMOTE_ERROR_CODES.every(code => !(browser.ASK_ERROR_CODES as readonly string[]).includes(code)), 'remote codes are disjoint from V1');
});

test('policyVersion: canonical positive decimal string ≤ 2^63−1 compared as BigInt; identical to the server parser; never Number', () => {
  const max = MAX_POLICY_VERSION.toString();
  const cases: unknown[] = ['1', '9', '10', BIG_VERSION, '9007199254740992', max, '9223372036854775806', '9223372036854775808', '9999999999999999999',
    '10000000000000000000', '18446744073709551615', '0', '00', '01', '-1', '+1', '1.0', '1e3', '0x10', ' 1', '1 ', '1\n', '١', '１', '', '9'.repeat(20),
    1, 0, 9007199254740993, 1n, null, undefined, true, {}, ['1'], new String('1')];
  for (const value of cases) assert.equal(browser.policyVersionValid(value), parsePolicyVersion(value) !== null, String(typeof value === 'string' ? JSON.stringify(value) : typeof value));
  assert.equal(browser.policyVersionValid(max), true);
  assert.equal(browser.policyVersionValid('9223372036854775808'), false, 'max + 1');
  // Precision: a Number round trip would turn these into a different (or equal) value; the validated string is kept exactly.
  const view = validateRemoteCapability(remoteCapabilityBody(ADMISSION, '9007199254740993'), capHeaders());
  assert.equal(view.policyVersion, '9007199254740993');
  assert.notEqual(String(Number(view.policyVersion)), view.policyVersion);
  assert.equal(validateRemoteCapability(remoteCapabilityBody(ADMISSION, max), capHeaders()).policyVersion, max);
});

test('AskCapabilityV2: the exact server body validates to the frozen admission tuple; any missing/extra/wrong key or mode/version mix is invalid', () => {
  const view = validateRemoteCapability(remoteCapabilityBody(), capHeaders());
  assert.deepEqual({ ...view }, { admissionId: ADMISSION, policyVersion: BIG_VERSION });
  assert.ok(Object.isFrozen(view));
  const bad = (change: (copy: any) => void, headers = capHeaders()) => outcome(() => validateRemoteCapability(hostile(remoteCapabilityBody(), change), headers));
  const mutations: [string, (c: any) => void][] = [
    ['V1 version', c => { c.contractVersion = 'AskCapabilityV1'; }], ['mode mock', c => { c.mode = 'mock'; }], ['limit', c => { c.questionMaxCodepoints = 2001; }],
    ['limit string', c => { c.questionMaxCodepoints = '2000'; }], ['extra top', c => { c.extra = 1; }], ['no disclosure', c => { delete c.disclosure; }],
    ['disclosure null', c => { c.disclosure = null; }], ['disclosure array', c => { c.disclosure = [c.disclosure]; }],
    ['disclosure version', c => { c.disclosure.contractVersion = 'AskRemoteDisclosureV2'; }], ['extra disclosure', c => { c.disclosure.url = 'https://example.invalid'; }],
    ['uppercase admission', c => { c.disclosure.admissionId = ADMISSION.toUpperCase(); }], ['uuid v1', c => { c.disclosure.admissionId = '5b0c9e57-3f7a-1d2e-9c1b-6a8e2f4d7c10'; }],
    ['admission number', c => { c.disclosure.admissionId = 1; }], ['version number', c => { c.disclosure.policyVersion = 2; }],
    ['version zero', c => { c.disclosure.policyVersion = '0'; }], ['version padded', c => { c.disclosure.policyVersion = '01'; }],
    ['version over max', c => { c.disclosure.policyVersion = '9223372036854775808'; }], ['version exponent', c => { c.disclosure.policyVersion = '1e3'; }],
    ['provider', c => { c.disclosure.provider = 'anthropic'; }], ['model', c => { c.disclosure.model = 'gpt-4.1-mini'; }],
    ['profile', c => { c.disclosure.profile = 'ask-remote-openai-luna-v2'; }], ['sent', c => { c.disclosure.sent = 'QUESTION_AND_EVIDENCE'; }],
    ['dataClass', c => { c.disclosure.dataClass = 'CUSTOMER'; }], ['region', c => { c.disclosure.region = 'US'; }],
    ['retention', c => { c.disclosure.retention = 'ZERO'; }], ['reserve', c => { c.disclosure.reserveMicroUsd = 300001; }],
    ['reserve string', c => { c.disclosure.reserveMicroUsd = '300000'; }], ['reserve float', c => { c.disclosure.reserveMicroUsd = 300000.5; }],
    ...['contractVersion', 'admissionId', 'policyVersion', 'provider', 'model', 'profile', 'sent', 'dataClass', 'region', 'retention', 'reserveMicroUsd']
      .map((key): [string, (c: any) => void] => [`missing ${key}`, c => { delete c.disclosure[key]; }])
  ];
  for (const [name, change] of mutations) assert.equal(bad(change), 'INVALID', name);
  assert.equal(outcome(() => validateRemoteCapability(remoteCapabilityBody(), new Headers({ 'content-type': 'application/json' }))), 'INVALID', 'no correlation header');
  // No mode mixing: the V1 validator refuses V2 and the V2 validator refuses V1 (MOCK V1 itself is unchanged).
  assert.equal(outcome(() => validateCapability(remoteCapabilityBody(), capHeaders())), 'INVALID');
  assert.equal(outcome(() => validateRemoteCapability({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 }, capHeaders())), 'INVALID');
  assert.equal(validateCapability({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 }, capHeaders()), 'mock');
});

test('AskAnswerV2: every server-compiled remote answer validates; its view equals the V1 view of the same intent except mode', () => {
  const focusCases: DbRead['focus'][] = [null, { id: 'obs-crit' }, { id: 'obs-alert' }, { id: 'obs-ticket' }, { missing: 'obs-missing' },
    { extra: observation('obs-resolved', { status: 'RESOLVED', resolvedAt: '2026-10-10T08:00:00.000Z', severity: 'HIGH', entityId: 'd-gone' }) }];
  const seen = new Set<string>();
  for (const focus of focusCases) {
    for (const intent of ASK_INTENTS) {
      const { source, focusId } = journey(focus);
      const v2 = remoteCompiled(source, intent, focusId, { workspaceId: WS, clientId: CL });
      assert.deepEqual(Object.keys(v2).length, 16);
      const view = validateRemoteAnswer(JSON.parse(JSON.stringify(v2)), askHeaders(v2.correlationId), frame(v2));
      seen.add(`${view.intent}/${view.status}`);
      assert.equal(view.mode, 'remote');
      assert.ok(Object.isFrozen(view) && Object.isFrozen(view.evidence) && view.evidence.every(f => Object.isFrozen(f) && Object.isFrozen(f.data)));
      assert.equal(JSON.stringify(view).includes('provenance'), false, 'no provenance or upstream value is retained');
      if (intent === 'UNSUPPORTED') continue;
      // Shared selection/compiler: the same intent asked through the accepted MOCK phrase compiles the same facts and claims.
      const v1 = compiledAnswer(source, PHRASE[intent], focusId, { workspaceId: WS, clientId: CL });
      const mock = validateAnswer(JSON.parse(JSON.stringify(v1)), askHeaders(v1.correlationId), frame(v1));
      const strip = (v: typeof view) => JSON.parse(JSON.stringify({ ...v, mode: null, requestId: null, correlationId: null }));
      assert.deepEqual(strip(view), strip(mock), `${intent} ${JSON.stringify(focus)}`);
      assert.equal(mock.mode, 'mock');
    }
  }
  for (const expected of ['SUMMARY/ANSWER', 'WHY_URGENT/ANSWER', 'WHY_URGENT/INSUFFICIENT', 'SOURCE_STATE/ANSWER', 'ENTITY/ANSWER', 'ENTITY/INSUFFICIENT', 'UNSUPPORTED/UNSUPPORTED']) {
    assert.ok(seen.has(expected), expected);
  }
});

test('AskAnswerV2 envelope: version/mode/provenance/sourceMode/keys exact; V1 is never a remote answer and V2 never a MOCK answer', async () => {
  const v2 = remote('WHY_URGENT', { id: 'obs-crit' });
  const headers = askHeaders(v2.correlationId);
  const bad = (change: (copy: any) => void, expected: Partial<AskExpectation> = {}) =>
    outcome(() => validateRemoteAnswer(hostile(v2, change), headers, { ...frame(v2), ...expected }));
  assert.equal(bad(() => undefined), 'OK');
  const mutations: [string, (c: any) => void][] = [
    ['V1 version', c => { c.contractVersion = 'AskAnswerV1'; }], ['mode mock', c => { c.mode = 'mock'; }], ['mode downgrade', c => { c.contractVersion = 'AskAnswerV1'; c.mode = 'mock'; }],
    ['no provenance', c => { delete c.provenance; }], ['provenance null', c => { c.provenance = null; }], ['extra provenance', c => { c.provenance.usage = { total_tokens: 5 }; }],
    ['provider', c => { c.provenance.provider = 'fixture'; }], ['model', c => { c.provenance.model = 'gpt-6-luna-2026-10-01'; }],
    ['profile', c => { c.provenance.profile = 'ask-mock-v1'; }], ['dataPolicy', c => { c.provenance.dataPolicy = 'QUESTION_AND_EVIDENCE'; }],
    ['missing dataPolicy', c => { delete c.provenance.dataPolicy; }], ['sourceMode fixture', c => { c.sourceMode = 'fixture'; c.coverage.fixture = true; }],
    ['extra key', c => { c.rawModelText = 'x'; }], ['missing key', c => { delete c.generatedAt; }],
    // The shared V1 predicates apply unchanged.
    ['requestId', c => { c.requestId = randomUUID(); }], ['client', c => { c.clientId = 'c-other'; }], ['workspace', c => { c.workspaceId = 'ws-other'; }],
    ['focus', c => { c.focusObservationId = 'obs-alert'; }], ['ref gap', c => { c.evidence[1].ref = 'E9'; }], ['urgent missing', c => { c.urgentRefs = []; }],
    ['claim to other', c => { c.claims[0].refs = ['E2']; }], ['claim code', c => { c.claims[0].code = 'SOURCE_NOT_URGENT_IN_READ'; }],
    ['unsupported with claims', c => { c.status = 'UNSUPPORTED'; c.intent = 'UNSUPPORTED'; }], ['coverage lie', c => { c.coverage.observationsRead = 0; }],
    ['unknown fact key', c => { c.evidence[0].data.email = 'x@example.invalid'; }], ['bad severity', c => { c.evidence[0].data.severity = 'URGENT'; }]
  ];
  for (const [name, change] of mutations) assert.equal(bad(change), 'INVALID', name);
  assert.equal(bad(() => undefined, { sourceMode: 'fixture' }), 'INVALID', 'a remote answer needs a captured DB context');
  assert.equal(outcome(() => validateRemoteAnswer(JSON.parse(JSON.stringify(v2)), askHeaders(randomUUID()), frame(v2))), 'INVALID', 'header correlation');
  // Each shared mutation that invalidates V2 also invalidates the V1 answer of the same read (no V1 weakening, no V2 gap).
  const { source, focusId } = journey({ id: 'obs-crit' });
  const v1 = compiledAnswer(source, 'Why is this urgent?', focusId, { workspaceId: WS, clientId: CL });
  for (const [name, change] of mutations.slice(14)) {
    assert.equal(outcome(() => validateAnswer(hostile(v1, change), askHeaders(v1.correlationId), frame(v1))), 'INVALID', `V1 ${name}`);
  }
  // Cross-version: neither validator accepts the other's body, even with the expectation of that very request.
  assert.equal(outcome(() => validateAnswer(JSON.parse(JSON.stringify(v2)), headers, frame(v2))), 'INVALID', 'V2 is never a MOCK answer');
  assert.equal(outcome(() => validateRemoteAnswer(JSON.parse(JSON.stringify(v1)), askHeaders(v1.correlationId), frame(v1))), 'INVALID', 'V1 is never a remote answer');
  const asV1 = hostile(v2, c => { delete c.provenance; c.contractVersion = 'AskAnswerV1'; c.mode = 'mock'; });
  assert.equal(outcome(() => validateAnswer(asV1, headers, frame(v2))), 'OK', 'control: the same facts are a valid V1 body');
  assert.equal(outcome(() => validateRemoteAnswer(asV1, headers, frame(v2))), 'INVALID', 'and still never a remote answer');
  // A fixture read can never be a remote answer (the server refuses it; the browser would too).
  const fixture = await fixtureRead(null);
  const fixtureV1 = compiledAnswer(fixture, 'What needs attention?', null, { workspaceId: 'demo-vardahei', clientId: 'demo-gasta' });
  const fixtureV2 = { ...fixtureV1, contractVersion: 'AskAnswerV2', mode: 'remote', provenance: { ...server.ASK_REMOTE_PROVENANCE } };
  assert.equal(outcome(() => validateRemoteAnswer(fixtureV2, askHeaders(fixtureV1.correlationId), frame(fixtureV1))), 'INVALID');
});

test('remote AskErrorV1 codes: accepted only with the remote list and their fixed statuses; the MOCK list is unchanged', () => {
  const h = (id: string) => askHeaders(id);
  for (const [code, status] of Object.entries(server.ASK_REMOTE_HTTP_STATUS)) {
    const id = randomUUID();
    const body = { contractVersion: 'AskErrorV1', code, correlationId: id };
    assert.deepEqual(validateAskError(body, h(id), status, true), { code, correlationId: id }, code);
    assert.equal(outcome(() => validateAskError(body, h(id), status)), 'INVALID', `${code} is not a MOCK code`);
    assert.equal(outcome(() => validateAskError(body, h(id), status === 503 ? 409 : 503, true)), 'INVALID', `${code} wrong status`);
  }
  const id = randomUUID();
  assert.deepEqual(validateAskError({ contractVersion: 'AskErrorV1', code: 'ASK_DEADLINE', correlationId: id }, h(id), 504, true), { code: 'ASK_DEADLINE', correlationId: id });
  for (const body of [{ contractVersion: 'AskErrorV1', code: 'ASK_REMOTE_SECRET', correlationId: id }, { contractVersion: 'AskErrorV2', code: 'ASK_REMOTE_INVALID', correlationId: id },
    { contractVersion: 'AskErrorV1', code: 'ASK_REMOTE_INVALID', correlationId: id, upstream: 'detail' }, { contractVersion: 'AskErrorV1', code: 'ASK_REMOTE_INVALID', correlationId: randomUUID() }]) {
    assert.equal(outcome(() => validateAskError(body, h(id), 503, true)), 'INVALID', JSON.stringify(body).slice(0, 80));
  }
});
