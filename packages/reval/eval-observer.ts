import { randomUUID } from 'node:crypto';
import type { Clock } from './eval-state.ts';
import type { Binding, DetectedFault, Publication, TerminalObservation } from './eval-wire.ts';

/**
 * Safe original-task terminal observations at S (06 "Original-task terminal observation"). Created only after ordinary scoped
 * authentication AND exact registered scope equality (the Binding exists), before provider work. A non-NONE fault and its first
 * real detection time latch forever; every observed state change increments the revision (≤16, more = coverage failure);
 * repeated reads never do. Records survive raw-slot cleanup/revocation; retention: ≤4 active + 1 completed uncollected, until C
 * acknowledges collection of the latest final revision, hard limit 10 min AFTER physical release (then the sticky
 * uncollectedTerminalCount grows and coverage is UNKNOWN). No raw value or reference is ever stored here.
 */
export const RETAIN_AFTER_RELEASE_MS = 600_000;
interface Rec { obs: TerminalObservation; collectedRevision: number; releasedMono: number | null; overflow: boolean }

export class TerminalObserver {
  readonly #clock: Clock;
  readonly #byArm = new Map<string, Rec>();
  uncollectedTerminalCount = 0;
  coverageFailures = 0;
  constructor(clock: Clock) { this.#clock = clock; }

  #sweep(): void {
    const now = this.#clock.mono();
    for (const [armId, r] of this.#byArm) {
      const collectedFinal = r.obs.final && r.collectedRevision === r.obs.revision;
      if (collectedFinal) { this.#byArm.delete(armId); continue; }
      if (r.releasedMono !== null && now - r.releasedMono > RETAIN_AFTER_RELEASE_MS) { this.#byArm.delete(armId); this.uncollectedTerminalCount += 1; }
    }
  }
  /**
   * A new arm needs every earlier record final AND collected (collected finals are removed by the sweep), and no lost
   * coverage: an expired uncollected record or a revision overflow blocks further arming for good (06).
   */
  priorCollected(): boolean {
    this.#sweep();
    return this.#byArm.size === 0 && this.uncollectedTerminalCount === 0 && this.coverageFailures === 0;
  }
  create(binding: Binding): boolean {
    this.#sweep();
    if ([...this.#byArm.values()].filter(r => !r.obs.final).length >= 4 || this.#byArm.has(binding.armId)) return false;
    this.#byArm.set(binding.armId, { collectedRevision: 0, releasedMono: null, overflow: false, obs: {
      contractVersion: 'RevalTerminalObservationV1', observationId: randomUUID(), revision: 1, binding, detectedFault: 'NONE', detectedAt: null,
      reservation: 'NONE_CONFIRMED', settlement: 'NOT_ATTEMPTED', attemptId: null,
      publication: { state: 'NOT_ATTEMPTED', kind: 'NONE', status: null, code: null }, physicalOwnerReleased: false, final: false } });
    return true;
  }
  #change(armId: string, fn: (o: TerminalObservation) => Partial<TerminalObservation> | null): void {
    const r = this.#byArm.get(armId);
    if (!r || r.obs.final) return;
    const patch = fn(r.obs);
    if (patch === null) return;
    const next = { ...r.obs, ...patch };
    if (JSON.stringify(next) === JSON.stringify(r.obs)) return;
    if (r.obs.revision >= 16) { r.overflow = true; this.coverageFailures += 1; return; }
    next.revision = r.obs.revision + 1;
    next.final = next.physicalOwnerReleased && (next.publication.state === 'SERVER_FINISHED' || next.publication.state === 'FAILED');
    r.obs = Object.freeze(next) as TerminalObservation;
  }
  /** Latches the FIRST non-NONE fault with its real detection time; later faults never replace it. */
  fault(armId: string, fault: Exclude<DetectedFault, 'NONE'>): void {
    this.#change(armId, o => o.detectedFault !== 'NONE' ? null : { detectedFault: fault, detectedAt: new Date(this.#clock.wall()).toISOString() });
  }
  reservation(armId: string, state: TerminalObservation['reservation'], attemptId: string | null): void {
    this.#change(armId, o => o.reservation !== 'NONE_CONFIRMED' ? null : { reservation: state, attemptId });
  }
  settlement(armId: string, state: Exclude<TerminalObservation['settlement'], 'NOT_ATTEMPTED'>): void {
    this.#change(armId, o => o.settlement !== 'NOT_ATTEMPTED' ? null : { settlement: state });
  }
  publication(armId: string, p: Publication): void {
    this.#change(armId, o => (o.publication.state === 'SERVER_FINISHED' || o.publication.state === 'FAILED') ? null : { publication: p });
  }
  /** Physical owner release. The record is final once released AND its publication is terminal (a write still in flight at
   *  release finishes or fails later and only then makes the record final). */
  released(armId: string): void {
    const r = this.#byArm.get(armId);
    if (!r || r.releasedMono !== null) return;
    r.releasedMono = this.#clock.mono();
    this.#change(armId, () => ({ physicalOwnerReleased: true }));
  }
  /** A fresh read (never extends retention). null when unknown/expired/overflowed (coverage failure, never a NONE claim). */
  read(armId: string): TerminalObservation | null {
    this.#sweep();
    const r = this.#byArm.get(armId);
    return !r || r.overflow ? null : r.obs;
  }
  /** RS-D-A: the current records (after the sweep) for the guard census — their latest safe observation only. */
  list(): readonly TerminalObservation[] { this.#sweep(); return [...this.#byArm.values()].map(r => r.obs); }
  /** C's OBSERVATION_COLLECTED for exactly that revision (not future ones). */
  collected(armId: string, observationId: string, revision: number): boolean {
    const r = this.#byArm.get(armId);
    if (!r || r.obs.observationId !== observationId || r.obs.revision !== revision) return false;
    r.collectedRevision = revision;
    this.#sweep();
    return true;
  }
}
