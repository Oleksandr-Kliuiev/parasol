import { createHash } from 'node:crypto';
import type { NormalizedEvent } from '../core/contracts.ts';

/**
 * Event identity (docs/03), shared by the in-memory reference pipeline and the durable inbox (task 1.6).
 * Versioned: changing the rule means a new version, never a silent change of existing keys.
 */
export const EVENT_KEY_VERSION = 'v2';
export function eventKey(event: NormalizedEvent): string {
  return createHash('sha256').update(JSON.stringify([EVENT_KEY_VERSION, event.workspaceId, event.clientId, event.source,
    event.connectionId, event.resourceType, event.externalEventId, event.revision])).digest('hex');
}
/**
 * Identity of a conflicting redelivery: same source ID and revision as `canonicalKey`, different content. Deterministic, so
 * the same conflicting content delivered twice is still one event, while the canonical evidence is never overwritten.
 */
export function conflictEventKey(canonicalKey: string, payloadHash: string): string {
  return createHash('sha256').update(JSON.stringify([`${EVENT_KEY_VERSION}-conflict`, canonicalKey, payloadHash])).digest('hex');
}
/** Hash of the normalized content, independent of receivedAt. */
export function payloadHash(event: NormalizedEvent): string {
  const { receivedAt: _ignored, ...content } = event;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}
/** Deterministic JSON: object keys sorted recursively, so two equal payloads always hash equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
