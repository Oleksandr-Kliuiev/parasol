import { readFileSync } from 'node:fs';
import { ASK_LIMITS } from '../../packages/ask/contracts.ts';
import { project } from '../../packages/ask/projection.ts';
import type { AskProjection } from '../../packages/ask/projection.ts';
import { remoteAnswer } from '../../packages/ask/remote/answer.ts';
import { validateEnvelope } from '../../packages/ask/remote/envelope.ts';
import { askRemoteRequest } from '../../packages/ask/remote/input.ts';
import { preparePayload, preparedBytes } from '../../packages/ask/remote/payload.ts';
import { UPSTREAM_REQUEST_MAX_BYTES } from '../../packages/ask/remote/profile.ts';
import { INTENTS, sha256 } from './dataset.ts';
import type { EvalCase, Intent } from './dataset.ts';
import { buildSource, SOURCE_MARKER } from './fixtures.ts';
import { expectedFactData } from './expected-facts.ts';
import type { FactData } from './expected-facts.ts';
import type { FixtureFile, FixtureSpec } from './fixtures.ts';
import { checkAnswer, classifyCase } from './predicates.ts';
import type { CaseVerdict, TruthFailure } from './predicates.ts';
import { scriptedResponse } from './provider-stub.ts';
import type { ScriptedOutcome } from './provider-stub.ts';

// Offline pipeline harness: for one case it runs the ACCEPTED pure production code end to end with a scripted in-memory
// provider — exact AskRequestV2 parse (raw ≤16 KiB), immutable question-only payload (≤16 KiB, exact developer/user
// messages, no bank/ID/marker on the wire), strict envelope validation, deterministic local selection/compiler (remoteAnswer)
// — then the independent predicates against the fixture expectation for the OBSERVED intent. No DB, network, key or clock.
// Results are fixed enums/booleans per case ID; questions, payloads and answers stay in memory and are dropped.

const PROMPT = JSON.parse(readFileSync(new URL('../../docs/stage5/ask/remote/intent-prompt.json', import.meta.url), 'utf8')) as { text: string };
export const ADMISSION_ID = '5e1f7a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const FRAME_TIME = '2026-10-10T08:00:00.000Z';
const uuidFor = (label: string): string => {
  const h = sha256(label);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface PreparedFixture {
  readonly spec: FixtureSpec; readonly projection: AskProjection; readonly reachability: readonly string[]; readonly markers: readonly string[];
  readonly facts: ReadonlyMap<string, FactData>;
}
/** Every identifier/label/summary marker of the fixture source: none may appear on the wire unless the question has it. */
function sourceMarkers(spec: FixtureSpec, projection: AskProjection): string[] {
  const out = new Set<string>([SOURCE_MARKER, spec.requestedFocus ?? SOURCE_MARKER, `"E1"`]);
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (/^(syn-|SYNTH-)/.test(v) || v.includes(SOURCE_MARKER)) out.add(v); }
    else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(projection.bank); walk(spec.entities); walk(spec.links); walk(spec.connections.map(c => c.id));
  return [...out];
}
export function prepareFixtures(file: FixtureFile): Map<string, PreparedFixture> {
  return new Map(file.fixtures.map(spec => {
    const { source, reachability } = buildSource(spec, file.scope);
    const projection = project(source);
    return [spec.fixtureId, { spec, projection, reachability, markers: sourceMarkers(spec, projection), facts: expectedFactData(spec, file.scope) }] as const;
  }));
}

export interface WireResult { readonly requestOk: boolean; readonly payloadOk: boolean; readonly hasFocusOk: boolean; readonly noSourceOnWire: boolean }
/** Request and payload checks for one case (the exact bytes are inspected in memory only). */
export function wireCheck(c: EvalCase, f: PreparedFixture): WireResult {
  const body = { contractVersion: 'AskRequestV2', requestId: uuidFor(`request:${c.caseId}`), question: c.question, observationId: f.spec.requestedFocus,
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: ADMISSION_ID, policyVersion: '1', questionDataClass: 'SYNTHETIC' } };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  let requestOk = raw.length <= ASK_LIMITS.rawBodyBytes;
  try { requestOk = requestOk && askRemoteRequest(JSON.parse(raw.toString('utf8'))).question === c.question; } catch { requestOk = false; }
  const hasFocus = f.projection.focusRef !== null;
  const hasFocusOk = hasFocus === c.hasFocus && hasFocus === f.spec.hasFocus;
  let payloadOk = false; let noSourceOnWire = false;
  try {
    const bytes = preparedBytes(preparePayload({ question: c.question, hasFocus }));
    if (bytes !== null && bytes.length <= UPSTREAM_REQUEST_MAX_BYTES) {
      const payload = JSON.parse(bytes.toString('utf8')) as { messages: { role: string; content: string }[] } & Record<string, unknown>;
      payloadOk = Object.keys(payload).join() === 'model,messages,reasoning_effort,service_tier,store,stream,n,max_completion_tokens,prompt_cache_options,response_format'
        && payload.messages.length === 2 && payload.messages[0]!.role === 'developer' && payload.messages[0]!.content === PROMPT.text
        && payload.messages[1]!.role === 'user' && payload.messages[1]!.content === JSON.stringify({ question: c.question, hasFocus });
      const wire = bytes.toString('utf8');
      noSourceOnWire = f.markers.every(m => c.question.includes(m) || !wire.includes(m));
    }
  } catch { payloadOk = false; }
  return { requestOk, payloadOk, hasFocusOk, noSourceOnWire };
}

export type ProviderResult =
  | { readonly kind: 'INTENT'; readonly intent: Intent }
  | { readonly kind: 'REJECTED'; readonly verdict: 'INVALID' | 'MALFORMED' | 'MODEL_MISMATCH' | 'USAGE_INVALID' | 'UPSTREAM' };
/** Scripted provider → accepted envelope validator. Only the validated five-enum intent leaves this function. */
export function scriptedProvider(outcome: ScriptedOutcome, intent: Intent): ProviderResult {
  const r = scriptedResponse(outcome, intent);
  const verdict = validateEnvelope(r.status, r.contentType, r.body);
  return verdict.kind === 'INTENT' ? { kind: 'INTENT', intent: verdict.intent } : { kind: 'REJECTED', verdict: verdict.kind };
}

export interface LocalResult { readonly truthPass: boolean; readonly failures: readonly TruthFailure[] }
/** remoteAnswer (accepted selector + validator + compiler) for an observed intent, judged by the independent predicates. */
export function localProjection(f: PreparedFixture, observed: Intent, scope: FixtureFile['scope'], label: string): LocalResult {
  const frame = { requestId: uuidFor(`request:${label}`), correlationId: uuidFor(`correlation:${label}`), workspaceId: scope.workspaceId, clientId: scope.clientId,
    sourceMode: 'db' as const, focusObservationId: f.spec.requestedFocus, generatedAt: FRAME_TIME };
  const { json } = remoteAnswer(observed, frame, f.projection, f.spec.requestedFocus);
  const truth = checkAnswer(JSON.parse(json), f.spec.expected, observed, f.spec.requestedFocus, scope, f.facts);
  return { truthPass: truth.pass, failures: truth.failures };
}

export interface CaseRun {
  readonly caseId: string; readonly wire: WireResult; readonly provider: 'VALIDATED_INTENT' | 'REJECTED'; readonly semantic: 'MATCH' | 'MISMATCH' | 'NOT_APPLICABLE';
  readonly truthPass: boolean | null; readonly failures: readonly TruthFailure[]; readonly verdict: CaseVerdict | 'PROVIDER_REJECTED';
}
/** One case through the whole offline pipeline; `scripted` is what the stub returns (defaults to the draft label). */
export function runCase(c: EvalCase, fixtures: ReadonlyMap<string, PreparedFixture>, scope: FixtureFile['scope'],
  scripted: { outcome: ScriptedOutcome; intent: Intent } = { outcome: 'INTENT', intent: c.expectedIntent }): CaseRun {
  const f = fixtures.get(c.fixtureId);
  if (!f) throw new Error('UNKNOWN_FIXTURE');
  const wire = wireCheck(c, f);
  const provider = scriptedProvider(scripted.outcome, scripted.intent);
  if (provider.kind !== 'INTENT') return { caseId: c.caseId, wire, provider: 'REJECTED', semantic: 'NOT_APPLICABLE', truthPass: null, failures: [], verdict: 'PROVIDER_REJECTED' };
  const local = localProjection(f, provider.intent, scope, c.caseId);
  const verdict = classifyCase(c.expectedIntent, provider.intent, { pass: local.truthPass, failures: local.failures }, 'CURRENT');
  return { caseId: c.caseId, wire, provider: 'VALIDATED_INTENT', semantic: provider.intent === c.expectedIntent ? 'MATCH' : 'MISMATCH',
    truthPass: local.truthPass, failures: local.failures, verdict };
}

/** Every fixture × all five possible observed intents through remoteAnswer + predicates. */
export function fixtureMatrix(fixtures: ReadonlyMap<string, PreparedFixture>, scope: FixtureFile['scope']): { fixtureId: string; intent: Intent; pass: boolean; failures: readonly TruthFailure[] }[] {
  const out: { fixtureId: string; intent: Intent; pass: boolean; failures: readonly TruthFailure[] }[] = [];
  for (const [fixtureId, f] of fixtures) {
    for (const intent of INTENTS) {
      const r = localProjection(f, intent, scope, `${fixtureId}:${intent}`);
      out.push({ fixtureId, intent, pass: r.truthPass, failures: r.failures });
    }
  }
  return out;
}
