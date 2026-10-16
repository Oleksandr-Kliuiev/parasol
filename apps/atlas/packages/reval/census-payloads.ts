import { exact, isBool, isDec64, isIntIn, isPositiveDec64, isUuid, req, shapeFail } from './scalars.ts';

/**
 * Exact PROCESS_CENSUS (05 "Independent process/ingress census") and DRAIN (02 "Pause is not drain") payloads (rs-d brief A §3/§4).
 * Event counters are monotonic Dec64 per guardEpoch; activeTaskCount/pendingCommitCount are CURRENT gauges 0..4; DRAIN counts are
 * current checked Dec64. A schema-valid payload that breaks a relationship is refused like a shape error (never forwarded).
 */
export const CENSUS_COUNTERS = ['capabilityIngressCount', 'submitIngressCount', 'handoffIngressCount', 'rejectedUnpairedCount', 'unattributedCount',
  'reservationConfirmedCount', 'commitUnknownCount', 'capabilityConsumedCount', 'transportEntryCount', 'publicationCount', 'physicalReleaseCount',
  'uncollectedTerminalCount'] as const;
export type CensusCounter = typeof CENSUS_COUNTERS[number];
export const CENSUS_GAUGES = ['activeTaskCount', 'pendingCommitCount'] as const;
/** ≤4 physical owners plus the one retained handoff-slot record (05 "tasks max4 physical owners plus the one handoff slot"). */
export const MAX_CENSUS_TASKS = 5;
const CENSUS_KEYS = ['censusId', 'guardEpoch', ...CENSUS_COUNTERS, ...CENSUS_GAUGES, 'coverage', 'tasks'];
const TASK_KEYS = ['correlationId', 'reservation', 'capabilityConsumed', 'transportEntered', 'noDispatchProof', 'ownerReleased', 'publication',
  'terminalObservationId', 'terminalRevision'];

export interface CensusTask {
  readonly correlationId: string | null; readonly reservation: 'NONE_CONFIRMED' | 'COMMITTED' | 'COMMIT_UNKNOWN';
  readonly capabilityConsumed: boolean; readonly transportEntered: boolean; readonly noDispatchProof: 'ORIGINAL_PRIVATE_PROOF' | 'UNAVAILABLE';
  readonly ownerReleased: boolean; readonly publication: 'ANSWER' | 'ERROR' | 'NONE';
  readonly terminalObservationId: string | null; readonly terminalRevision: number | null;
}
export type ProcessCensus = { readonly censusId: string; readonly guardEpoch: string; readonly coverage: 'COMPLETE' | 'UNKNOWN'; readonly tasks: readonly CensusTask[] }
  & { readonly [K in CensusCounter | typeof CENSUS_GAUGES[number]]: string };

function decodeTask(v: unknown): CensusTask {
  const o = exact(v, TASK_KEYS);
  if (o.correlationId !== null) req(isUuid, o.correlationId);
  if (!['NONE_CONFIRMED', 'COMMITTED', 'COMMIT_UNKNOWN'].includes(o.reservation as string)) shapeFail();
  req(isBool, o.capabilityConsumed); req(isBool, o.transportEntered); req(isBool, o.ownerReleased);
  if (o.noDispatchProof !== 'ORIGINAL_PRIVATE_PROOF' && o.noDispatchProof !== 'UNAVAILABLE') shapeFail();
  if (!['ANSWER', 'ERROR', 'NONE'].includes(o.publication as string)) shapeFail();
  if ((o.terminalObservationId === null) !== (o.terminalRevision === null)) shapeFail();
  if (o.terminalObservationId !== null) { req(isUuid, o.terminalObservationId); if (!isIntIn(o.terminalRevision, 1, 16)) shapeFail(); }
  // A scoped record exists only with a scoped correlation; nothing is consumed without a committed reservation, no transport
  // without consumption, and the private no-dispatch proof only for a committed, never-consumed capability.
  if (o.correlationId === null && o.terminalObservationId !== null) shapeFail();
  if (o.transportEntered === true && o.capabilityConsumed !== true) shapeFail();
  if (o.capabilityConsumed === true && o.reservation !== 'COMMITTED') shapeFail();
  if (o.noDispatchProof === 'ORIGINAL_PRIVATE_PROOF' && (o.reservation !== 'COMMITTED' || o.capabilityConsumed === true)) shapeFail();
  return o as unknown as CensusTask;
}
export function decodeProcessCensus(v: unknown): ProcessCensus {
  const o = exact(v, CENSUS_KEYS);
  req(isUuid, o.censusId); req(isUuid, o.guardEpoch);
  for (const k of CENSUS_COUNTERS) req(isDec64, o[k]);
  for (const k of CENSUS_GAUGES) { req(isDec64, o[k]); if (BigInt(o[k] as string) > 4n) shapeFail(); }
  if (o.coverage !== 'COMPLETE' && o.coverage !== 'UNKNOWN') shapeFail();
  if (!Array.isArray(o.tasks) || o.tasks.length > MAX_CENSUS_TASKS) shapeFail();
  const tasks = (o.tasks as unknown[]).map(decodeTask);
  if (BigInt(o.pendingCommitCount as string) > BigInt(o.activeTaskCount as string)) shapeFail();
  if (BigInt(o.transportEntryCount as string) > BigInt(o.capabilityConsumedCount as string)) shapeFail();
  // With complete coverage every active physical owner is exactly one unreleased item (a record or an anonymous owner).
  if (o.coverage === 'COMPLETE' && tasks.filter(t => !t.ownerReleased).length !== Number(o.activeTaskCount)) shapeFail();
  return { ...(o as unknown as ProcessCensus), tasks };
}

const DRAIN_COUNTS = ['registeredProcessCount', 'reachableProcessCount', 'pendingTaskCount', 'pendingCommitCount', 'physicalOwnerCount', 'unmappedAttemptCount'] as const;
const DRAIN_KEYS = ['snapshotId', 'policyVersion', 'fenceEpoch', ...DRAIN_COUNTS, 'continuity', 'state'];
export type Drain = { readonly snapshotId: string; readonly policyVersion: string; readonly fenceEpoch: string; readonly continuity: 'INTACT' | 'LOST';
  readonly state: 'QUIESCENT' | 'PENDING' | 'UNKNOWN' } & { readonly [K in typeof DRAIN_COUNTS[number]]: string };
export function decodeDrain(v: unknown): Drain {
  const o = exact(v, DRAIN_KEYS);
  req(isUuid, o.snapshotId); req(isPositiveDec64, o.policyVersion); req(isDec64, o.fenceEpoch);
  for (const k of DRAIN_COUNTS) req(isDec64, o[k]);
  if (o.continuity !== 'INTACT' && o.continuity !== 'LOST') shapeFail();
  if (!['QUIESCENT', 'PENDING', 'UNKNOWN'].includes(o.state as string)) shapeFail();
  if (BigInt(o.reachableProcessCount as string) > BigInt(o.registeredProcessCount as string)) shapeFail();
  // QUIESCENT (02): every registered incarnation reachable, no owner/task/commit, nothing unmapped, launch continuity intact.
  if (o.state === 'QUIESCENT' && (o.continuity !== 'INTACT' || o.registeredProcessCount !== o.reachableProcessCount || o.registeredProcessCount === '0'
    || [o.pendingTaskCount, o.pendingCommitCount, o.physicalOwnerCount, o.unmappedAttemptCount].some(x => x !== '0'))) shapeFail();
  return o as unknown as Drain;
}
