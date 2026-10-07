import type { Scope, NormalizedEvent, ExternalLink } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
/**
 * Resolve the canonical DEVICE an event refers to. Only a CONFIRMED link whose external resource type matches the event's
 * device reference and whose canonical entity is a DEVICE counts. A contact or person link with the same external ID never
 * resolves. Two confirmed links to different entities are a CONFLICT: the caller stores the event for visible review.
 */
export function resolveDevice(event: NormalizedEvent, links: ExternalLink[]): string | null {
  const ref = event.externalDevice;
  if (!ref) return null;
  const hits = links.filter(l => l.workspaceId === event.workspaceId && l.clientId === event.clientId &&
    l.connectionId === event.connectionId && l.system === event.source && l.resourceType === ref.resourceType &&
    l.externalId === ref.externalId && l.entityKind === 'DEVICE' && l.status === 'CONFIRMED');
  const ids = new Set(hits.map(l => l.entityId));
  if (ids.size > 1) throw new AtlasError('AMBIGUOUS_DEVICE_LINK', 'CONFLICT');
  return ids.size === 1 ? [...ids][0]! : null;
}
export function sameScope(a: Scope, b: Scope): boolean { return a.workspaceId === b.workspaceId && a.clientId === b.clientId; }
