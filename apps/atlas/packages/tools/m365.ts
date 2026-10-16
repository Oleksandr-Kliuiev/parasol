import type { ClientContextV1, Scope } from '../core/contracts.ts';
import { AtlasError, M365_READ } from '../core/contracts.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import type { CorrelationContextV1, CorrelationCoverage, CorrelationResource } from '../correlation/contracts.ts';
import { CORRELATION_CONTRACT_VERSION, CORRELATION_RULE_VERSION, CORRELATION_SOURCE_SCOPE } from '../correlation/contracts.ts';
import { requireCursorKey } from '../correlation/cursor.ts';
import type { CursorKeyProvider } from '../correlation/cursor.ts';
import { CURSOR_PATTERN, cursorInvalid, parseCorrelationInput, parseSignInListInput, READ_LIMIT_DEFAULT, READ_LIMIT_MAX, UTC_INPUT_PATTERN } from '../correlation/parameters.ts';
import type { IntervalInput } from '../correlation/parameters.ts';
import { assertInterval } from '../correlation/read.ts';
import { keyOfDate } from '../correlation/time.ts';
import type { SignInListV1 } from '../m365/read-contracts.ts';
import { SIGNIN_LIST_CONTRACT_VERSION } from '../m365/read-contracts.ts';
import type { ParameterSchema, Parameters } from './parameters.ts';
import type { M365ToolReaders, ToolDefinition, ToolReaders } from './registry.ts';

/**
 * The two Stage 2 read tools (02 §5): risk 0, side effect NONE, all-of ['context:read', 'm365:read'] on one membership.
 * Parameters are exactly connectionId/from/to plus optional limit/cursor (and observationId for the correlation); the
 * client, workspace and actor never come from parameters. Results are verified to belong to the requested scope. Their
 * outputs never enter the Decisions/provider input path.
 */
export const M365_TOOL_PERMISSIONS = Object.freeze(['context:read', M365_READ] as const);
const id = (description: string): ParameterSchema[string] => ({ type: 'string', pattern: SCOPE_ID_PATTERN, required: true, description });
const window: ParameterSchema = {
  connectionId: id('Atlas Microsoft 365 connection ID'),
  from: { type: 'string', pattern: UTC_INPUT_PATTERN, required: true, description: 'Inclusive UTC start (Z, 0-7 fractional digits), at most 7 days old' },
  to: { type: 'string', pattern: UTC_INPUT_PATTERN, required: true, description: 'Exclusive UTC end, not in the future, at most 24h after from' },
  limit: { type: 'integer', min: 1, max: READ_LIMIT_MAX, description: `Page size (default ${READ_LIMIT_DEFAULT})` },
  cursor: { type: 'string', pattern: CURSOR_PATTERN, description: 'nextCursor of the previous page, with the same parameters (at most 512 characters)' },
};
function readersOf(readers: ToolReaders): M365ToolReaders {
  if (!readers.m365) throw new AtlasError('M365_READS_UNAVAILABLE', 'PERMANENT');
  return readers.m365;
}
function inScope<T extends { workspaceId: string; clientId: string }>(result: T, scope: Scope): T {
  if (result.workspaceId !== scope.workspaceId || result.clientId !== scope.clientId) throw new AtlasError('CONTEXT_SCOPE_MISMATCH', 'PERMANENT');
  return result;
}

export const m365Tools: readonly ToolDefinition[] = Object.freeze([
  { name: 'atlas.observation.get_correlation', version: '1', risk: 0, sideEffect: 'NONE', permissions: M365_TOOL_PERMISSIONS,
    description: 'Microsoft 365 sign-in evidence deterministically related to one Huntress observation (CorrelationContextV1): evidence with provenance, coverage and gaps; no verdict',
    parameters: { observationId: id('Atlas observation ID of a Huntress observation'), ...window },
    run: async (readers: ToolReaders, parameters: Parameters, scope: Scope) => inScope(await readersOf(readers).correlation(parameters), scope) },
  { name: 'microsoft365.signin.list', version: '1', risk: 0, sideEffect: 'NONE', permissions: M365_TOOL_PERMISSIONS,
    description: 'Published Microsoft 365 sign-ins of the client in one interval with resource and coverage status; no correlation claim',
    parameters: window,
    run: async (readers: ToolReaders, parameters: Parameters, scope: Scope) => inScope(await readersOf(readers).signIns(parameters), scope) },
].map(t => Object.freeze(t as ToolDefinition)));

/** The one synthetic M365 connection of the fixture API; it has no data and never acquires a token. */
export const FIXTURE_M365_CONNECTION = 'demo-m365-fixture';
const FIXTURE_CODE = 'M365_FIXTURE_NOT_AVAILABLE';
const fixtureResource = (resourceType: CorrelationResource['resourceType']): CorrelationResource =>
  ({ resourceType, status: 'FIXTURE', lastSuccessAt: null, asOf: null, safeErrorCode: FIXTURE_CODE, coverage: 'UNAVAILABLE' });
function fixtureCoverage(input: IntervalInput, now: Date): CorrelationCoverage {
  return { status: 'UNAVAILABLE', traversalComplete: false, completedWindows: [], gaps: [{ fromInclusive: input.from, toExclusive: input.to, reasonCode: FIXTURE_CODE }],
    sourceScope: CORRELATION_SOURCE_SCOPE, assessedAt: now.toISOString(), freshness: 'UNKNOWN' };
}

/**
 * Fixture-mode M365 readers: honest UNAVAILABLE envelopes for the one synthetic fixture connection — never complete-empty
 * data, never a cursor. The same strict parser, interval bounds (against the process clock: the fixture has no database)
 * and an explicitly injected cursor configuration (fails closed when none is given) as DB mode.
 */
export function fixtureM365Readers(readContext: () => Promise<ClientContextV1>, cursorKey: CursorKeyProvider | undefined,
  clock: () => Date = () => new Date()): M365ToolReaders {
  const prepare = <T extends IntervalInput & { connectionId: string; cursor: string | null }>(input: T) => {
    requireCursorKey(cursorKey);
    if (input.cursor !== null) throw cursorInvalid();
    const now = clock();
    assertInterval(input, { now, key: keyOfDate(now) });
    if (input.connectionId !== FIXTURE_M365_CONNECTION) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
    return now;
  };
  return {
    async correlation(parameters): Promise<CorrelationContextV1> {
      const input = parseCorrelationInput(parameters);
      const now = prepare(input);
      const ctx = await readContext();
      const observation = ctx.observations.items.find(o => o.id === input.observationId);
      if (!observation) throw new AtlasError('OBSERVATION_NOT_FOUND', 'VALIDATION');
      if (observation.source !== 'huntress') throw new AtlasError('CORRELATION_SOURCE_UNSUPPORTED', 'VALIDATION');
      return { contractVersion: CORRELATION_CONTRACT_VERSION, mode: 'fixture', workspaceId: ctx.workspaceId, clientId: ctx.clientId, observationId: observation.id,
        m365ConnectionId: FIXTURE_M365_CONNECTION, ruleVersion: CORRELATION_RULE_VERSION,
        source: { eventKey: observation.eventKey, severity: observation.severity, priority: observation.priority, route: observation.route },
        window: { fromInclusive: input.from, toExclusive: input.to },
        resources: [fixtureResource('m365_device'), fixtureResource('m365_user'), fixtureResource('m365_signin')],
        resolution: { device: 'UNRESOLVED', person: 'UNRESOLVED', reasonCodes: ['DIRECTORY_MISSING'] },
        items: null, coverage: fixtureCoverage(input, now), total: 0, truncated: false, nextCursor: null };
    },
    async signIns(parameters): Promise<SignInListV1> {
      const input = parseSignInListInput(parameters);
      const now = prepare(input);
      const ctx = await readContext();
      return { contractVersion: SIGNIN_LIST_CONTRACT_VERSION, mode: 'fixture', workspaceId: ctx.workspaceId, clientId: ctx.clientId,
        m365ConnectionId: FIXTURE_M365_CONNECTION, window: { fromInclusive: input.from, toExclusive: input.to }, resources: [fixtureResource('m365_signin')],
        coverage: fixtureCoverage(input, now), items: null, total: 0, truncated: false, nextCursor: null };
    },
  };
}
