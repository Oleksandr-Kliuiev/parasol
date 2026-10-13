// GET /clients/:id/overview → ClientContextV1 (packages/core/contracts.ts, packages/graph/context-mapper.ts). DOM-free.
// The whole context is validated before anything is committed: identity, every nested graph row's scope, confirmed-only
// links, enums, times, array caps, its observation page and the reviewed resource item shapes. The result is an explicit
// projection limited to displayed Atera/Huntress content; Person.email and financial/M365 content are never retained.
import { COMPLETENESS, CONTEXT_MODES, CONTEXT_RESOURCE_TYPES, CONTEXT_SYSTEMS, DISPLAYED_SYSTEMS, ENTITY_KINDS, LIMITS, SCOPE_ID_PATTERN } from './contracts.ts';
import type { ContextSystem, ContextView, DeviceView, LinkView, PersonView } from './contracts.ts';
import { array, fail, identifier, matching, nullableIdentifier, nullableString, object, oneOf, string, time } from './validate-core.ts';
import { inScope, validateContextPage } from './validate-observations.ts';
import type { Scope } from './validate-observations.ts';
import { validateResource } from './validate-resources.ts';

/** Person: email keeps its accepted validation (nullable text) but is never copied. */
function person(raw: unknown, scope: Scope): PersonView {
  const row = object(raw); inScope(row, scope);
  const view = { id: identifier(row.id), displayName: string(row.displayName) };
  nullableString(row.email);
  return Object.freeze(view);
}
/** Device: personId is a stored reference only; no person is ever inferred from a name or hostname. */
function device(raw: unknown, scope: Scope): DeviceView {
  const row = object(raw); inScope(row, scope);
  return Object.freeze({ id: identifier(row.id), hostname: string(row.hostname), personId: nullableIdentifier(row.personId) });
}
/** Only CONFIRMED links are part of the context; a candidate, rejected or quarantined link is a contract violation. */
function link(raw: unknown, scope: Scope): LinkView {
  const row = object(raw); inScope(row, scope);
  const view = { connectionId: matching(row.connectionId, SCOPE_ID_PATTERN), system: oneOf(row.system, CONTEXT_SYSTEMS),
    resourceType: oneOf(row.resourceType, CONTEXT_RESOURCE_TYPES), externalId: identifier(row.externalId), entityId: identifier(row.entityId),
    entityKind: oneOf(row.entityKind, ENTITY_KINDS) };
  if (row.status !== 'CONFIRMED') fail();
  return Object.freeze(view);
}
const displayed = (system: ContextSystem) => DISPLAYED_SYSTEMS.includes(system);

/**
 * Validates a ClientContextV1 for the requested client. `workspaceId` is the workspace an earlier context established for
 * this credential epoch (null for the first one); a context of another workspace or client is RESPONSE_INVALID.
 */
export function validateContext(value: unknown, requestedClientId: string, workspaceId: string | null): ContextView {
  const ctx = object(value);
  if (ctx.contractVersion !== 'ClientContextV1') fail();
  const scope = { workspaceId: matching(ctx.workspaceId, SCOPE_ID_PATTERN), clientId: matching(ctx.clientId, SCOPE_ID_PATTERN) };
  if (scope.clientId !== requestedClientId || (workspaceId !== null && scope.workspaceId !== workspaceId)) fail();
  const mode = oneOf(ctx.mode, CONTEXT_MODES);
  const clientName = string(ctx.clientName);
  const generatedAt = time(ctx.generatedAt);
  const completeness = oneOf(ctx.completeness, COMPLETENESS);
  if ((completeness === 'COMPLETE_FIXTURE') !== (mode === 'fixture')) fail();
  const people = array(ctx.people, LIMITS.people).map(row => person(row, scope));
  const devices = array(ctx.devices, LIMITS.devices).map(row => device(row, scope));
  const links = array(ctx.links, LIMITS.links).map(row => link(row, scope));
  validateContextPage(ctx.observations, scope, mode);
  const resources = array(ctx.resources, LIMITS.resources).map(row => validateResource(row, mode, scope));
  return Object.freeze({
    workspaceId: scope.workspaceId, clientId: scope.clientId, clientName, mode, completeness, generatedAt,
    people: Object.freeze(people), devices: Object.freeze(devices), links: Object.freeze(links.filter(l => displayed(l.system))),
    resources: Object.freeze(resources.filter(r => displayed(r.source as ContextSystem)))
  });
}
