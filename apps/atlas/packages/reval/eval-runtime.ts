import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { FailureCode } from './codes.ts';
import { loadFrozenDataset, SYNTHETIC_FRESHNESS_AT } from './dataset.ts';
import type { FrozenDataset } from './dataset.ts';
import { loadCaseFixtures } from './eval-cases.ts';
import type { ProcessCensus } from './census-payloads.ts';
import { CensusLimitError, GuardCensus } from './eval-census.ts';
import { currentFacts, evaluationPhases } from './eval-db.ts';
import type { RegisteredScope } from './eval-db.ts';
import { EvaluationGate } from './eval-gate.ts';
import type { EvaluationFocus } from './eval-handoff-dto.ts';
import { TerminalObserver } from './eval-observer.ts';
import { EvaluationState, sameSecret } from './eval-state.ts';
import type { Clock } from './eval-state.ts';
import { ACK_V1, COMMIT_V1, decodeAck, READY_ACK_V1, TRANSFER_V1 } from './eval-transient.ts';
import type { Ack, Ready, WireResponse } from './eval-transient.ts';
import type { ArmAck, Binding, PairAck, PairSecret, TerminalObservation } from './eval-wire.ts';

/**
 * The bridge server's evaluation hub (rs-c/IMPLEMENTATION_BRIEF.md §1–§3): one EvaluationState + TerminalObserver + ingress
 * gate per registered server process; C→S restricted operations (PAIR install, END_PAIR, ARM_CASE, TERMINAL_OBSERVATION,
 * OBSERVATION_COLLECTED); the measured handoff connections' READY and the RESPONSE transfer (TRANSFER → ACK → COMMIT, one 2 s
 * end-to-end deadline from the browser POST, never renewed or resent).
 */
/**
 * RS-C-C (carried RS-C-A residual): the ACK wait ended because its deadline timer fired. A timer can fire up to ~2 ms before a
 * monotonic clock reaches its target, so an expiry is classified by WHICH event ended the wait, never by re-reading the clock.
 */
export const ACK_WAIT_EXPIRED: unique symbol = Symbol('ACK_WAIT_EXPIRED');
export interface HandoffLink {
  readonly connectionId: string; readonly controlConnectionId: string;
  /** Sends a frame built with this connection's NEXT S send sequence; returns that sequence (throws when closed). */
  send(build: (sequence: string) => Record<string, unknown>): string;
  /** The next ACK frame from I (decoded by the caller), ACK_WAIT_EXPIRED when the deadline timer fired, or null on close. */
  nextAck(deadlineMono: number): Promise<unknown | typeof ACK_WAIT_EXPIRED | null>;
  close(): void;
}
export interface RuntimeOptions {
  readonly reg: RegisteredScope; readonly serverBootId: string; readonly port: number; readonly db: PrismaClient; readonly clock: Clock;
  readonly dataset?: FrozenDataset;
  /** The frozen 200 case → fixture map (04: the seen sets are bounded by these IDs). */
  readonly cases?: ReadonlyMap<string, string>;
  /** RS-D-A: the process guard census (created before the Ask module so the provider seams can be wrapped); its epoch is the guardEpoch. */
  readonly census?: GuardCensus;
}
/** Structural equality of parsed JSON values: object key ORDER is irrelevant, every key and value must match exactly. */
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export class EvaluationRuntime {
  readonly reg: RegisteredScope; readonly serverBootId: string; readonly guardEpoch: string;
  readonly state: EvaluationState; readonly observer: TerminalObserver; readonly gate: EvaluationGate; readonly census: GuardCensus;
  readonly #db: PrismaClient; readonly #clock: Clock; readonly #dataset: FrozenDataset; readonly #cases: ReadonlyMap<string, string>;
  readonly #links = new Map<string, HandoffLink>();
  constructor(o: RuntimeOptions) {
    this.reg = o.reg; this.serverBootId = o.serverBootId; this.#db = o.db; this.#clock = o.clock;
    this.#dataset = o.dataset ?? loadFrozenDataset();
    this.#cases = o.cases ?? loadCaseFixtures();
    this.state = new EvaluationState({ registrationId: o.reg.registrationId, serverBootId: o.serverBootId, workspaceId: o.reg.workspaceId,
      clientId: o.reg.clientId, actorId: o.reg.actorId }, o.clock);
    this.observer = new TerminalObserver(o.clock);
    this.census = o.census ?? new GuardCensus(); this.guardEpoch = this.census.guardEpoch;
    this.census.attach(this.state, this.observer);
    this.gate = new EvaluationGate({ reg: o.reg, serverBootId: o.serverBootId, guardEpoch: this.guardEpoch, port: o.port, state: this.state,
      observer: this.observer, census: this.census, requestedFocus: id => this.#dataset.byId.get(id as never)?.requestedFocus ?? null, phases: g => evaluationPhases(o.reg, g) });
  }
  get clock(): Clock { return this.#clock; }

  // ---- measured handoff connections ------------------------------------------------------------------------------------
  connected(link: HandoffLink): void { this.#links.set(link.connectionId, link); }
  lost(link: HandoffLink): void {
    this.#links.delete(link.connectionId);
    const p = this.state.pair;
    if (p && p.state !== 'ENDED' && p.handoffConnectionId === link.connectionId) this.state.revoke('IPC_LOST');
  }
  /** I's READY for the current arm: every echoed field must equal the arm; never renews the window. */
  ready(link: HandoffLink, r: Ready): { disposition: 'READY' | 'FAILED'; failureCode: FailureCode | null } {
    const arm = this.state.arm; const pair = this.state.pair;
    const fail = (failureCode: FailureCode) => ({ disposition: 'FAILED' as const, failureCode });
    if (r.registrationId !== this.reg.registrationId || r.serverBootId !== this.serverBootId || r.connectionId !== link.connectionId) return fail('WRONG_BINDING');
    if (!arm || !pair || r.pairId !== pair.pairId || r.armId !== arm.ack.armId || r.caseId !== arm.ack.caseId || r.fixtureId !== arm.ack.fixtureId
      || r.fixtureGeneration !== arm.ack.fixtureGeneration || r.admissionId !== arm.ack.admissionId || r.policyVersion !== arm.ack.policyVersion
      || r.preSnapshotId !== arm.ack.preSnapshotId) return fail('WRONG_BINDING');
    const code = this.state.ready(link.connectionId, r.armId, r.sequence, r.challenge);
    return code === null ? { disposition: 'READY', failureCode: null } : fail(code);
  }
  readyAckFrame(link: HandoffLink, r: Ready, d: { disposition: 'READY' | 'FAILED'; failureCode: FailureCode | null }) {
    return (sequence: string) => ({ contractVersion: READY_ACK_V1, registrationId: this.reg.registrationId, serverBootId: this.serverBootId,
      connectionId: link.connectionId, sequence, challenge: r.challenge, readySequence: r.sequence, armId: r.armId, ...d });
  }

  // ---- C→S restricted operations -------------------------------------------------------------------------------------
  installPair(secret: PairSecret): PairAck | FailureCode {
    if (secret.registrationId !== this.reg.registrationId || secret.serverBootId !== this.serverBootId) return 'WRONG_BINDING';
    const link = this.#links.get(secret.instrumentHandoffConnectionId);
    if (!link || link.controlConnectionId !== secret.instrumentControlConnectionId) return 'PAIR_UNAVAILABLE';
    return this.state.install(secret.pairId, secret.instrumentControlConnectionId, secret.instrumentHandoffConnectionId, secret.pairingNonce,
      Date.parse(secret.expiresAt));
  }
  endPair(pairId: string): PairAck | FailureCode { return this.state.endPair(pairId); }
  /**
   * C's forwarded ARM_CASE (04 row S): only a frozen case ID is admitted (the seen set stays bounded by the 200 IDs); the case is
   * marked seen BEFORE the DB read and every later check (rc2 F2), so a failed read or check never leaves it armable again.
   */
  async armCase(p: { caseId: string; fixtureId: string; fixtureGeneration: string; admissionId: string; policyVersion: string; preSnapshotId: string;
    browserPairId: string }): Promise<ArmAck | FailureCode> {
    const mapped = this.#cases.get(p.caseId);
    if (mapped === undefined) return 'FIXTURE_MISMATCH';
    const seen = this.state.seeCase(p.caseId);
    if (seen) return seen;
    if (mapped !== p.fixtureId) return 'FIXTURE_MISMATCH';
    let facts;
    try { facts = await currentFacts(this.#db, this.reg, 1500); } catch { return 'ARM_UNAVAILABLE'; }
    return this.state.armCase(p, { fixtureId: facts.fixtureId, fixtureGeneration: facts.fixtureGeneration,
      admissionId: facts.policyAdmissionId === this.reg.admissionId ? this.reg.admissionId : 'MISMATCH', policyVersion: facts.policyVersion ?? '0',
      policyActive: facts.policyState === 'ACTIVE', admissionExpiresMs: facts.policyExpiresMs ?? 0, priorCollected: this.observer.priorCollected() });
  }
  terminal(armId: string): TerminalObservation | FailureCode { return this.observer.read(armId) ?? 'OBSERVATION_UNAVAILABLE'; }
  /** RS-D-A C→S PROCESS_CENSUS: the exact guard census, or a fixed code (more items than 05 allows is never truncated). */
  processCensus(): ProcessCensus | FailureCode {
    try { return this.census.snapshot(); } catch (e) { return e instanceof CensusLimitError ? 'CENSUS_LIMIT_EXCEEDED' : 'CENSUS_UNAVAILABLE'; }
  }
  collected(armId: string, observationId: string, revision: number): boolean { return this.observer.collected(armId, observationId, revision); }

  // ---- browser handoff ----------------------------------------------------------------------------------------------
  /** PAIR200 focus from the DB binding + frozen fixture bytes (the instrument link must still be connected), bounded by `ms`. */
  async focus(ms: number): Promise<{ focus: EvaluationFocus; admissionExpiresMs: number; admissionId: string; policyVersion: string } | FailureCode> {
    const pair = this.state.pair;
    if (!pair || pair.state !== 'RESERVED' || !this.#links.has(pair.handoffConnectionId)) return 'PAIR_UNAVAILABLE';
    let facts;
    try { facts = await currentFacts(this.#db, this.reg, ms); } catch { return 'INTERNAL_FAILURE'; }
    const spec = this.#dataset.byId.get(facts.fixtureId as never);
    if (!spec || facts.syntheticFreshnessAt !== SYNTHETIC_FRESHNESS_AT || facts.policyExpiresMs === null || facts.policyAdmissionId !== this.reg.admissionId
      || facts.policyVersion === null) return 'FIXTURE_MISMATCH';
    return { admissionExpiresMs: facts.policyExpiresMs, admissionId: facts.policyAdmissionId, policyVersion: facts.policyVersion,
      focus: Object.freeze({ registrationId: this.reg.registrationId, fixtureId: facts.fixtureId, fixtureGeneration: facts.fixtureGeneration,
        requestedFocus: spec.requestedFocus, focusState: spec.focus.state, syntheticFreshnessAt: SYNTHETIC_FRESHNESS_AT }) };
  }
  /**
   * RESPONSE recheck (04 "repeats the bounded current … policy/fixture checks"; rc2 F6): the policy is ACTIVE with the pair's
   * bound admission and version and the fixture generation is unchanged; otherwise the PAIR is revoked (not just the slot).
   */
  async handoffCurrent(ms: number): Promise<FailureCode | null> {
    const pair = this.state.pair;
    if (!pair || pair.state !== 'PAIRED' || !pair.bound) return 'PAIR_REVOKED';
    let facts;
    try { facts = await currentFacts(this.#db, this.reg, ms); } catch { return 'INTERNAL_FAILURE'; }
    const b = pair.bound;
    const code: FailureCode | null = facts.policyState !== 'ACTIVE' ? 'ADMISSION_NOT_ACTIVE'
      : facts.policyAdmissionId !== b.admissionId || facts.policyVersion !== b.policyVersion ? 'POLICY_CHANGED'
        : facts.fixtureGeneration !== b.fixtureGeneration ? 'FIXTURE_MISMATCH' : null;
    if (code) this.state.revoke(code);
    return code;
  }
  /**
   * RESPONSE after authentication and the bounded rechecks (06 "Exact transient transfer"): deadline first, then claim the receipt
   * nonce once (AVAILABLE → CLAIMED), compare the browser values structurally with the slot (request AND publication), deadline
   * again, TRANSFER echoing the slot's OWN arm READY (rc2 F3), then accept a matching ACK only while the pair, the slot (not
   * expired/burned, still TRANSFER_SENT) and the same 2 s deadline hold (rc2 F4); otherwise COMMIT FAILED or no COMMIT at all.
   */
  async respond(pairId: string, receiptNonce: string, request: unknown, response: WireResponse, deadlineMono: number): Promise<FailureCode | null> {
    if (this.#clock.mono() >= deadlineMono) return 'DEADLINE';
    const pair = this.state.pair; const slot = this.state.slot;
    if (!pair || pair.state !== 'PAIRED' || pair.pairId !== pairId) return 'PAIR_REVOKED';
    if (!slot || slot.state !== 'AVAILABLE' || !sameSecret(slot.receiptNonce, receiptNonce) || !slot.binding) return 'RAW_EXPIRED';
    slot.state = 'CLAIMED';
    const binding: Binding = slot.binding;
    const burn = (code: FailureCode): FailureCode => { this.state.burnSlot(); return code; };
    if (!same(request, slot.request) || !slot.publication || response.status !== slot.publication.status
      || response.correlationId !== slot.publication.correlationId || !same(response.body, slot.publication.body)) return burn('CONTENT_MISMATCH');
    if (this.#clock.mono() >= deadlineMono) return burn('DEADLINE');
    const link = this.#links.get(pair.handoffConnectionId);
    if (!link || link.connectionId !== binding.handoffConnectionId) return burn('IPC_LOST');
    const transferId = randomUUID(); const ackChallenge = randomUUID();
    let transferSequence: string;
    try {
      transferSequence = link.send(sequence => ({ contractVersion: TRANSFER_V1, connectionId: link.connectionId, sequence, challenge: slot.ready.challenge,
        readySequence: slot.ready.sequence, transferId, ackChallenge, binding, bindingResult: 'SERVER_VALUES_MATCHED',
        publicationAuthority: response.status === 200 ? 'CONFIRMED' : 'NOT_APPLICABLE', handoffAuthority: 'CONFIRMED', request: slot.request, response }));
    } catch { return burn('IPC_LOST'); }
    slot.state = 'TRANSFER_SENT';
    const raw = await link.nextAck(deadlineMono);
    if (raw === ACK_WAIT_EXPIRED) return burn('DEADLINE');
    let ack: Ack | null = null;
    try { ack = raw === null ? null : decodeAck(raw); } catch { ack = null; }
    if (raw === null) return burn(this.#clock.mono() >= deadlineMono ? 'DEADLINE' : 'IPC_LOST');
    const valid = ack !== null && ack.contractVersion === ACK_V1 && ack.connectionId === link.connectionId && ack.challenge === ackChallenge
      && ack.transferSequence === transferSequence && ack.transferId === transferId && same(ack.binding, binding);
    if (!valid || !ack) return burn('ACK_INVALID');
    const accepted: Ack = ack;
    const commit = (disposition: 'COMMITTED' | 'FAILED', failureCode: FailureCode | null) => {
      try { link.send(sequence => ({ contractVersion: COMMIT_V1, connectionId: link.connectionId, sequence, challenge: accepted.commitChallenge,
        ackSequence: accepted.sequence, transferId, binding, disposition, failureCode })); } catch { /* lost: the instrument stays UNVERIFIED */ }
    };
    const pairNow = this.state.pair; const slotNow = this.state.slot; // the getters apply real expiry first
    const failure: FailureCode | null = !pairNow || pairNow.pairId !== pairId || pairNow.state !== 'PAIRED' ? 'PAIR_REVOKED'
      : slotNow !== slot || slot.state !== 'TRANSFER_SENT' ? 'RAW_EXPIRED' : this.#clock.mono() >= deadlineMono ? 'ACK_TIMEOUT' : null;
    if (failure) { commit('FAILED', failure); return burn(failure === 'ACK_TIMEOUT' ? 'DEADLINE' : failure); }
    if (accepted.disposition !== 'ACCEPTED') { commit('FAILED', 'ACK_INVALID'); return burn(accepted.failureCode ?? 'VALUE_VALIDATION_FAILED'); }
    slot.state = 'ACK_VALIDATED';
    commit('COMMITTED', null);
    slot.state = 'COMMITTED'; slot.request = null; slot.publication = null; slot.receiptNonce = null;
    return null;
  }
}
