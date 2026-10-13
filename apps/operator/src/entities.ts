// Entity display rule (S5-B brief, Field allowlists; AGENTS.md: confirmed links stay separate from candidates). DOM-free.
// An observation's entity is shown as confirmed only when its exact ID matches exactly one current person or device of the
// validated context AND a CONFIRMED context link of that kind exists for it. Names and hostnames never establish identity;
// a missing graph row never establishes absence. A device's person is its stored reference, resolved by exact ID only.
import type { ContextView, DeviceView, LinkView, PersonView } from './contracts.ts';

export type PersonReference = { readonly kind: 'NONE' } | { readonly kind: 'RESOLVED'; readonly person: PersonView } | { readonly kind: 'UNAVAILABLE' };
export type EntityResolution =
  /** The observation carries no entity: unresolved. */
  | { readonly kind: 'UNRESOLVED' }
  /** An entity ID that this context cannot confirm (no row, several rows, or no confirmed link): reference unavailable. */
  | { readonly kind: 'UNAVAILABLE'; readonly entityId: string }
  | { readonly kind: 'PERSON'; readonly person: PersonView; readonly links: readonly LinkView[] }
  | { readonly kind: 'DEVICE'; readonly device: DeviceView; readonly person: PersonReference; readonly links: readonly LinkView[] };

export function personReference(context: ContextView, personId: string | null): PersonReference {
  if (personId === null) return { kind: 'NONE' };
  const people = context.people.filter(p => p.id === personId);
  return people.length === 1 ? { kind: 'RESOLVED', person: people[0]! } : { kind: 'UNAVAILABLE' };
}

export function resolveEntity(context: ContextView, entityId: string | null): EntityResolution {
  if (entityId === null) return { kind: 'UNRESOLVED' };
  const people = context.people.filter(p => p.id === entityId);
  const devices = context.devices.filter(d => d.id === entityId);
  if (people.length + devices.length !== 1) return { kind: 'UNAVAILABLE', entityId };
  const kind = people.length === 1 ? 'PERSON' : 'DEVICE';
  const links = context.links.filter(l => l.entityId === entityId && l.entityKind === kind);
  if (links.length === 0) return { kind: 'UNAVAILABLE', entityId };
  if (kind === 'PERSON') return { kind, person: people[0]!, links };
  return { kind, device: devices[0]!, person: personReference(context, devices[0]!.personId), links };
}
