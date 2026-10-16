import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AskFailure } from '../packages/ask/contracts.ts';
import { remoteAnswer } from '../packages/ask/remote/answer.ts';
import { flattenCorpus, INTENTS, loadCorpusFiles } from '../scripts/ask-remote-eval/dataset.ts';
import type { EvalCase, Intent } from '../scripts/ask-remote-eval/dataset.ts';
import { buildSource, loadFixtureFile } from '../scripts/ask-remote-eval/fixtures.ts';
import type { FixtureSpec } from '../scripts/ask-remote-eval/fixtures.ts';
import { fixtureMatrix, localProjection, prepareFixtures, runCase, scriptedProvider } from '../scripts/ask-remote-eval/harness.ts';
import { checkAnswer, classifyCase } from '../scripts/ask-remote-eval/predicates.ts';

// R-EVAL offline fixtures: reachable validated sources, hand-declared expectations for ALL five observed intents, the
// independent predicates catching tampered expectations and forged answers, and the semantic-vs-safety distinction.

const file = loadFixtureFile();
const fixtures = prepareFixtures(file);
const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
const specs = file.fixtures;
const answerFor = (fixtureId: string, intent: Intent) => {
  const f = fixtures.get(fixtureId)!;
  const frame = { requestId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', correlationId: '1c8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', workspaceId: file.scope.workspaceId,
    clientId: file.scope.clientId, sourceMode: 'db' as const, focusObservationId: f.spec.requestedFocus, generatedAt: '2026-10-10T08:00:00.000Z' };
  return JSON.parse(remoteAnswer(intent, frame, f.projection, f.spec.requestedFocus).json) as Record<string, any>;
};
const check = (fixtureId: string, intent: Intent, answer: unknown, expected = fixtures.get(fixtureId)!.spec.expected, facts = fixtures.get(fixtureId)!.facts) =>
  checkAnswer(answer, expected, intent, fixtures.get(fixtureId)!.spec.requestedFocus, file.scope, facts);

test('fixtures: every scenario is reachable under the accepted DB reader rules and built by the accepted validators', () => {
  assert.equal(fixtures.size, 11);
  for (const f of fixtures.values()) assert.deepEqual(f.reachability, [], f.spec.fixtureId);
  assert.deepEqual(fixtureMatrix(fixtures, file.scope).filter(m => !m.pass), []);
  assert.equal(fixtureMatrix(fixtures, file.scope).length, 55, 'all five observed intents per fixture');
});

test('scenario coverage: focus both ways, none/missing/off-page focus, empty bank, entity states, statuses, truncation, urgency beyond shown', () => {
  const by = (pred: (s: FixtureSpec) => boolean) => specs.filter(pred).map(s => s.fixtureId);
  const e = (s: FixtureSpec) => s.expected;
  assert.ok(by(s => s.hasFocus).length >= 4 && by(s => !s.hasFocus).length >= 4);
  assert.ok(by(s => s.focus.state === 'NONE').length > 0 && by(s => s.focus.state === 'MISSING').length > 0);
  assert.ok(by(s => s.focus.state === 'FOUND' && 'offPage' in s.focus).length > 0, 'off-page focus (focusExtra)');
  assert.ok(by(s => e(s).bank.length === 0).length > 0, 'empty bank');
  for (const state of ['CONFIRMED', 'UNRESOLVED']) assert.ok(by(s => e(s).entity?.state === state).length > 0, state);
  assert.ok(by(s => e(s).entity?.state === 'UNRESOLVED' && e(s).entity?.entityId !== null && s.readerExcludedLinks.length > 0).length > 0, 'candidate-only link');
  assert.ok(by(s => e(s).entity?.state === 'UNRESOLVED' && e(s).entity?.entityId === null).length > 0, 'no entity ID');
  for (const status of ['OK', 'STALE', 'ERROR', 'MISSING']) assert.ok(by(s => Object.values(e(s).resourceStatus).includes(status)).length > 0, status);
  assert.ok(by(s => s.connections.some(c => Object.values(c.states).some(x => x.truncated))).length > 0, 'truncated resource snapshot');
  for (const flag of ['observationPageTruncated', 'focusExtra', 'observationFactsOmitted', 'urgentFactsOmitted', 'resourceFactsOmitted']) {
    assert.ok(by(s => e(s).coverage[flag] === true).length > 0, flag);
  }
  const beyondShown = by(s => e(s).urgent.some(u => !e(s).intents.SUMMARY.claims.some(([, ref]) => ref === u)) && e(s).intents.SUMMARY.claims.length === 8);
  assert.ok(beyondShown.length >= 2, 'urgent facts beyond the first 8 shown');
  assert.ok(by(s => e(s).intents.WHY_URGENT.claims[0]?.[0] === 'SOURCE_NOT_URGENT_IN_READ' && e(s).urgent.length > 0).length > 0, 'focus not urgent while bank is');
  for (const intent of ['SUMMARY', 'WHY_URGENT', 'SOURCE_STATE', 'ENTITY'] as const) {
    assert.ok(by(s => e(s).intents[intent].status === 'ANSWER').length > 0 && by(s => e(s).intents[intent].status === 'INSUFFICIENT').length > 0, intent);
  }
  assert.ok(by(s => e(s).intents.SUMMARY.claims.some(([code]) => code === 'RESOURCE_RECORDED')).length > 0, 'SUMMARY resource fallback');
  const used = new Set(cases.map(c => c.fixtureId));
  assert.deepEqual([...fixtures.keys()].filter(id => !used.has(id)), [], 'every fixture is used by live cases');
});

test('reachability negatives: unreachable source shapes are rejected (order, truncation, types, candidate as confirmed, dangling entity)', () => {
  const base = specs.find(s => s.fixtureId === 'FX01')!;
  const issues = (patch: Partial<FixtureSpec>) => buildSource({ ...base, ...patch } as FixtureSpec, file.scope).reachability;
  assert.ok(issues({ page: [...base.page!].reverse() }).some(i => i.startsWith('PAGE_ORDER')));
  assert.ok(issues({ pageTruncated: true }).includes('TRUNCATED_PAGE_NOT_FULL'));
  assert.ok(issues({ connections: [{ id: 'syn-atera-1', system: 'atera', states: { agent: { status: 'OK', asOf: '2026-10-10T07:00:00.000Z', lastSuccessAt: null, truncated: false } } }, base.connections[1]!] }).includes('RESOURCE_TYPE'));
  assert.ok(issues({ readerExcludedLinks: [{ entityId: 'x', entityKind: 'DEVICE', status: 'CONFIRMED', system: 'atera', resourceType: 'agent', connectionId: 'syn-atera-1', externalId: 'e' }] }).includes('EXCLUDED_LINK_CONFIRMED'));
  assert.ok(issues({ page: [{ ...base.page![0]!, entityId: 'syn-dev-missing' }, ...base.page!.slice(1)] }).includes('ENTITY_FK'));
  assert.ok(issues({ connections: [...base.connections].reverse() }).includes('CONNECTION_ORDER'));
  assert.throws(() => buildSource({ ...base, links: [{ entityId: 'nope', entityKind: 'DEVICE', status: 'CONFIRMED', system: 'atera', resourceType: 'agent', connectionId: 'syn-atera-1', externalId: 'e' }] }, file.scope),
    (e: unknown) => e instanceof AskFailure && e.code === 'ASK_SOURCE_INVALID', 'accepted validator rejects a dangling confirmed link');
});

test('tampered expectations are detected per category (claims, urgency, coverage, resource status, entity, evidence)', () => {
  const tamper = (fixtureId: string, mutate: (x: any) => void) => { const x = structuredClone(fixtures.get(fixtureId)!.spec.expected); mutate(x); return x; };
  const cases_: [string, Intent, (x: any) => void, string][] = [
    ['FX02', 'WHY_URGENT', x => { x.intents.WHY_URGENT.claims[0][0] = 'SOURCE_NOT_URGENT_IN_READ'; }, 'CLAIMS'],
    ['FX08', 'SUMMARY', x => { x.urgent.pop(); }, 'URGENCY'],
    ['FX08', 'UNSUPPORTED', x => { x.coverage.urgentFactsOmitted = false; }, 'COVERAGE'],
    ['FX05', 'SOURCE_STATE', x => { x.resourceStatus['R:atera/alert/syn-atera-1'] = 'OK'; }, 'RESOURCE_STATUS'],
    ['FX05', 'ENTITY', x => { x.entity.confirmation.connectionId = 'syn-atera-1'; }, 'ENTITY'],
    ['FX11', 'SUMMARY', x => { x.bank.reverse(); }, 'EVIDENCE'],
    ['FX06', 'SUMMARY', x => { x.intents.SUMMARY.status = 'ANSWER'; }, 'STATUS']
  ];
  for (const [fixtureId, intent, mutate, failure] of cases_) {
    const r = check(fixtureId, intent, answerFor(fixtureId, intent), tamper(fixtureId, mutate) as never);
    assert.ok(!r.pass && r.failures.includes(failure as never), `${fixtureId} ${intent} → ${r.failures.join()}`);
  }
});

test('forged answers fail the independent predicates (dropped urgency, extra/wrong-ref claim, coverage lie, shape, provenance)', () => {
  const forge = (fixtureId: string, intent: Intent, mutate: (a: any) => void) => { const a = answerFor(fixtureId, intent); mutate(a); return check(fixtureId, intent, a); };
  assert.ok(check('FX02', 'WHY_URGENT', answerFor('FX02', 'WHY_URGENT')).pass);
  assert.ok(forge('FX02', 'UNSUPPORTED', a => { a.urgentRefs = a.urgentRefs.slice(1); }).failures.includes('URGENCY'));
  assert.ok(forge('FX08', 'SUMMARY', a => { a.urgentRefs.pop(); }).failures.includes('URGENCY'), 'urgent fact beyond the shown 8 dropped');
  assert.ok(forge('FX01', 'SUMMARY', a => { a.claims.push({ code: 'OBSERVATION_RECORDED', refs: ['E4'] }); }).failures.includes('CLAIMS'));
  assert.ok(forge('FX05', 'SOURCE_STATE', a => { a.claims[0].refs = ['E5']; }).failures.includes('CLAIMS'), 'OK resource of another connection substituted');
  assert.ok(forge('FX06', 'SUMMARY', a => { a.status = 'ANSWER'; }).failures.includes('STATUS'), 'false completeness on an empty bank');
  assert.ok(forge('FX08', 'SUMMARY', a => { a.coverage.observationPageTruncated = false; }).failures.includes('COVERAGE'));
  assert.ok(forge('FX03', 'ENTITY', a => { a.extra = 1; }).failures.includes('SHAPE'));
  assert.ok(forge('FX03', 'ENTITY', a => { a.provenance.model = 'gpt-6-luna-latest'; }).failures.includes('PROVENANCE'));
  assert.ok(forge('FX09', 'WHY_URGENT', a => { a.evidence[0].data.severity = 'LOW'; }).failures.includes('URGENCY'), 'severity downgrade');
  assert.ok(forge('FX10', 'UNSUPPORTED', a => { a.claims = [{ code: 'OBSERVATION_RECORDED', refs: ['E1'] }]; }).failures.includes('CLAIMS'));
});

test('grounded wrong intent is a SEMANTIC failure, never a safety one; a false local projection is SAFETY for any intent', () => {
  const entityCase = cases.find(c => c.caseId === 'RE-ENT-001')!;
  const wrong = runCase(entityCase, fixtures, file.scope, { outcome: 'INTENT', intent: 'SUMMARY' });
  assert.deepEqual([wrong.semantic, wrong.truthPass, wrong.verdict], ['MISMATCH', true, 'SEMANTIC_FAIL']);
  const refusal = cases.find(c => c.caseId === 'RE-ADV-001')!;
  const obeyed = runCase(refusal, fixtures, file.scope, { outcome: 'INTENT', intent: 'SUMMARY' });
  assert.deepEqual([obeyed.semantic, obeyed.truthPass, obeyed.verdict], ['MISMATCH', true, 'SEMANTIC_FAIL'], 'injection obeyed: semantic fail, local facts still true');
  assert.equal(runCase(entityCase, fixtures, file.scope).verdict, 'CASE_PASS');
  assert.equal(classifyCase('ENTITY', 'ENTITY', { pass: false, failures: ['URGENCY'] }, 'CURRENT'), 'SAFETY_FAIL');
  assert.equal(classifyCase('ENTITY', 'SUMMARY', { pass: false, failures: ['CLAIMS'] }, 'CURRENT'), 'SAFETY_FAIL');
  assert.equal(classifyCase('ENTITY', 'ENTITY', { pass: true, failures: [] }, 'UNAUTHORIZED'), 'SAFETY_FAIL', 'publication without current authority');
  assert.equal(classifyCase('ENTITY', 'SUMMARY', { pass: true, failures: [] }, 'UNAUTHORIZED'), 'SAFETY_FAIL');
  for (const intent of INTENTS) for (const id of fixtures.keys()) assert.ok(localProjection(fixtures.get(id)!, intent, file.scope, 'x').truthPass, `${id} ${intent}`);
});

test('scripted provider: only a validated exact intent passes; refusal/extra key/duplicate key/model/usage/HTTP never become an intent', () => {
  assert.deepEqual(scriptedProvider('INTENT', 'ENTITY'), { kind: 'INTENT', intent: 'ENTITY' });
  for (const [outcome, verdict] of [['REFUSAL', 'INVALID'], ['EXTRA_KEY', 'INVALID'], ['DUPLICATE_KEY', 'INVALID'], ['MODEL_MISMATCH', 'MODEL_MISMATCH'],
    ['USAGE_INVALID', 'USAGE_INVALID'], ['HTTP_429', 'UPSTREAM'], ['HTTP_401', 'UPSTREAM'], ['NOT_JSON', 'MALFORMED']] as const) {
    assert.deepEqual(scriptedProvider(outcome, 'SUMMARY'), { kind: 'REJECTED', verdict }, outcome);
  }
  const r = runCase(cases[0]!, fixtures, file.scope, { outcome: 'REFUSAL', intent: 'SUMMARY' });
  assert.deepEqual([r.provider, r.verdict, r.truthPass], ['REJECTED', 'PROVIDER_REJECTED', null]);
});

test('independence: the predicates import no production module; the fixture loader uses only the accepted source validators', () => {
  const predicates = readFileSync(new URL('../scripts/ask-remote-eval/predicates.ts', import.meta.url), 'utf8');
  const imports = predicates.split('\n').filter(l => /^import\b/.test(l));
  assert.ok(imports.length > 0 && imports.every(l => l.startsWith('import type ') && !l.includes('packages/')), imports.join('\n'));
  const factsModule = readFileSync(new URL('../scripts/ask-remote-eval/expected-facts.ts', import.meta.url), 'utf8');
  assert.deepEqual(factsModule.split('\n').filter(l => /^import /.test(l) && /packages\//.test(l)), [], 'expected facts never come from production modules');
  const loader = readFileSync(new URL('../scripts/ask-remote-eval/fixtures.ts', import.meta.url), 'utf8');
  assert.deepEqual(loader.split('\n').filter(l => /^import .*packages\//.test(l) && !l.startsWith('import type ')).map(l => l.replace(/.*from /, '')), ["'../../packages/ask/source.ts';"]);
  assert.ok(!/projection|selector|compiler|planner/.test(loader.split('\n').filter(l => l.startsWith('import')).join('\n')));
  const data = readFileSync(new URL('../docs/stage5/ask/remote/eval/data/fixtures.json', import.meta.url), 'utf8');
  assert.ok(!/"ref"\s*:/.test(data), 'expectations are identity keys, not copied production refs');
});

test('wire privacy: no fixture identifier, label, summary marker or bank ref reaches the serialized payload of any case', () => {
  for (const c of cases) {
    const r = runCase(c, fixtures, file.scope);
    assert.ok(r.wire.noSourceOnWire && r.wire.payloadOk && r.wire.requestOk && r.wire.hasFocusOk, c.caseId);
  }
});

test('full displayed facts: forged values that keep identity, claims and urgency intact still fail (reviewer falsifications)', () => {
  const only = (fixtureId: string, intent: Intent, mutate: (a: any) => void) => {
    const a = answerFor(fixtureId, intent); mutate(a);
    return [...check(fixtureId, intent, a).failures];
  };
  const fact = (a: any, id: string) => a.evidence.find((f: any) => (f.kind === 'OBSERVATION' ? `O:${f.data.observationId}` : f.kind === 'RESOURCE_STATE'
    ? `R:${f.data.source}/${f.data.resourceType}/${f.data.connectionId}` : `N:${f.data.observationId}`) === id).data;
  // Sol: fabricated summary, HIGH⇒CRITICAL on the focus (still urgent, same claim), SOURCE_STATE times from 2020 and truncated.
  assert.deepEqual(only('FX02', 'SUMMARY', a => { fact(a, 'O:syn-obs-b3').summary = 'Fabricated: ransomware confirmed'; }), ['OBSERVATION_DATA']);
  assert.deepEqual(only('FX02', 'WHY_URGENT', a => { fact(a, 'O:syn-obs-b2').severity = 'CRITICAL'; }), ['OBSERVATION_DATA']);
  assert.deepEqual(only('FX02', 'SOURCE_STATE', a => { const r = fact(a, 'R:atera/alert/syn-atera-1');
    r.asOf = '2020-01-01T00:00:00.000Z'; r.lastSuccessAt = '2020-01-01T00:00:00.000Z'; r.truncated = true; }), ['RESOURCE_DATA']);
  // Opus: truncation hidden (FX07 SUMMARY, FX04 SOURCE_STATE), focus RESOLVED⇒OPEN (FX09), focus entityId⇒null (FX02).
  assert.deepEqual(only('FX07', 'SUMMARY', a => { fact(a, 'R:atera/alert/syn-atera-1').truncated = false; }), ['RESOURCE_DATA']);
  assert.deepEqual(only('FX04', 'SOURCE_STATE', a => { fact(a, 'R:huntress/incident/syn-huntress-1').truncated = false; }), ['RESOURCE_DATA']);
  assert.deepEqual(only('FX09', 'WHY_URGENT', a => { const o = fact(a, 'O:syn-obs-x9'); o.status = 'OPEN'; o.resolvedAt = null; }), ['OBSERVATION_DATA']);
  assert.deepEqual(only('FX02', 'ENTITY', a => { fact(a, 'O:syn-obs-b2').entityId = null; }), ['OBSERVATION_DATA']);
  // Further displayed fields: ack time, route, reordered keys, an extra key, an injected item list, entity label.
  assert.deepEqual(only('FX05', 'WHY_URGENT', a => { fact(a, 'O:syn-obs-f1').acknowledgedAt = null; }), ['OBSERVATION_DATA']);
  assert.deepEqual(only('FX03', 'SUMMARY', a => { fact(a, 'O:syn-obs-c1').route = 'MONITOR'; }), ['OBSERVATION_DATA']);
  assert.deepEqual(only('FX10', 'SUMMARY', a => { const o = fact(a, 'O:syn-obs-h2'); const { summary, ...rest } = o; for (const k of Object.keys(o)) delete o[k]; Object.assign(o, rest, { summary }); }), ['OBSERVATION_DATA']);
  assert.deepEqual(only('FX08', 'SUMMARY', a => { fact(a, 'R:atera/alert/syn-atera-3').items = []; }), ['RESOURCE_DATA']);
  assert.deepEqual(only('FX03', 'SOURCE_STATE', a => { fact(a, 'R:huntress/incident/syn-huntress-1').lastSuccessAt = null; }), ['RESOURCE_DATA']);
  assert.deepEqual(only('FX09', 'ENTITY', a => { fact(a, 'N:syn-obs-x9').displayName = 'Someone else'; }), ['ENTITY']);
});

test('full displayed facts: every banked fact of every fixture has an independent expectation; a tampered expectation fails a true answer', () => {
  for (const f of fixtures.values()) for (const id of f.spec.expected.bank) if (!id.startsWith('N:')) assert.ok(f.facts.has(id), `${f.spec.fixtureId} ${id}`);
  const facts = new Map(fixtures.get('FX02')!.facts);
  facts.set('R:atera/alert/syn-atera-1', { ...facts.get('R:atera/alert/syn-atera-1')!, asOf: '2026-10-10T07:59:00.000Z' });
  assert.deepEqual([...check('FX02', 'SOURCE_STATE', answerFor('FX02', 'SOURCE_STATE'), undefined, facts).failures], ['RESOURCE_DATA']);
  // Observed intent governs the projection: a grounded wrong intent stays truthful under its OWN expectation.
  assert.ok(check('FX02', 'SUMMARY', answerFor('FX02', 'SUMMARY')).pass);
  assert.ok(!check('FX02', 'WHY_URGENT', answerFor('FX02', 'SUMMARY')).pass, 'judging against the wrong intent would mislabel it');
});
