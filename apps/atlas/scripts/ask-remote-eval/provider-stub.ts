// Scripted IN-MEMORY provider outcomes for the offline harness. These are fabricated upstream envelopes fed to the
// accepted pure envelope validator; no transport, socket or key is involved. When the scripted intent is the dataset's
// own label the run is a pipeline rehearsal, NOT a classification measurement (semanticEvaluation=false).
import type { Intent } from './dataset.ts';

export const SCRIPTED_OUTCOMES = ['INTENT', 'REFUSAL', 'EXTRA_KEY', 'DUPLICATE_KEY', 'MODEL_MISMATCH', 'USAGE_INVALID', 'HTTP_429', 'HTTP_401', 'NOT_JSON'] as const;
export type ScriptedOutcome = typeof SCRIPTED_OUTCOMES[number];

export interface StubResponse { readonly status: number; readonly contentType: string; readonly body: Buffer }
const USAGE = { prompt_tokens: 600, completion_tokens: 20, total_tokens: 620 };

function envelope(content: string, patch: Record<string, unknown> = {}, message: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'chatcmpl-synthetic-offline', object: 'chat.completion', created: 0, model: 'gpt-6-luna', service_tier: 'default',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content, refusal: null, ...message } }], usage: USAGE, ...patch });
}

export function scriptedResponse(outcome: ScriptedOutcome, intent: Intent): StubResponse {
  const ok = (text: string): StubResponse => ({ status: 200, contentType: 'application/json', body: Buffer.from(text, 'utf8') });
  const intentText = JSON.stringify({ version: 'AskRemoteIntentV1', intent });
  switch (outcome) {
    case 'INTENT': return ok(envelope(intentText));
    case 'REFUSAL': return ok(envelope('', {}, { content: null, refusal: 'synthetic refusal' }));
    case 'EXTRA_KEY': return ok(envelope(JSON.stringify({ version: 'AskRemoteIntentV1', intent, refs: ['E1'] })));
    case 'DUPLICATE_KEY': return ok(envelope(`{"version":"AskRemoteIntentV1","intent":"${intent}","intent":"SUMMARY"}`));
    case 'MODEL_MISMATCH': return ok(envelope(intentText, { model: 'gpt-6-luna-2026-10-01' }));
    case 'USAGE_INVALID': return ok(envelope(intentText, { usage: { prompt_tokens: 600, completion_tokens: 20, total_tokens: 621 } }));
    case 'HTTP_429': return { status: 429, contentType: 'application/json', body: Buffer.from('{}') };
    case 'HTTP_401': return { status: 401, contentType: 'application/json', body: Buffer.from('{}') };
    case 'NOT_JSON': return { status: 200, contentType: 'text/plain', body: Buffer.from('not json') };
  }
}

/** Validated usage of the scripted success envelope, for the settlement-cost arithmetic of the rehearsal. */
export const STUB_USAGE = Object.freeze({ promptTokens: USAGE.prompt_tokens, completionTokens: USAGE.completion_tokens });
