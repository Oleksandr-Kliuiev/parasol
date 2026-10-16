import type { Classification, NormalizedEvent, Route } from '../../packages/core/contracts.ts';
import { routes } from '../../packages/core/contracts.ts';
import type { DecisionProvider } from '../../packages/decisions/provider.ts';

/**
 * Decision-layer fixtures (task 1.7): a scripted transport for the OpenAI Decisions endpoint (no network; bodies shaped
 * after the contract in docs/04 — synthetic, never recorded from an account) and a shadow provider held at a gate.
 */
export type Step = () => Response | Promise<Response>;
export function scriptedFetch(steps: Step[]): { fetch: typeof fetch; calls: { count: number; bodies: unknown[] } } {
  const calls = { count: 0, bodies: [] as unknown[] };
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const step = steps[calls.count++];
    calls.bodies.push(JSON.parse(String(init?.body ?? 'null')));
    if (!step) throw new Error('no scripted response left');
    return step();
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const answer = (choice: Route, confidence: number) => ({ type: 'choice', name: 'route', choice, confidence,
  probabilities: routes.map(value => ({ value, probability: value === choice ? confidence : (1 - confidence) / 2 })) });
/** One routed answer with usage; `model` defaults to the configured gpt-6-luna. */
export const routed = (choice: Route, confidence: number, model = 'gpt-6-luna', inputTokens = 42): Step =>
  json({ model, answers: [answer(choice, confidence)], usage: { input_tokens: inputTokens } });
export const refused: Step = json({ model: 'gpt-6-luna', answers: [{ type: 'refusal', name: 'route' }] });
/** Schema drift: a choice answer without its probability distribution. */
export const drifted: Step = json({ model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'route', choice: 'MONITOR', confidence: 0.9 }] });
/** What AbortSignal.timeout produces when the deadline passes. */
export const timedOut: Step = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
export const unavailable: Step = () => new Response('{}', { status: 503 });

/** A shadow-mode provider whose calls wait until `release`; `started` resolves when the first call is waiting. */
export function heldShadowProvider(answer: (event: NormalizedEvent) => Classification) {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const provider: DecisionProvider & { calls: number } = { provider: 'openai', mode: 'shadow', calls: 0,
    async classify(event) { this.calls++; entered(); await gate; return answer(event); } };
  return { provider, started, release };
}
/** Waits until the held provider is called; fails fast instead of hanging if the pass ends without calling it. */
export function calledDuring(started: Promise<void>, pass: Promise<unknown>): Promise<void> {
  let called = false;
  void started.then(() => { called = true; });
  const endedFirst = pass.then(() => { if (!called) throw new Error('the pass finished without calling the provider'); });
  endedFirst.catch(() => undefined); // reported through the race below when it wins; otherwise the test awaits the pass itself
  return Promise.race([started, endedFirst]);
}
export const modelRoute = (route: Route, confidence = 0.95): Classification => ({ route, confidence, provider: 'openai', promptVersion: 'event-route-v1',
  reasonCodes: ['MODEL_ROUTE'], requestedModel: 'gpt-6-luna', responseModel: 'gpt-6-luna', inputTokens: 42 });
