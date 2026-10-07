import type { ClientContextV1, ObservationPage, ObservationStatus, ResourceType, ResourceView, Scope, Severity, System } from '../core/contracts.ts';
import { AtlasError, activeObservationStatuses, emptyCounts, observationStatuses, severities } from '../core/contracts.ts';
import type { ObservationQuery } from '../observations/query.ts';
import { EXTERNAL_ID_PATTERN } from '../graph/mapping.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { describeParameters } from './parameters.ts';
import type { ParameterSchema, Parameters } from './parameters.ts';

/**
 * Read tool registry (task 1.9). Each entry is authoritative data — name, version, risk, side effect, permission and the
 * runtime schema of its parameters — plus its read. A caller or a model supplies only the tool name and parameters; risk,
 * side effect and permission never come from them. Stage 1 registers read tools only (ADR-003).
 */
export interface ToolReaders {
  /** The client context, read inside the caller's scope (fixture context or the database through withScope). */
  context(): Promise<ClientContextV1>;
  observations(query: ObservationQuery): Promise<ObservationPage>;
}
export interface ToolDefinition {
  name: string; version: string; risk: 0 | 1 | 2 | 3 | 4; sideEffect: 'NONE' | 'CREATE' | 'UPDATE' | 'SECURITY' | 'DESTRUCTIVE';
  permission: string; description: string; parameters: ParameterSchema;
  run(readers: ToolReaders, parameters: Parameters, scope: Scope): Promise<unknown>;
}
/** Registry name syntax: lowercase dotted segments. Anything else is denied as INVALID_TOOL_NAME, never looked up. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31}){1,3}$/;
export const TOOL_OBSERVATION_DEFAULT_LIMIT = 25;

/** The context, after its contract and scope are verified: a mismatch is never returned to the caller. */
async function scopedContext(readers: ToolReaders, scope: Scope): Promise<ClientContextV1> {
  const ctx = await readers.context();
  if (ctx.contractVersion !== 'ClientContextV1') throw new AtlasError('CONTEXT_CONTRACT_MISMATCH', 'PERMANENT');
  if (ctx.workspaceId !== scope.workspaceId || ctx.clientId !== scope.clientId) throw new AtlasError('CONTEXT_SCOPE_MISMATCH', 'PERMANENT');
  return ctx;
}
/**
 * The view of one source resource of the client; a source without a view is MISSING (RESOURCE_NOT_CONFIGURED), never an
 * empty list. Several connections of the source (a second tenant, or a fixture connection next to a live one) make the
 * tool name ambiguous: without `connectionId` that is AMBIGUOUS_CONNECTION (CONFLICT) instead of whichever row comes
 * first; a `connectionId` that is not a connection of this source for the client is CONNECTION_NOT_FOUND.
 */
function selectResource(ctx: ClientContextV1, source: System, resourceType: ResourceType, connectionId?: string): ResourceView {
  const views = ctx.resources.filter(r => r.source === source && r.resourceType === resourceType);
  if (connectionId !== undefined) {
    const view = views.find(r => r.connectionId === connectionId);
    if (!view) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
    return view;
  }
  if (views.length > 1) throw new AtlasError('AMBIGUOUS_CONNECTION', 'CONFLICT');
  return views[0] ?? { source, resourceType, connectionId: null, status: 'MISSING', asOf: null, lastSuccessAt: null, safeErrorCode: 'RESOURCE_NOT_CONFIGURED',
    items: null, truncated: false };
}
const viewOf = async (readers: ToolReaders, parameters: Parameters, scope: Scope, source: System, resourceType: ResourceType) =>
  selectResource(await scopedContext(readers, scope), source, resourceType, parameters.connectionId as string | undefined);
const list = (source: System, resourceType: ResourceType) =>
  (readers: ToolReaders, parameters: Parameters, scope: Scope): Promise<ResourceView> => viewOf(readers, parameters, scope, source, resourceType);
/**
 * One source object from the resource's last complete read: the same ResourceView with its items narrowed to that ID.
 * OK or STALE with an empty list means "not in the stored read" — and with `truncated` the read was bounded, so the object
 * may exist beyond it; ERROR and MISSING keep items null. Fixture items carry `id`, snapshot items `externalId`.
 */
const one = (source: System, resourceType: ResourceType, parameter: string) =>
  async (readers: ToolReaders, parameters: Parameters, scope: Scope): Promise<ResourceView> => {
    const view = await viewOf(readers, parameters, scope, source, resourceType);
    const idOf = (item: unknown) => { const o = item as { externalId?: unknown; id?: unknown }; return o.externalId ?? o.id; };
    return { ...view, items: view.items === null ? null : view.items.filter(item => idOf(item) === parameters[parameter]) };
  };
const sourceId = (description: string): ParameterSchema[string] => ({ type: 'string', pattern: EXTERNAL_ID_PATTERN, required: true, description });
const connection = (system: string): ParameterSchema[string] => ({ type: 'string', pattern: SCOPE_ID_PATTERN,
  description: `Atlas connection ID; required when the client has more than one ${system} connection` });

export const stage1Tools: readonly ToolDefinition[] = Object.freeze(([
  { name: 'atlas.client.get_context', description: 'Bounded client context: graph, active observations by priority, resource views with status',
    parameters: {}, run: async (readers, _parameters, scope) => scopedContext(readers, scope) },
  { name: 'atlas.observation.list', description: 'Observations by priority with status and severity filters and a keyset cursor',
    parameters: {
      status: { type: 'list', values: observationStatuses, maxItems: 4, description: 'Statuses to include (default OPEN, ACKNOWLEDGED)' },
      severity: { type: 'list', values: severities, maxItems: 5, description: 'Severities to include (default all)' },
      limit: { type: 'integer', min: 1, max: 100, description: `Page size (default ${TOOL_OBSERVATION_DEFAULT_LIMIT})` },
      cursor: { type: 'string', pattern: /^[A-Za-z0-9_-]{1,400}$/, description: 'nextCursor of the previous page, with the same filters' } },
    run: async (readers, parameters, scope) => {
      const page = await readers.observations({ statuses: (parameters.status as ObservationStatus[] | undefined) ?? [...activeObservationStatuses],
        severities: (parameters.severity as Severity[] | undefined) ?? [...severities], limit: (parameters.limit as number | undefined) ?? TOOL_OBSERVATION_DEFAULT_LIMIT,
        cursor: (parameters.cursor as string | undefined) ?? null });
      if (page.items.some(o => o.workspaceId !== scope.workspaceId || o.clientId !== scope.clientId)) throw new AtlasError('CONTEXT_SCOPE_MISMATCH', 'PERMANENT');
      return page;
    } },
  { name: 'atera.alert.list', description: 'Atera alerts of the client as a resource view', parameters: { connectionId: connection('Atera') }, run: list('atera', 'alert') },
  { name: 'atera.ticket.list', description: 'Open Atera tickets of the client as a resource view', parameters: { connectionId: connection('Atera') },
    run: list('atera', 'ticket') },
  { name: 'atera.ticket.get', description: 'One Atera ticket by its source ID from the last complete read',
    parameters: { ticketId: sourceId('Atera ticket ID'), connectionId: connection('Atera') }, run: one('atera', 'ticket', 'ticketId') },
  { name: 'huntress.incident.list', description: 'Open Huntress incidents of the client as a resource view', parameters: { connectionId: connection('Huntress') },
    run: list('huntress', 'incident') },
  { name: 'huntress.incident.get', description: 'One Huntress incident by its source ID from the last complete read',
    parameters: { incidentId: sourceId('Huntress incident report ID'), connectionId: connection('Huntress') }, run: one('huntress', 'incident', 'incidentId') },
] satisfies Omit<ToolDefinition, 'version' | 'risk' | 'sideEffect' | 'permission'>[])
  .map(t => Object.freeze({ ...t, version: '1', risk: 0, sideEffect: 'NONE', permission: 'context:read' } as ToolDefinition)));

/** What GET /tools shows: authoritative metadata and parameter schemas, nothing executable. */
export function describeTool(tool: ToolDefinition) {
  return { name: tool.name, version: tool.version, risk: tool.risk, sideEffect: tool.sideEffect, permission: tool.permission,
    description: tool.description, parameters: describeParameters(tool.parameters) };
}

/**
 * Readers over one already built context (fixture mode and tests). Observations are selected from its page in memory
 * with the same filters and order; a fixture context is small, so it issues no cursor and accepts none.
 */
export function contextReaders(readContext: () => Promise<ClientContextV1>): ToolReaders {
  return {
    context: readContext,
    observations: async query => {
      if (query.cursor !== null) throw new AtlasError('INVALID_CURSOR', 'VALIDATION');
      const selected = (await readContext()).observations.items.filter(o => query.statuses.includes(o.status) && query.severities.includes(o.severity));
      const counts = emptyCounts();
      for (const o of selected) counts[o.severity] += 1;
      return { items: selected.slice(0, query.limit), counts, total: selected.length, truncated: selected.length > query.limit, nextCursor: null };
    },
  };
}
