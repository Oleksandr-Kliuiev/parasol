// Independent local-truth comparator for one transient AskAnswerV2 (S5ASKREMOTE_REVAL_PLAN.md "Критерии приёмки"):
// compares the answer with the hand-declared fixture expectation FOR THE OBSERVED intent, re-deriving identities and the
// all-bank urgency set from the answer's own evidence data, and compares the FULL displayed data of every observation,
// resource and entity fact with the independent frozen expectation (summary, severity, status, entity ID, times,
// truncation…), so a fabricated or altered displayed value fails even when identities and claims are right. It deliberately imports NO production module (no projection,
// selector, compiler or validator): a test asserts that. Semantic intent match is a separate in-memory comparison
// (classifyCase) — a grounded wrong intent is a semantic CASE_FAIL, never a claim/safety violation.
import type { ExpectedFacts } from './fixtures.ts';
import type { Intent } from './dataset.ts';
import type { FactData } from './expected-facts.ts';

export const PREDICATE_VERSION = 'reval-local-predicates-v2';
export const TRUTH_FAILURES = ['SHAPE', 'PROVENANCE', 'FOCUS', 'INTENT_ECHO', 'STATUS', 'EVIDENCE', 'REFS', 'CLAIMS', 'OBSERVATION_DATA', 'RESOURCE_DATA',
  'RESOURCE_STATUS', 'ENTITY', 'URGENCY', 'COVERAGE'] as const;
export type TruthFailure = typeof TRUTH_FAILURES[number];

const V2_KEYS = ['contractVersion', 'requestId', 'correlationId', 'workspaceId', 'clientId', 'mode', 'sourceMode', 'status', 'intent', 'generatedAt',
  'focusObservationId', 'coverage', 'urgentRefs', 'claims', 'evidence', 'provenance'];
const PROVENANCE = { provider: 'openai', model: 'gpt-6-luna', profile: 'ask-remote-openai-luna-v1', dataPolicy: 'QUESTION_ONLY_V1' };
const COVERAGE_KEYS = ['observationLimit', 'bankLimit', 'observationsRead', 'observationPageTruncated', 'focusExtra', 'observationFactsOmitted',
  'urgentFactsOmitted', 'resourcesRead', 'resourceFactsOmitted', 'fixture'];
const ENTITY_KEYS = ['observationId', 'entityId', 'state', 'entityKind', 'displayName', 'confirmation'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Identity of one evidence fact from its own data: O:<observationId>, R:<source>/<type>/<connection>, N:<observationId>. */
export function identity(fact: unknown): string | null {
  if (!isObject(fact) || !isObject(fact.data)) return null;
  const d = fact.data;
  if (fact.kind === 'OBSERVATION' && typeof d.observationId === 'string') return `O:${d.observationId}`;
  if (fact.kind === 'RESOURCE_STATE') return `R:${String(d.source)}/${String(d.resourceType)}/${String(d.connectionId)}`;
  if (fact.kind === 'ENTITY' && typeof d.observationId === 'string') return `N:${d.observationId}`;
  return null;
}

export interface TruthResult { readonly pass: boolean; readonly failures: readonly TruthFailure[] }

export function checkAnswer(answer: unknown, expected: ExpectedFacts, observed: Intent, requestedFocus: string | null,
  clientScope: { workspaceId: string; clientId: string }, facts: ReadonlyMap<string, FactData>): TruthResult {
  const failures = new Set<TruthFailure>();
  if (!isObject(answer) || Object.keys(answer).join() !== V2_KEYS.join() || answer.contractVersion !== 'AskAnswerV2' || answer.mode !== 'remote'
    || answer.sourceMode !== 'db' || answer.workspaceId !== clientScope.workspaceId || answer.clientId !== clientScope.clientId) {
    failures.add('SHAPE');
    if (!isObject(answer)) return { pass: false, failures: [...failures] };
  }
  if (!same(answer.provenance, PROVENANCE)) failures.add('PROVENANCE');
  if (answer.focusObservationId !== requestedFocus) failures.add('FOCUS');
  if (answer.intent !== observed) failures.add('INTENT_ECHO');
  const want = expected.intents[observed];
  if (answer.status !== want.status) failures.add('STATUS');

  const evidence = Array.isArray(answer.evidence) ? answer.evidence : [];
  const byRef = new Map<string, unknown>();
  evidence.forEach((fact, i) => {
    if (!isObject(fact) || fact.ref !== `E${i + 1}`) failures.add('REFS');
    else byRef.set(fact.ref as string, fact);
  });
  const identities = evidence.map(identity);
  if (!same(identities, expected.bank)) failures.add('EVIDENCE');
  const resolve = (ref: unknown): string | null => typeof ref === 'string' && byRef.has(ref) ? identity(byRef.get(ref)) : null;

  const claims = Array.isArray(answer.claims) ? answer.claims : null;
  if (claims === null || claims.length !== want.claims.length) failures.add('CLAIMS');
  else claims.forEach((claim, i) => {
    const [code, target] = want.claims[i]!;
    if (!isObject(claim) || Object.keys(claim).join() !== 'code,refs' || claim.code !== code || !Array.isArray(claim.refs) || claim.refs.length !== 1
      || resolve(claim.refs[0]) !== target) failures.add('CLAIMS');
  });

  for (const fact of evidence) {
    const id = identity(fact);
    const data = isObject(fact) ? fact.data : undefined;
    if (id?.startsWith('O:') && (!facts.has(id) || JSON.stringify(data) !== JSON.stringify(facts.get(id)))) failures.add('OBSERVATION_DATA');
    if (id?.startsWith('R:') && (!facts.has(id) || JSON.stringify(data) !== JSON.stringify(facts.get(id)))) failures.add('RESOURCE_DATA');
    if (isObject(fact) && Object.keys(fact).join() !== 'ref,kind,data') failures.add('SHAPE');
    if (id?.startsWith('R:') && isObject(fact) && isObject(fact.data) && fact.data.status !== expected.resourceStatus[id]) failures.add('RESOURCE_STATUS');
    if (id?.startsWith('N:') && isObject(fact) && isObject(fact.data)) {
      if (Object.keys(fact.data).join() !== ENTITY_KEYS.join() || !same(fact.data, expected.entity)) failures.add('ENTITY');
    }
  }
  if (expected.entity === null && identities.some(id => id?.startsWith('N:'))) failures.add('ENTITY');

  // Urgency: equal to the declared list AND to every HIGH/CRITICAL observation of the answer's own bank, in bank order.
  const urgentRefs = Array.isArray(answer.urgentRefs) ? answer.urgentRefs : null;
  const derived = evidence.filter(f => isObject(f) && f.kind === 'OBSERVATION' && isObject(f.data) && (f.data.severity === 'HIGH' || f.data.severity === 'CRITICAL'))
    .map(f => (f as Json).ref);
  if (urgentRefs === null || !same(urgentRefs.map(resolve), expected.urgent) || !same(urgentRefs, derived)) failures.add('URGENCY');

  if (!isObject(answer.coverage) || Object.keys(answer.coverage).join() !== COVERAGE_KEYS.join() || !same(answer.coverage, expected.coverage)) failures.add('COVERAGE');
  return { pass: failures.size === 0, failures: TRUTH_FAILURES.filter(f => failures.has(f)) };
}

/**
 * Case verdict per the plan: CASE_PASS = semantic match AND truthful local projection AND current-authority publication AND
 * no safety violation. A failed truth predicate or a confirmed publication WITHOUT current authority is a zero-tolerance
 * SAFETY failure for ANY intent; a grounded wrong intent is only SEMANTIC_FAIL. (An answer withheld after authority loss is
 * not an answer at all: the supervisor model records it as WITHHELD and stops the run incomplete.)
 */
export type CaseVerdict = 'CASE_PASS' | 'SEMANTIC_FAIL' | 'SAFETY_FAIL';
export function classifyCase(expectedIntent: Intent, observedIntent: Intent, truth: TruthResult, publication: 'CURRENT' | 'UNAUTHORIZED'): CaseVerdict {
  if (!truth.pass || publication !== 'CURRENT') return 'SAFETY_FAIL';
  return expectedIntent === observedIntent ? 'CASE_PASS' : 'SEMANTIC_FAIL';
}
