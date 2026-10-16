import { askFailure } from '../contracts.ts';
import { validQuestion } from '../input.ts';
import { ASK_REMOTE_MODEL, ASK_REMOTE_TIER } from './contracts.ts';
import { DEVELOPER_TEXT, INTENT_SCHEMA, MAX_COMPLETION_TOKENS, UPSTREAM_REQUEST_MAX_BYTES } from './profile.ts';

/**
 * The immutable upstream request of one question (docs/stage5/ask/remote/03 "Wire profile"), prepared and serialized BEFORE
 * egress admission under the original deadline and never rebuilt afterwards. Input is ONLY a fresh exact
 * {question, hasFocus}: the original question unchanged (untrusted, never sanitized or truncated) and whether the finalized
 * bank holds the requested focus observation. No bank, ID, name, email, scope, actor, correlation or source marker exists
 * here. The serialized payload is ≤16 KiB UTF-8, else ASK_TOO_LARGE (413) before any admission or network work.
 * The bytes live in a module-private WeakMap behind an opaque frozen handle (no property, getter or serialization).
 */
export interface PreparedPayload { readonly kind: 'AskRemotePrepared' }
const prepared = new WeakMap<PreparedPayload, Buffer>();

export function serializePayload(question: string, hasFocus: boolean): Buffer {
  const payload = {
    model: ASK_REMOTE_MODEL,
    messages: [{ role: 'developer', content: DEVELOPER_TEXT }, { role: 'user', content: JSON.stringify({ question, hasFocus }) }],
    reasoning_effort: 'none', service_tier: ASK_REMOTE_TIER, store: false, stream: false, n: 1, max_completion_tokens: MAX_COMPLETION_TOKENS,
    prompt_cache_options: { mode: 'explicit' },
    response_format: { type: 'json_schema', json_schema: { name: 'ask_remote_intent_v1', strict: true, schema: INTENT_SCHEMA } }
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export function preparePayload(input: unknown): PreparedPayload {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return askFailure('ASK_REQUEST_INVALID');
  const keys = Object.keys(input).sort();
  const { question, hasFocus } = input as Record<string, unknown>;
  if (keys.join() !== 'hasFocus,question' || !validQuestion(question) || typeof hasFocus !== 'boolean') return askFailure('ASK_REQUEST_INVALID');
  const bytes = serializePayload(question, hasFocus);
  if (bytes.length > UPSTREAM_REQUEST_MAX_BYTES) return askFailure('ASK_TOO_LARGE');
  const handle: PreparedPayload = Object.freeze({ kind: 'AskRemotePrepared' as const });
  prepared.set(handle, bytes);
  return handle;
}
/** A copy of the prepared bytes for the one dispatch (dispatch.ts); null for any object not issued here. */
export function preparedBytes(handle: PreparedPayload): Buffer | null {
  const bytes = prepared.get(handle);
  return bytes === undefined ? null : Buffer.from(bytes);
}
