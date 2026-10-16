import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_INTENTS, ASK_LIMITS, AskFailure } from '../packages/ask/contracts.ts';
import type { AskIntent } from '../packages/ask/contracts.ts';
import { mockPlan, MOCK_PHRASES } from '../packages/ask/planner.ts';
import type { AskPlannerInputV1 } from '../packages/ask/planner.ts';
import { project } from '../packages/ask/projection.ts';
import type { AskProjection } from '../packages/ask/projection.ts';
import { selectRefs } from '../packages/ask/selector.ts';
import { answer, compile } from '../packages/ask/compiler.ts';
import { validatePlan } from '../packages/ask/planner.ts';
import { askRemoteRequest } from '../packages/ask/remote/input.ts';
import { remoteAnswer } from '../packages/ask/remote/answer.ts';
import { ASK_REMOTE_ERROR_CODES, ASK_REMOTE_HTTP_STATUS, capabilityV2, remoteAuditRecord } from '../packages/ask/remote/contracts.ts';
import { RemoteCircuit } from '../packages/ask/remote/circuit.ts';
import { observation, resource, source, found } from './support/ask-source.ts';

// ASK-REMOTE R-B (pure): the extracted selector equals the accepted MOCK algorithm on generated banks; exact AskRequestV2,
// AskCapabilityV2 and AskAnswerV2 (15 V1 keys + fixed provenance, local facts identical to the MOCK compiler); the circuit.

/** The accepted S5ASKB-rc2 mockPlan selection, copied verbatim as the frozen reference for the "no behavior change" check. */
function acceptedSelection(intent: AskIntent, input: AskPlannerInputV1): string[] {
  const one = (ref: string | null) => ref === null ? [] : [ref];
  let refs: string[];
  if (intent === 'SUMMARY') {
    const observations = input.bank.filter(d => d.kind === 'OBSERVATION').map(d => d.ref);
    refs = (observations.length > 0 ? observations : input.bank.filter(d => d.kind === 'RESOURCE_STATE').map(d => d.ref)).slice(0, ASK_LIMITS.planRefs);
  } else if (intent === 'WHY_URGENT') refs = one(input.focusRef);
  else if (intent === 'SOURCE_STATE') refs = one(input.focusResourceRef);
  else if (intent === 'ENTITY') refs = one(input.focusEntityRef);
  else refs = [];
  return refs;
}
let seed = 20261011;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
function generated(): AskProjection {
  const page = Array.from({ length: rnd(30) }, (_, i) => observation(`o${i}`, { severity: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][rnd(4)]!,
    resourceType: ['alert', 'ticket', 'incident'][rnd(3)]!, connectionId: ['atera-a', 'atera-b'][rnd(2)]!, entityId: rnd(2) ? 'd1' : null }));
  const resources = Array.from({ length: rnd(10) }, () => resource(rnd(2) ? 'atera' : 'huntress', ['alert', 'ticket', 'incident'][rnd(3)]!, rnd(5) ? ['atera-a', 'atera-b'][rnd(2)]! : null));
  const focusCase = rnd(3);
  const focus = focusCase === 0 || page.length === 0 ? { state: 'NONE' as const } : found(focusCase === 1 ? page[rnd(page.length)]! : observation('extra', { severity: 'HIGH' }), focusCase === 1);
  return project(source({ page, resources, focus, entities: [{ id: 'd1', kind: 'DEVICE', label: 'Synthetic device' }],
    links: rnd(2) ? [{ entityId: 'd1', entityKind: 'DEVICE', system: 'atera', resourceType: 'agent', connectionId: 'atera-a', externalId: 'x1' }] : [] }));
}
const selection = (p: AskProjection) => ({ focusRef: p.focusRef, focusResourceRef: p.focusResourceRef, focusEntityRef: p.focusEntityRef, bank: p.descriptors });

test('selector: the extracted pure selection equals the accepted MOCK algorithm for every intent on 400 generated banks', () => {
  const phrase = Object.fromEntries(Object.entries(MOCK_PHRASES).map(([text, intent]) => [intent, text])) as Record<string, string>;
  for (let i = 0; i < 400; i += 1) {
    const p = generated();
    for (const intent of ASK_INTENTS) {
      const input = { question: phrase[intent] ?? 'root cause?', ...selection(p) };
      assert.deepEqual(selectRefs(intent, input), acceptedSelection(intent, input), `${i} ${intent}`);
      assert.deepEqual(mockPlan(input), { version: 'AskPlanV1', intent, refs: acceptedSelection(intent, input) });
    }
  }
});

const ACK = { contractVersion: 'AskRemoteDisclosureV1', admissionId: '3f1e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5', policyVersion: '42', questionDataClass: 'SYNTHETIC' };
const v2 = (patch: Record<string, unknown> = {}) => ({ contractVersion: 'AskRequestV2', requestId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', question: 'Что требует внимания?',
  observationId: null, acknowledgement: { ...ACK }, ...patch });
const label = (body: unknown) => JSON.stringify(body, (_k, v) => typeof v === 'bigint' ? `${v}n` : v)?.slice(0, 120);
const invalid = (body: unknown) => assert.throws(() => askRemoteRequest(body), (e: unknown) => e instanceof AskFailure && e.code === 'ASK_REQUEST_INVALID', label(body));

test('AskRequestV2: exact five keys and exact acknowledgement; V1 and every malformed consent are 400; question unchanged', () => {
  assert.deepEqual(askRemoteRequest(v2()), { requestId: v2().requestId, question: 'Что требует внимания?', observationId: null,
    acknowledgement: { admissionId: ACK.admissionId, policyVersion: '42' } });
  assert.equal(askRemoteRequest(v2({ question: '  raw\tquestion é ' })).question, '  raw\tquestion é ');
  assert.equal(askRemoteRequest(v2({ acknowledgement: { ...ACK, policyVersion: '9223372036854775807' } })).acknowledgement.policyVersion, '9223372036854775807');
  invalid({ contractVersion: 'AskRequestV1', requestId: v2().requestId, question: 'q', observationId: null });
  invalid(v2({ contractVersion: 'AskRequestV1' })); invalid(v2({ extra: 1 })); invalid(v2({ acknowledgement: undefined }));
  invalid({ ...v2(), acknowledgement: null }); invalid(v2({ acknowledgement: [] })); invalid(v2({ question: '' })); invalid(v2({ question: 'x'.repeat(2001) }));
  invalid(v2({ requestId: v2().requestId.toUpperCase() })); invalid(v2({ observationId: '' })); invalid(v2({ observationId: 'x'.repeat(257) })); invalid(v2({ observationId: 1 }));
  for (const ack of [{ ...ACK, contractVersion: 'AskRemoteDisclosureV2' }, { ...ACK, questionDataClass: 'CUSTOMER' }, { ...ACK, admissionId: ACK.admissionId.toUpperCase() },
    { ...ACK, admissionId: '3f1e2d3c-4b5a-1c6d-8e7f-90a1b2c3d4e5' }, { ...ACK, extra: true }, { ...ACK, provider: 'openai' },
    ...['0', '01', '+1', '-1', '1.0', ' 1', '1 ', '1e3', '9223372036854775808', '', 'x'].map(policyVersion => ({ ...ACK, policyVersion })),
    { ...ACK, policyVersion: 42 }, { ...ACK, policyVersion: 42n }, Object.fromEntries(Object.entries(ACK).filter(([k]) => k !== 'questionDataClass'))]) {
    invalid(v2({ acknowledgement: ack }));
  }
});

test('MOCK keeps refusing V2 requests exactly as accepted (the V1 parser is unchanged)', async () => {
  const { askRequest } = await import('../packages/ask/input.ts');
  assert.throws(() => askRequest(v2()), (e: unknown) => e instanceof AskFailure && e.code === 'ASK_REQUEST_INVALID');
  assert.throws(() => askRequest({ ...v2(), contractVersion: 'AskRequestV1' }), (e: unknown) => e instanceof AskFailure && e.code === 'ASK_REQUEST_INVALID');
});

test('AskCapabilityV2, remote error statuses and audit vocabulary are exact', () => {
  assert.equal(JSON.stringify(capabilityV2(ACK.admissionId, '42')), JSON.stringify({ contractVersion: 'AskCapabilityV2', mode: 'remote', questionMaxCodepoints: 2000,
    disclosure: { contractVersion: 'AskRemoteDisclosureV1', admissionId: ACK.admissionId, policyVersion: '42', provider: 'openai', model: 'gpt-6-luna',
      profile: 'ask-remote-openai-luna-v1', sent: 'QUESTION_AND_FOCUS_FLAG', dataClass: 'SYNTHETIC', region: 'EU', retention: 'OWNER_VERIFIED_ACCOUNT_POLICY',
      reserveMicroUsd: 300000 } }));
  assert.deepEqual({ ...ASK_REMOTE_HTTP_STATUS }, { ASK_REMOTE_NOT_ADMITTED: 503, ASK_REMOTE_POLICY_CHANGED: 409, ASK_REMOTE_BUDGET: 429, ASK_REMOTE_UNAVAILABLE: 503,
    ASK_REMOTE_INVALID: 503, ASK_REMOTE_MODEL_MISMATCH: 503, ASK_REMOTE_USAGE_INVALID: 503 });
  assert.equal(ASK_REMOTE_ERROR_CODES.length, 7);
  assert.deepEqual(remoteAuditRecord({ event: 'completed', status: 'ANSWER', itemCount: 3 }),
    { eventType: 'ask.completed', metadata: { provider: 'openai', ruleVersion: 'ask-remote-intent-v1', itemCount: '3', outcome: 'ANSWER' } });
  assert.deepEqual(remoteAuditRecord({ event: 'failed', code: 'ASK_REMOTE_MODEL_MISMATCH', itemCount: 0 }),
    { eventType: 'ask.failed', metadata: { provider: 'openai', ruleVersion: 'ask-remote-intent-v1', itemCount: '0', outcome: 'FAILED', safeErrorCode: 'ASK_REMOTE_MODEL_MISMATCH' } });
});

test('AskAnswerV2: exact 15 V1 keys + fixed provenance; claims/evidence/coverage/urgency identical to the MOCK compiler; db only', () => {
  const frame = { requestId: v2().requestId, correlationId: '1b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', workspaceId: 'ws', clientId: 'client', sourceMode: 'db' as const,
    focusObservationId: 'o1', generatedAt: '2026-10-11T00:00:00.000Z' };
  const focus = observation('o1', { severity: 'CRITICAL', entityId: 'd1' });
  const p = project(source({ page: [observation('o0'), focus], focus: found(focus), resources: [resource('atera', 'alert', 'atera-a'), resource('huntress', 'incident', 'h')],
    entities: [{ id: 'd1', kind: 'DEVICE', label: 'Synthetic device' }], links: [{ entityId: 'd1', entityKind: 'DEVICE', system: 'atera', resourceType: 'agent', connectionId: 'atera-a', externalId: 'x' }] }));
  for (const intent of ASK_INTENTS) {
    const remote = JSON.parse(remoteAnswer(intent, frame, p, 'o1').json);
    assert.deepEqual(Object.keys(remote), ['contractVersion', 'requestId', 'correlationId', 'workspaceId', 'clientId', 'mode', 'sourceMode', 'status', 'intent', 'generatedAt',
      'focusObservationId', 'coverage', 'urgentRefs', 'claims', 'evidence', 'provenance']);
    assert.deepEqual(remote.provenance, { provider: 'openai', model: 'gpt-6-luna', profile: 'ask-remote-openai-luna-v1', dataPolicy: 'QUESTION_ONLY_V1' });
    const mock = answer(frame, compile(validatePlan({ version: 'AskPlanV1', intent, refs: selectRefs(intent, selection(p)) }, new Set(p.bank.map(f => f.ref))), p, 'o1'), p);
    assert.deepEqual({ ...remote, contractVersion: 'AskAnswerV1', mode: 'mock', provenance: undefined }, { ...JSON.parse(JSON.stringify(mock)), provenance: undefined }, intent);
    assert.equal(remote.sourceMode, 'db'); assert.deepEqual(remote.urgentRefs, ['E1'], 'the CRITICAL focus is promoted to E1');
  }
  assert.equal(JSON.parse(remoteAnswer('WHY_URGENT', { ...frame, focusObservationId: null }, project(source({ page: [observation('o0')] })), null).json).status, 'INSUFFICIENT');
  assert.throws(() => remoteAnswer('SUMMARY', { ...frame, sourceMode: 'fixture' }, p, 'o1'), (e: unknown) => e instanceof AskFailure && e.code === 'ASK_RUNTIME_NOT_READY');
});

test('local circuit: trips synchronously, reopens only for a later revision than the committed pause, failed pause keeps it closed', () => {
  const c = new RemoteCircuit();
  assert.equal(c.allows('w', 5n), true);
  c.trip('w', 5n);
  assert.equal(c.allows('w', 5n), false); assert.equal(c.allows('w', 99n), false, 'no committed pause: closed until restart');
  assert.equal(c.allows('other', 5n), true);
  c.paused('w', 6n);
  assert.equal(c.allows('w', 6n), false); assert.equal(c.allows('w', 7n), true, 'a later owner revision reopens');
  assert.equal(c.size, 0);
  c.trip('w', 7n); c.paused('w', 7n);
  assert.equal(c.allows('w', 8n), false, 'a pause result not above the faulting attempt is not recorded');
  const d = new RemoteCircuit(); d.trip('w', 3n); d.paused('w', 4n); d.trip('w', 4n);
  assert.equal(d.allows('w', 5n), true, 'a fault of an attempt admitted under the paused version is already covered');
  d.trip('w', 5n);
  assert.equal(d.allows('w', 6n), false, 'a fault after reactivation closes the circuit again');
});
