import { ASK_INTENTS } from '../contracts.ts';
import type { AskIntent } from '../contracts.ts';
import { jsonContentType } from '../input.ts';
import { MAX_COMPLETION_TOKENS as MAX_COMPLETION, MAX_PROMPT_TOKENS } from './budget.ts';
import type { Usage } from './budget.ts';
import { ASK_REMOTE_MODEL, ASK_REMOTE_TIER } from './contracts.ts';
import { parseStrictJson } from './json.ts';
import { INTENT_CONTENT_MAX_BYTES } from './profile.ts';

/**
 * Local validation of one bounded upstream response (docs/stage5/ask/remote/03 "Wire profile"). Schema generation upstream
 * is not validation: everything is checked here, and nothing of the upstream text, metadata, status or headers is returned.
 *   status ≠ 200 → UPSTREAM (401/403 trip the configuration-fault circuit; every status maps to ASK_REMOTE_UNAVAILABLE)
 *   not application/json, not fatal UTF-8, not strict JSON (duplicate key at any depth), not an object → MALFORMED
 *   model ≠ 'gpt-6-luna' or service_tier ≠ 'default' (missing, other type, dated ID) → MODEL_MISMATCH (pause, full reserve)
 *   usage missing/invalid (exact key allowlist, safe-integer bounds, sum, forbidden nonzero counters) → USAGE_INVALID (pause)
 *   then object/one choice/index 0/stop/assistant/nonempty text ≤2 KiB/no refusal/tool/function/audio/unknown message key and
 *   the EXACT intent object (strict JSON, keys version+intent only) → INTENT; any failure there → INVALID with the verified
 *   usage (cost-only settlement, never an answer). Benign extra top-level/choice metadata is ignored, never projected.
 */
export type EnvelopeVerdict =
  | { readonly kind: 'INTENT'; readonly intent: AskIntent; readonly usage: Usage }
  | { readonly kind: 'INVALID'; readonly usage: Usage }
  | { readonly kind: 'MALFORMED' }
  | { readonly kind: 'MODEL_MISMATCH' }
  | { readonly kind: 'USAGE_INVALID' }
  | { readonly kind: 'UPSTREAM'; readonly auth: boolean };

type Json = Record<string, unknown>;
const plain = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const count = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const absentOrNull = (o: Json, key: string): boolean => !Object.hasOwn(o, key) || o[key] === null;

/** text_tokens ≤ the parent total; every other known counter of this text-only/none/no-cache profile must be 0. */
const PROMPT_DETAILS: Readonly<Record<string, 'text' | 'zero'>> = { text_tokens: 'text', cached_tokens: 'zero', cache_write_tokens: 'zero', audio_tokens: 'zero', image_tokens: 'zero' };
const COMPLETION_DETAILS: Readonly<Record<string, 'text' | 'zero'>> = { text_tokens: 'text', reasoning_tokens: 'zero', audio_tokens: 'zero', image_tokens: 'zero',
  accepted_prediction_tokens: 'zero', rejected_prediction_tokens: 'zero' };
const USAGE_KEYS: ReadonlySet<string> = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details']);

function details(value: unknown, spec: Readonly<Record<string, 'text' | 'zero'>>, parent: number): boolean {
  if (!plain(value)) return false;
  return Object.entries(value).every(([key, v]) => Object.hasOwn(spec, key) && count(v, parent) && (spec[key] === 'text' || v === 0));
}
export function usageOf(value: unknown): Usage | null {
  if (!plain(value) || !Object.keys(value).every(k => USAGE_KEYS.has(k))) return null;
  const { prompt_tokens: p, completion_tokens: c, total_tokens: t } = value;
  if (!count(p, MAX_PROMPT_TOKENS) || !count(c, MAX_COMPLETION) || !Number.isSafeInteger(t) || t !== p + c) return null;
  if (Object.hasOwn(value, 'prompt_tokens_details') && !details(value.prompt_tokens_details, PROMPT_DETAILS, p)) return null;
  if (Object.hasOwn(value, 'completion_tokens_details') && !details(value.completion_tokens_details, COMPLETION_DETAILS, c)) return null;
  return Object.freeze({ promptTokens: p, completionTokens: c });
}

const MESSAGE_KEYS: ReadonlySet<string> = new Set(['role', 'content', 'refusal', 'tool_calls', 'function_call', 'audio', 'annotations']);
/** The exact intent object inside the message content: strict JSON, keys version+intent only, one of the five enums. */
export function intentOf(content: string): AskIntent | null {
  let parsed: unknown;
  try { parsed = parseStrictJson(content, 2); } catch { return null; }
  if (!plain(parsed) || Object.keys(parsed).sort().join() !== 'intent,version' || parsed.version !== 'AskRemoteIntentV1') return null;
  const intent = parsed.intent;
  return typeof intent === 'string' && (ASK_INTENTS as readonly string[]).includes(intent) ? intent as AskIntent : null;
}
function contentIntent(envelope: Json): AskIntent | null {
  if (envelope.object !== 'chat.completion' || !Array.isArray(envelope.choices) || envelope.choices.length !== 1) return null;
  const choice: unknown = envelope.choices[0];
  if (!plain(choice) || choice.index !== 0 || choice.finish_reason !== 'stop' || !absentOrNull(choice, 'logprobs')) return null;
  const message = choice.message;
  if (!plain(message) || !Object.keys(message).every(k => MESSAGE_KEYS.has(k)) || message.role !== 'assistant') return null;
  if (!absentOrNull(message, 'refusal') || !absentOrNull(message, 'function_call') || !absentOrNull(message, 'audio')) return null;
  const tools = message.tool_calls;
  if (!(tools === undefined || tools === null || (Array.isArray(tools) && tools.length === 0))) return null;
  const notes = message.annotations;
  if (!(notes === undefined || (Array.isArray(notes) && notes.length === 0))) return null;
  const content = message.content;
  if (typeof content !== 'string' || content.length === 0 || Buffer.byteLength(content, 'utf8') > INTENT_CONTENT_MAX_BYTES) return null;
  return intentOf(content);
}

export function validateEnvelope(status: number, contentType: unknown, body: Buffer): EnvelopeVerdict {
  if (status !== 200) return { kind: 'UPSTREAM', auth: status === 401 || status === 403 };
  if (!jsonContentType(contentType)) return { kind: 'MALFORMED' };
  let envelope: unknown;
  try { envelope = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), 32); } catch { return { kind: 'MALFORMED' }; }
  if (!plain(envelope)) return { kind: 'MALFORMED' };
  if (envelope.model !== ASK_REMOTE_MODEL || envelope.service_tier !== ASK_REMOTE_TIER) return { kind: 'MODEL_MISMATCH' };
  const usage = usageOf(envelope.usage);
  if (usage === null) return { kind: 'USAGE_INVALID' };
  const intent = contentIntent(envelope);
  return intent === null ? { kind: 'INVALID', usage } : { kind: 'INTENT', intent, usage };
}
