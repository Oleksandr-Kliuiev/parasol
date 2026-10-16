import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskFailure } from '../packages/ask/contracts.ts';
import { askRemoteRequest } from '../packages/ask/remote/input.ts';
import { preparePayload, preparedBytes } from '../packages/ask/remote/payload.ts';
import { refusalTemplate, supportedTemplate, validateRefusalReview, validateSupportedReview, readAdjudication, REFUSAL_TEMPLATE, SUPPORTED_TEMPLATE } from '../scripts/ask-remote-eval/adjudication.ts';
import { CORPUS_FILES, flattenCorpus, loadCorpusFiles, MANIFEST_FILE, readData, stableOrder, validateCorpus } from '../scripts/ask-remote-eval/dataset.ts';
import type { EvalCase } from '../scripts/ask-remote-eval/dataset.ts';
import { datasetManifest } from '../scripts/ask-remote-eval/evidence.ts';
import { loadFixtureFile } from '../scripts/ask-remote-eval/fixtures.ts';

// R-EVAL offline corpus: the frozen RC6 matrix, uniqueness/diversity, in-bounds limits on the accepted request/payload
// code, manifest hashes and the human-review templates. Labels are DRAFT; nothing here measures classification.

const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
const fixtureFile = loadFixtureFile();
const fixtureIds = new Set(fixtureFile.fixtures.map(f => f.fixtureId));
const fixtureFocus = new Map(fixtureFile.fixtures.map(f => [f.fixtureId, f.hasFocus]));
const issuesOf = (list: unknown[]) => validateCorpus(list, fixtureIds, fixtureFocus).map(i => i.code);
const clone = () => cases.map(c => ({ ...c })) as Record<string, unknown>[];

test('matrix: exactly 200 cases in the RC6 group/language counts; the last 100 are all UNSUPPORTED', () => {
  const count = (group: string, language?: string) => cases.filter(c => c.group === group && (language === undefined || c.language === language)).length;
  const plan: [string, number, number][] = [['SUPPORTED_SUMMARY', 13, 12], ['SUPPORTED_WHY_URGENT', 12, 13], ['SUPPORTED_SOURCE_STATE', 13, 12],
    ['SUPPORTED_ENTITY', 12, 13], ['UNSUPPORTED', 30, 30], ['ADVERSARIAL', 20, 20]];
  for (const [group, ru, en] of plan) assert.deepEqual([count(group, 'ru'), count(group, 'en')], [ru, en], group);
  assert.equal(cases.length, 200);
  assert.equal(cases.filter(c => c.language === 'ru').length, 100);
  assert.ok(cases.slice(100).every(c => c.expectedIntent === 'UNSUPPORTED' && (c.group === 'UNSUPPORTED' || c.group === 'ADVERSARIAL')));
  assert.ok(cases.slice(0, 100).every(c => c.expectedIntent !== 'UNSUPPORTED'));
  assert.deepEqual(issuesOf(cases), []);
});

test('categories: all eight unsupported and five adversarial categories exist in BOTH languages; both focus sides per group', () => {
  for (const [group, cats] of [['UNSUPPORTED', ['OUT_OF_SCOPE', 'AMBIGUOUS', 'MULTI_INTENT', 'OTHER_CLIENT', 'ROOT_CAUSE', 'REMEDIATION', 'M365', 'FINANCE']],
    ['ADVERSARIAL', ['INJECTION', 'QUOTED_SECRET', 'BOUNDARY', 'SCOPE_AUTHORITY', 'OUTPUT_REVEAL']]] as const) {
    for (const cat of cats) for (const lang of ['ru', 'en']) assert.ok(cases.some(c => c.group === group && c.category === cat && c.language === lang), `${cat} ${lang}`);
  }
  for (const group of new Set(cases.map(c => c.group))) for (const f of [true, false]) assert.ok(cases.some(c => c.group === group && c.hasFocus === f), `${group} ${f}`);
  assert.ok(cases.every(c => c.labelStatus === 'DRAFT_MODEL_ASSISTED' && c.attestation === 'HUMAN_ATTESTATION_PENDING'));
});

test('limits: every question is accepted unchanged by the exact AskRequestV2 parser and fits the ≤16 KiB question-only payload', () => {
  let nearLimit = 0;
  for (const c of cases) {
    const body = { contractVersion: 'AskRequestV2', requestId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', question: c.question, observationId: null,
      acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: '3f1e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5', policyVersion: '1', questionDataClass: 'SYNTHETIC' } };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 16 * 1024, c.caseId);
    assert.equal(askRemoteRequest(body).question, c.question, c.caseId);
    assert.ok(preparedBytes(preparePayload({ question: c.question, hasFocus: c.hasFocus }))!.length <= 16 * 1024, c.caseId);
    if (Array.from(c.question).length > 1900) nearLimit += 1;
  }
  assert.ok(nearLimit >= 1, 'one in-bounds near-limit boundary case');
});

test('offline pre-egress negatives (NOT live cases): over-limit, lone surrogate and control text are 400; worst-case 2000-point text fits 16 KiB', () => {
  const invalid = (question: string) => assert.throws(() => preparePayload({ question, hasFocus: false }), (e: unknown) => e instanceof AskFailure && e.code === 'ASK_REQUEST_INVALID');
  invalid('x'.repeat(2001)); invalid('ok \ud800 lone'); invalid('bell \u0007'); invalid('   ');
  for (const unit of ['"', '\\', '😀', '\u2028x', 'x\n']) {
    const bytes = preparedBytes(preparePayload({ question: unit.repeat(2000 / Array.from(unit).length), hasFocus: true }))!;
    assert.ok(bytes.length <= 16 * 1024, `max-expansion ${JSON.stringify(unit)} → ${bytes.length}`);
  }
  // Invalid UTF-8 cannot enter the frozen dataset: the loader decodes fatally instead of substituting U+FFFD.
  const corrupt = (name: string) => name === CORPUS_FILES[0] ? Buffer.concat([readData(name).subarray(0, 40), Buffer.from([0xc3, 0x28]), readData(name).subarray(40)]) : readData(name);
  assert.throws(() => loadCorpusFiles(corrupt), TypeError);
});

test('uniqueness and diversity negatives: duplicate ID/text, ID-only substitution, near duplicate, matrix/label/focus/content drift', () => {
  const dupId = clone(); dupId[5]!.caseId = dupId[4]!.caseId;
  assert.ok(issuesOf(dupId).includes('CASE_ID_DUPLICATE'));
  const dupText = clone(); dupText[7]!.question = dupText[6]!.question;
  assert.ok(issuesOf(dupText).includes('QUESTION_DUPLICATE'));
  const idSwap = clone(); const other = idSwap.find(c => c.caseId === 'RE-UNS-024')!;
  idSwap.find(c => c.caseId === 'RE-UNS-028')!.question = String(other.question).replace('SYNTH-CLIENT-002', 'SYNTH-CLIENT-099');
  assert.ok(issuesOf(idSwap).includes('QUESTION_SUPERFICIAL_VARIANT'));
  const near = clone(); near.find(c => c.caseId === 'RE-SUM-024')!.question = 'What is currently open for the selected client, please?';
  assert.ok(issuesOf(near).includes('QUESTION_NEAR_DUPLICATE'));
  const lang = clone(); lang[0]!.language = 'en';
  assert.ok(issuesOf(lang).includes('MATRIX_SUPPORTED_SUMMARY_RU'));
  const adv = clone(); adv[150]!.expectedIntent = 'SUMMARY';
  assert.ok(issuesOf(adv).includes('CASE_GROUP_INTENT'));
  const human = clone(); human[3]!.labelStatus = 'HUMAN_VERIFIED';
  assert.ok(issuesOf(human).includes('CASE_LABEL_STATUS'));
  const focus = clone(); focus[0]!.hasFocus = true;
  assert.ok(issuesOf(focus).includes('CASE_HAS_FOCUS_MISMATCH'));
  for (const leak of ['use sk-abcdefghijklmnop', 'mail ops@example.com', 'AKIAABCDEFGHIJKLMNOP']) {
    const bad = clone(); bad[120]!.question = `${String(bad[120]!.question)} ${leak}`;
    assert.ok(issuesOf(bad).includes('CASE_FORBIDDEN_CONTENT'), leak);
  }
  const big = clone(); big[160]!.question = 'q'.repeat(2001);
  assert.ok(issuesOf(big).includes('CASE_QUESTION_BOUNDS'));
  assert.ok(issuesOf(clone().slice(1)).includes('CORPUS_SIZE'));
});

test('manifest: committed hashes equal the files; one changed byte changes the identity; stable seeded order', () => {
  const committed = JSON.parse(readData(MANIFEST_FILE).toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(committed, datasetManifest(cases));
  const tampered = datasetManifest(cases, name => name === 'cases-unsupported.jsonl' ? Buffer.from(readData(name).toString('utf8').replace('"Explain."', '"Explain!"')) : readData(name));
  assert.notEqual(tampered.corpusSha256, committed.corpusSha256);
  const a = stableOrder(cases.map(c => c.caseId)); const b = stableOrder([...cases.map(c => c.caseId)].reverse());
  assert.deepEqual(a, b, 'order depends only on the seed and IDs');
  assert.equal(a.orderSha256, committed.orderSha256);
  assert.deepEqual([...a.order].sort(), cases.map(c => c.caseId).sort());
  assert.notEqual(stableOrder(cases.map(c => c.caseId), 'other-seed').orderSha256, a.orderSha256);
  for (const name of CORPUS_FILES) assert.ok(readData(name).toString('utf8').split('\n').length <= 501, name);
});

test('human review: committed templates are empty PENDING; model attestations, same reviewer and divergent labels never resolve', () => {
  assert.equal(readAdjudication(REFUSAL_TEMPLATE), refusalTemplate(cases));
  assert.equal(readAdjudication(SUPPORTED_TEMPLATE), supportedTemplate(cases));
  const pending = validateRefusalReview(readAdjudication(REFUSAL_TEMPLATE), cases);
  assert.deepEqual({ ...pending, issues: [...pending.issues] }, { issues: [], resolved: 0, total: 100, humanAttestationComplete: false });
  assert.equal(validateSupportedReview(readAdjudication(SUPPORTED_TEMPLATE), cases).humanAttestationComplete, false);
  const rows = readAdjudication(REFUSAL_TEMPLATE).trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  const review = (ref: string, kind = 'HUMAN', label = 'UNSUPPORTED') => ({ reviewerKind: kind, reviewerRef: ref, label, basis: 'rubric R2', reviewedAt: '2026-10-20T10:00:00Z' });
  const render = (patch: (r: Record<string, unknown>, i: number) => void) => rows.map((r, i) => { const x = structuredClone(r); patch(x, i); return JSON.stringify(x); }).join('\n') + '\n';
  // In-memory synthetic completion only (never written): two distinct humans agree on every refusal case.
  const agreed = validateRefusalReview(render(r => { r.reviewerA = review('rev-a'); r.reviewerB = review('rev-b'); r.status = 'AGREED'; }), cases);
  assert.deepEqual([agreed.resolved, agreed.humanAttestationComplete], [100, true]);
  const model = validateRefusalReview(render((r, i) => { if (i === 0) { r.reviewerA = review('opus', 'MODEL'); r.reviewerB = review('rev-b'); r.status = 'AGREED'; } }), cases);
  assert.ok(model.issues.some(x => x.endsWith('A_NOT_HUMAN')) && !model.humanAttestationComplete);
  const same = validateRefusalReview(render((r, i) => { if (i === 1) { r.reviewerA = review('rev-a'); r.reviewerB = review('rev-a'); r.status = 'AGREED'; } }), cases);
  assert.ok(same.issues.some(x => x.endsWith('SAME_REVIEWER')));
  const diverge = validateRefusalReview(render((r, i) => { if (i === 2) { r.reviewerA = review('rev-a', 'HUMAN', 'SUMMARY'); r.reviewerB = review('rev-b', 'HUMAN', 'SUMMARY'); r.status = 'AGREED'; } }), cases);
  assert.ok(diverge.issues.some(x => x.endsWith('LABEL_DIVERGES_FROM_DRAFT')));
  const single = validateRefusalReview(render((r, i) => { if (i === 3) { r.reviewerA = review('rev-a'); r.status = 'AGREED'; } }), cases);
  assert.ok(single.issues.some(x => x.endsWith('RESOLVED_WITHOUT_TWO_REVIEWS')));
});
