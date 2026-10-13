import { EXPECTED_TYPES, expandPage, originalRow } from './fixtures.ts';
import type { FixtureFile, FixtureSpec } from './fixtures.ts';

// Independent expected DATA of every displayable fact, derived only from the frozen raw fixture declaration (the same
// original rows the accepted validators receive) — never from projection/selector/compiler output. The identity of each
// banked fact is chosen by the hand-declared `expected.bank`; this module only states what that fact must display.
// Field lists restate the accepted bank contract (docs/stage5/ask/02_CONTRACTS.md "Server evidence bank"): OBSERVATION =
// the ObservationSummary fields (id → observationId) in contract order; RESOURCE_STATE = source, resourceType,
// connectionId, status, asOf, lastSuccessAt, truncated (never items). Display strings are far below the 4000-point cap.

const OBSERVATION_FIELDS: readonly [string, string][] = [['observationId', 'id'], ['source', 'source'], ['resourceType', 'resourceType'],
  ['connectionId', 'connectionId'], ['externalEventId', 'externalEventId'], ['summary', 'summary'], ['severity', 'severity'], ['priority', 'priority'],
  ['route', 'route'], ['confidence', 'confidence'], ['reasonCodes', 'reasonCodes'], ['status', 'status'], ['entityId', 'entityId'],
  ['conflictOfEventKey', 'conflictOfEventKey'], ['supersededById', 'supersededById'], ['occurredAt', 'occurredAt'], ['createdAt', 'createdAt'],
  ['updatedAt', 'updatedAt'], ['acknowledgedAt', 'acknowledgedAt'], ['resolvedAt', 'resolvedAt']];

export type FactData = Readonly<Record<string, unknown>>;
/** identity (O:/R:) → exact expected data object (key order included); N: entity facts use `expected.entity`. */
export function expectedFactData(spec: FixtureSpec, scope: FixtureFile['scope']): ReadonlyMap<string, FactData> {
  const out = new Map<string, FactData>();
  const rows = [...expandPage(spec), ...(spec.focus.offPage ? [spec.focus.offPage] : [])].map(o => originalRow(o, scope));
  for (const row of rows) out.set(`O:${String(row.id)}`, Object.fromEntries(OBSERVATION_FIELDS.map(([to, from]) => [to, row[from]])));
  for (const c of spec.connections) {
    for (const resourceType of EXPECTED_TYPES[c.system]!) {
      const s = c.states[resourceType] ?? { status: 'MISSING', asOf: null, lastSuccessAt: null, truncated: false };
      out.set(`R:${c.system}/${resourceType}/${c.id}`, { source: c.system, resourceType, connectionId: c.id, status: s.status, asOf: s.asOf,
        lastSuccessAt: s.lastSuccessAt, truncated: s.truncated });
    }
  }
  return out;
}
