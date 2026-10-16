// AskAnswerV1 evidence bank and coverage (docs/stage5/ask/02_CONTRACTS.md "Server evidence bank"). DOM-free.
// Every fact is checked for its EXACT key set, closed enums, times, nullability, unshortened identities and display caps,
// then copied field by field into a fresh frozen projection. Anything else throws Invalid for the WHOLE answer: there is no
// partial bank, no repaired value and no unknown field carried along.
import { CONTEXT_RESOURCE_TYPES, ENTITY_KINDS, OBSERVATION_STATUSES, PRIORITIES, RESOURCE_STATUSES, ROUTES, SCOPE_ID_PATTERN, SEVERITIES } from './contracts.ts';
import type { ContextMode, ObservationStatus } from './contracts.ts';
import { ASK_LIMITS, ASK_SOURCES, ENTITY_STATES } from './ask-contracts.ts';
import type { AskConfirmation, AskCoverage, AskEntityData, AskFact, AskObservationData, AskResourceData } from './ask-contracts.ts';
import {
  array, boolean, count, fail, identifier, matching, nullableIdentifier, nullableOneOf, nullableTime, object, oneOf, string, time, tooLarge, unitInterval
} from './validate-core.ts';
import type { Json } from './validate-core.ts';

/** The object has exactly these own keys: none missing, none additional (`__proto__` included). */
export function exactKeys(value: unknown, keys: readonly string[]): Json {
  const row = object(value);
  const own = Object.keys(row);
  if (own.length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) fail();
  return row;
}
/** Display string within the 4000 code-point cap (the server already shortened it with its marker); longer is too large. */
function display(value: unknown): string {
  const text = string(value);
  let points = 0;
  for (const _ of text) if (++points > ASK_LIMITS.displayCodePoints) tooLarge();
  return text;
}
const nullableDisplay = (value: unknown): string | null => value === null ? null : display(value);
const scopeId = (value: unknown): string => matching(value, SCOPE_ID_PATTERN);
const ACTIVE: readonly ObservationStatus[] = ['OPEN', 'ACKNOWLEDGED'];

const OBSERVATION_KEYS = ['observationId', 'source', 'resourceType', 'connectionId', 'externalEventId', 'summary', 'severity', 'priority', 'route',
  'confidence', 'reasonCodes', 'status', 'entityId', 'conflictOfEventKey', 'supersededById', 'occurredAt', 'createdAt', 'updatedAt', 'acknowledgedAt', 'resolvedAt'];
function observationData(raw: unknown): AskObservationData {
  const row = exactKeys(raw, OBSERVATION_KEYS);
  const reasonCodes = array(row.reasonCodes, ASK_LIMITS.reasonCodes).map(display);
  return Object.freeze({
    observationId: identifier(row.observationId), source: oneOf(row.source, ASK_SOURCES), resourceType: oneOf(row.resourceType, CONTEXT_RESOURCE_TYPES),
    connectionId: scopeId(row.connectionId), externalEventId: identifier(row.externalEventId), summary: display(row.summary),
    severity: oneOf(row.severity, SEVERITIES), priority: oneOf(row.priority, PRIORITIES), route: oneOf(row.route, ROUTES),
    confidence: unitInterval(row.confidence), reasonCodes: Object.freeze(reasonCodes), status: oneOf(row.status, OBSERVATION_STATUSES),
    entityId: nullableIdentifier(row.entityId), conflictOfEventKey: nullableIdentifier(row.conflictOfEventKey),
    supersededById: nullableIdentifier(row.supersededById), occurredAt: time(row.occurredAt), createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt), acknowledgedAt: nullableTime(row.acknowledgedAt), resolvedAt: nullableTime(row.resolvedAt)
  });
}

const RESOURCE_KEYS = ['source', 'resourceType', 'connectionId', 'status', 'asOf', 'lastSuccessAt', 'truncated'];
/** Accepted ResourceView semantics with an explicit connection and no items; FIXTURE status belongs to fixture mode only. */
function resourceData(raw: unknown, mode: ContextMode): AskResourceData {
  const row = exactKeys(raw, RESOURCE_KEYS);
  const status = oneOf(row.status, RESOURCE_STATUSES);
  if ((status === 'FIXTURE') !== (mode === 'fixture')) fail();
  return Object.freeze({ source: oneOf(row.source, ASK_SOURCES), resourceType: oneOf(row.resourceType, CONTEXT_RESOURCE_TYPES),
    connectionId: scopeId(row.connectionId), status, asOf: nullableTime(row.asOf), lastSuccessAt: nullableTime(row.lastSuccessAt),
    truncated: boolean(row.truncated) });
}

const ENTITY_KEYS = ['observationId', 'entityId', 'state', 'entityKind', 'displayName', 'confirmation'];
const CONFIRMATION_KEYS = ['source', 'resourceType', 'connectionId', 'externalId'];
/**
 * CONFIRMED: exact graph ID, kind, label and one confirmed Atera/Huntress link `{source,resourceType,connectionId,externalId}`
 * of that entity (any such link; it need not match the focus observation's source tuple). UNRESOLVED/UNAVAILABLE: no kind,
 * label or confirmation; UNAVAILABLE keeps the stored ID it could not confirm.
 */
function entityData(raw: unknown): AskEntityData {
  const row = exactKeys(raw, ENTITY_KEYS);
  const state = oneOf(row.state, ENTITY_STATES);
  const entityId = nullableIdentifier(row.entityId);
  const entityKind = nullableOneOf(row.entityKind, ENTITY_KINDS);
  const displayName = nullableDisplay(row.displayName);
  let confirmation: AskConfirmation | null = null;
  if (row.confirmation !== null) {
    const link = exactKeys(row.confirmation, CONFIRMATION_KEYS);
    confirmation = Object.freeze({ source: oneOf(link.source, ASK_SOURCES), resourceType: oneOf(link.resourceType, CONTEXT_RESOURCE_TYPES),
      connectionId: scopeId(link.connectionId), externalId: identifier(link.externalId) });
  }
  if (state === 'CONFIRMED') {
    if (entityId === null || entityKind === null || displayName === null || confirmation === null) fail();
  } else if (entityKind !== null || displayName !== null || confirmation !== null || (state === 'UNAVAILABLE' && entityId === null)) fail();
  return Object.freeze({ observationId: identifier(row.observationId), entityId, state, entityKind, displayName, confirmation });
}

const FACT_KEYS = ['ref', 'kind', 'data'];
/**
 * The whole bank: at most 32 facts with refs E1..En consecutive in array order, all observations first (≤24), then resource
 * states (≤7), then at most one entity. Observation IDs and resource tuples are unique; observations other than the focus
 * fact are active-page rows (OPEN/ACKNOWLEDGED). The focus binding is checked by validate-ask.ts.
 */
export function validateBank(value: unknown, mode: ContextMode): readonly AskFact[] {
  const rows = array(value, ASK_LIMITS.bankLimit);
  const facts: AskFact[] = [];
  const order = { OBSERVATION: 0, RESOURCE_STATE: 1, ENTITY: 2 } as const;
  let phase = 0;
  rows.forEach((raw, index) => {
    const row = exactKeys(raw, FACT_KEYS);
    if (row.ref !== `E${index + 1}`) fail();
    const kind = oneOf(row.kind, ['OBSERVATION', 'RESOURCE_STATE', 'ENTITY'] as const);
    if (order[kind] < phase) fail();
    phase = order[kind];
    const ref = row.ref as string;
    if (kind === 'OBSERVATION') facts.push(Object.freeze({ ref, kind, data: observationData(row.data) }));
    else if (kind === 'RESOURCE_STATE') facts.push(Object.freeze({ ref, kind, data: resourceData(row.data, mode) }));
    else facts.push(Object.freeze({ ref, kind, data: entityData(row.data) }));
  });
  const observations = facts.filter(f => f.kind === 'OBSERVATION');
  const resources = facts.filter(f => f.kind === 'RESOURCE_STATE');
  if (observations.length > ASK_LIMITS.bankObservations || resources.length > ASK_LIMITS.bankResources
    || facts.length - observations.length - resources.length > 1) fail();
  if (new Set(observations.map(f => f.data.observationId)).size !== observations.length) fail();
  if (new Set(resources.map(f => JSON.stringify([f.data.source, f.data.resourceType, f.data.connectionId]))).size !== resources.length) fail();
  return Object.freeze(facts);
}

/**
 * Every observation fact is an active-page row (OPEN/ACKNOWLEDGED) except `extraFocusRef`: the focus fact of an answer whose
 * coverage says focusExtra (read in addition to the page, any accepted lifecycle). Pass null when there is no extra focus.
 */
export function activeExceptFocus(facts: readonly AskFact[], extraFocusRef: string | null): void {
  for (const fact of facts) if (fact.kind === 'OBSERVATION' && fact.ref !== extraFocusRef && !ACTIVE.includes(fact.data.status)) fail();
}

const COVERAGE_KEYS = ['observationLimit', 'bankLimit', 'observationsRead', 'observationPageTruncated', 'focusExtra', 'observationFactsOmitted',
  'urgentFactsOmitted', 'resourcesRead', 'resourceFactsOmitted', 'fixture'];
/** Exact coverage keys, fixed limits and bounded counters; the bank-consistency rules are checked by validate-ask.ts. */
export function validateCoverage(value: unknown, mode: ContextMode): AskCoverage {
  const row = exactKeys(value, COVERAGE_KEYS);
  if (row.observationLimit !== ASK_LIMITS.observationLimit || row.bankLimit !== ASK_LIMITS.bankLimit) fail();
  const observationsRead = count(row.observationsRead);
  const resourcesRead = count(row.resourcesRead);
  if (observationsRead > ASK_LIMITS.observationLimit || resourcesRead > ASK_LIMITS.resourcesRead) fail();
  const coverage: AskCoverage = Object.freeze({ observationLimit: 100, bankLimit: 32, observationsRead,
    observationPageTruncated: boolean(row.observationPageTruncated), focusExtra: boolean(row.focusExtra),
    observationFactsOmitted: boolean(row.observationFactsOmitted), urgentFactsOmitted: boolean(row.urgentFactsOmitted), resourcesRead,
    resourceFactsOmitted: boolean(row.resourceFactsOmitted), fixture: boolean(row.fixture) });
  // A fixture read is the fixed demo page: never truncated and never with an extra focus row. A truncated page is a full one.
  if (coverage.fixture !== (mode === 'fixture') || (coverage.fixture && (coverage.observationPageTruncated || coverage.focusExtra))) fail();
  if (coverage.observationPageTruncated && observationsRead !== ASK_LIMITS.observationLimit) fail();
  return coverage;
}
