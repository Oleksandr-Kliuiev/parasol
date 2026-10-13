import type { FailureCode } from './codes.ts';
import { decodeDrain, decodeProcessCensus } from './census-payloads.ts';
import type { Drain, ProcessCensus } from './census-payloads.ts';
import { CENSUS_COUNTERS } from './census-payloads.ts';
import { fromServer } from './eval-controller.ts';
import type { InstrumentResult } from './eval-instrument-link.ts';
import type { Snapshot } from './payloads.ts';
import type { ServerLink } from './server-link.ts';

/**
 * Controller side of the RS-D-A census (06 rows PROCESS_CENSUS / DRAIN; 02 "Pause is not drain"; rs-d brief A §4). PROCESS_CENSUS is
 * S's payload forwarded as SERVER after an exact schema check; C remembers the FIRST guardEpoch of its one S incarnation and any other
 * epoch later is IDENTITY_UNVERIFIED and makes every later DRAIN continuity LOST (sticky). DRAIN is C's own composition inside ONE
 * operation: census₁ → the confined reader's atomic SNAPSHOT → census₂; S's gauges are reported as S's, the DB facts as C's. No wait,
 * no poll, no lock across the transport; a failed read is a fixed FAILURE, never a state. RS-D-B (carried RS-D-A F2, 02 "incomplete
 * process inventory is UNKNOWN, never zero"): QUIESCENT also needs C's independent process inventory — S sandboxed under the pinned profile
 * (inherited by any descendant) and still the verified incarnation, and every backend of the registered DB S's or C's own — else UNKNOWN.
 */
const S_HOP_MS = 600;
const fail = (code: FailureCode): InstrumentResult => ({ kind: 'FAILURE', payload: { code }, emitter: 'CONTROLLER' });
export interface DrainHooks {
  server(): ServerLink | null;
  now(): number;
  /** One bound SNAPSHOT of the confined reader (C's existing snapshot operation), by `until`. */
  snapshot(until: number): Promise<{ result: InstrumentResult; snapshot: Snapshot | null }>;
  /** RS-D-B: C's independent process inventory (S enforced + DB backends attributable), by `until`; a failed read is INCOMPLETE. */
  inventory(until: number): Promise<'COMPLETE' | 'INCOMPLETE'>;
}

export class CensusLink {
  readonly #h: DrainHooks;
  #epoch: string | null = null;
  #lost = false;
  constructor(hooks: DrainHooks) { this.#h = hooks; }
  get continuity(): 'INTACT' | 'LOST' { return this.#lost ? 'LOST' : 'INTACT'; }

  /** C→S PROCESS_CENSUS with the epoch rule; the forwarded result keeps S as its emitter. */
  async census(until: number): Promise<InstrumentResult> {
    const server = this.#h.server();
    const r = fromServer(server ? await server.evaluationRequest('PROCESS_CENSUS', {}, Math.max(1, Math.min(S_HOP_MS, until - this.#h.now()))) : null,
      'PROCESS_CENSUS', decodeProcessCensus);
    if (r.kind !== 'PROCESS_CENSUS') return r;
    const epoch = (r.payload as ProcessCensus).guardEpoch;
    if (this.#epoch === null) this.#epoch = epoch;
    else if (epoch !== this.#epoch) { this.#lost = true; return fail('IDENTITY_UNVERIFIED'); }
    return r;
  }

  /** DRAIN: census₁ → SNAPSHOT → census₂ within `until`, composed by `composeDrain`. */
  async drain(until: number): Promise<InstrumentResult> {
    const first = await this.census(until - 900);
    const snap = await this.#h.snapshot(until - 400);
    if (!snap.snapshot) return snap.result.kind === 'FAILURE' ? snap.result : fail('CENSUS_UNAVAILABLE');
    const second = await this.census(until - 250);
    const inventory = await this.#h.inventory(until - 20).catch(() => 'INCOMPLETE' as const);
    const c1 = first.kind === 'PROCESS_CENSUS' ? first.payload as ProcessCensus : null;
    const c2 = second.kind === 'PROCESS_CENSUS' ? second.payload as ProcessCensus : null;
    return { kind: 'DRAIN', payload: composeDrain(c1, snap.snapshot, c2, this.continuity, inventory), emitter: 'CONTROLLER' };
  }
}

/** The exact DRAIN of two censuses (null = not reachable/invalid) around one atomic snapshot and C's process inventory (pure; validated). */
export function composeDrain(c1: ProcessCensus | null, s: Snapshot, c2: ProcessCensus | null, continuity: 'INTACT' | 'LOST',
  inventory: 'COMPLETE' | 'INCOMPLETE'): Drain {
  const reachable = c1 !== null && c2 !== null;
  const lost = continuity === 'LOST' || (reachable && c1.guardEpoch !== c2.guardEpoch);
  const tasks = new Set((c2?.tasks ?? []).map(t => t.correlationId).filter((x): x is string => x !== null));
  const unmapped = s.attempts.filter(a => a.state === 'EGRESS_COMMITTED' && !tasks.has(a.correlationId)).length;
  const owners = c2?.activeTaskCount ?? '0'; const commits = c2?.pendingCommitCount ?? '0';
  const unknown = !reachable || lost || inventory !== 'COMPLETE' || c1.coverage !== 'COMPLETE' || c2.coverage !== 'COMPLETE' || !s.consistent
    || s.foreignScopeAttemptCount !== '0';
  const moved = reachable && CENSUS_COUNTERS.some(k => c1[k] !== c2[k]);
  const state = unknown ? 'UNKNOWN' : moved || owners !== '0' || commits !== '0' || unmapped !== 0 ? 'PENDING' : 'QUIESCENT';
  return decodeDrain({ snapshotId: s.snapshotId, policyVersion: s.policyVersion, fenceEpoch: s.fenceEpoch, registeredProcessCount: '1',
    reachableProcessCount: reachable ? '1' : '0', pendingTaskCount: owners, pendingCommitCount: commits, physicalOwnerCount: owners,
    unmappedAttemptCount: String(unmapped), continuity: lost ? 'LOST' : 'INTACT', state });
}
