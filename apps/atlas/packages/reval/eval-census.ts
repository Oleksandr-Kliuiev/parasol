import { randomUUID } from 'node:crypto';
import type { RemoteSeams } from '../ask/remote/secret.ts';
import type { CensusTask, ProcessCensus } from './census-payloads.ts';
import { decodeProcessCensus, MAX_CENSUS_TASKS } from './census-payloads.ts';
import type { TerminalObserver } from './eval-observer.ts';
import type { EvaluationState } from './eval-state.ts';

/**
 * The measured guard census of ONE bridge server process (05 "Independent process/ingress census"; rs-d brief A §3). Memory-only;
 * the event counters advance at entry, BEFORE work is handed on, and never decrease within this guardEpoch; activeTaskCount and
 * pendingCommitCount are current gauges. It stores no question, body, path, header, bearer, intent or source fact. Sources: the
 * ingress gate (capability/submit entry, publications), the handoff route (entry), the registered task hooks (reservation,
 * missing Binding), the census-wrapped provider transport seam (R-B consumes the capability synchronously right before calling it,
 * so seam entry ⇔ consumption), the process AskBudget (physical owners) and the terminal observer (records, sticky uncollected).
 * Observation only: no counter, gauge or flag grants or refuses anything.
 */
/** More task items than 05 allows: CENSUS_LIMIT_EXCEEDED, never a truncated census. */
export class CensusLimitError extends Error { constructor() { super('CENSUS_LIMIT_EXCEEDED'); this.name = 'CensusLimitError'; } }
export interface PhysicalOwners { readonly active: number; readonly releases: number }
interface Dispatch { consumed: boolean; transport: boolean }
export class GuardCensus {
  readonly guardEpoch: string;
  #capability = 0n; #submit = 0n; #handoff = 0n; #unattributed = 0n; #confirmed = 0n; #commitUnknown = 0n;
  #consumed = 0n; #transport = 0n; #publication = 0n;
  /** A seam entry with no CLAIMED arm, or an owner count that does not reconcile: coverage is UNKNOWN for good (sticky). */
  #lost = 0;
  #owners: PhysicalOwners | null = null;
  #state: EvaluationState | null = null; #observer: TerminalObserver | null = null;
  readonly #dispatch = new Map<string, Dispatch>();
  constructor(guardEpoch: string = randomUUID()) { this.guardEpoch = guardEpoch; }
  /** The runtime's state and observer (set once by EvaluationRuntime). */
  attach(state: EvaluationState, observer: TerminalObserver): void { this.#state = state; this.#observer = observer; }
  /** The process's AskBudget (the same instance the Ask ingress reserves owners from). */
  attachOwners(owners: PhysicalOwners): void { this.#owners = owners; }

  capabilityIngress(): void { this.#capability += 1n; }
  submitIngress(): void { this.#submit += 1n; }
  handoffIngress(): void { this.#handoff += 1n; }
  /** A gate-passed submit that never reaches a registered Binding (05 "Pre-scope events use aggregate unattributed counts"). */
  unattributed(): void { this.#unattributed += 1n; }
  reservation(outcome: 'COMMITTED' | 'COMMIT_UNKNOWN'): void { if (outcome === 'COMMITTED') this.#confirmed += 1n; else this.#commitUnknown += 1n; }
  /** A gate-passed submit whose HTTP response completed its write (`finish`). */
  publication(): void { this.#publication += 1n; }
  /** Provider seams whose transport entry is counted and attributed to the current CLAIMED arm (bridge seams never resolve a key). */
  wrapSeams(seams: RemoteSeams): RemoteSeams {
    const self = this;
    return Object.freeze({
      resolveSecret: (ref: string) => seams.resolveSecret(ref),
      transport(...args: Parameters<RemoteSeams['transport']>) { self.#entered(); return seams.transport(...args); },
    });
  }
  #entered(): void {
    this.#consumed += 1n; this.#transport += 1n;
    const arm = this.#state?.arm;
    if (!arm || arm.state !== 'CLAIMED') { this.#lost += 1; return; }
    this.#dispatch.set(arm.ack.armId, { consumed: true, transport: true });
  }

  /** The exact 05 payload (validated before it is returned; a builder bug can never export an invalid census). */
  snapshot(): ProcessCensus {
    const observer = this.#observer; const owners = this.#owners;
    const records = observer ? observer.list() : [];
    let coverage: 'COMPLETE' | 'UNKNOWN' = observer && owners && this.#state && this.#lost === 0 && observer.coverageFailures === 0
      && observer.uncollectedTerminalCount === 0 ? 'COMPLETE' : 'UNKNOWN';
    const tasks: CensusTask[] = records.map(o => {
      const d = this.#dispatch.get(o.binding.armId) ?? { consumed: false, transport: false };
      const publication = o.publication.state === 'SERVER_FINISHED' ? (o.publication.kind === 'ANSWER' ? 'ANSWER' : 'ERROR') : 'NONE';
      return { correlationId: o.binding.correlationId, reservation: o.reservation, capabilityConsumed: d.consumed, transportEntered: d.transport,
        noDispatchProof: o.reservation === 'COMMITTED' && !d.consumed && o.settlement === 'CONFIRMED' ? 'ORIGINAL_PRIVATE_PROOF' : 'UNAVAILABLE',
        ownerReleased: o.physicalOwnerReleased, publication, terminalObservationId: o.observationId, terminalRevision: o.revision };
    });
    const active = owners?.active ?? 0;
    const anonymous = active - records.filter(o => !o.physicalOwnerReleased).length;
    if (anonymous < 0) coverage = 'UNKNOWN';
    for (let i = 0; i < anonymous; i += 1) {
      tasks.push({ correlationId: null, reservation: 'NONE_CONFIRMED', capabilityConsumed: false, transportEntered: false, noDispatchProof: 'UNAVAILABLE',
        ownerReleased: false, publication: 'NONE', terminalObservationId: null, terminalRevision: null });
    }
    if (tasks.length > MAX_CENSUS_TASKS) throw new CensusLimitError();
    const pending = Math.min(active, records.filter(o => !o.physicalOwnerReleased).length);
    return decodeProcessCensus({ censusId: randomUUID(), guardEpoch: this.guardEpoch,
      capabilityIngressCount: String(this.#capability), submitIngressCount: String(this.#submit), handoffIngressCount: String(this.#handoff),
      rejectedUnpairedCount: String(this.#state?.counters.rejectedUnpairedCount ?? 0), unattributedCount: String(this.#unattributed),
      reservationConfirmedCount: String(this.#confirmed), commitUnknownCount: String(this.#commitUnknown), capabilityConsumedCount: String(this.#consumed),
      transportEntryCount: String(this.#transport), publicationCount: String(this.#publication), physicalReleaseCount: String(owners?.releases ?? 0),
      uncollectedTerminalCount: String(observer?.uncollectedTerminalCount ?? 0), activeTaskCount: String(active), pendingCommitCount: String(pending),
      coverage, tasks });
  }
}
