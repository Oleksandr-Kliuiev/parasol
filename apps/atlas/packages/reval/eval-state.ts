import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FailureCode } from './codes.ts';
import { newToken } from './eval-wire.ts';
import type { ArmAck, Binding, PairAck } from './eval-wire.ts';

/**
 * The measured server's private evaluation state (04 "Pairing and arm", "First-current-GO bookkeeping", "Registration lifetime
 * and exact Ask ingress pipeline", "The server must bind the actual values", "Memory, bounds and time"; rs-c brief §3). Process-
 * local; decisions use the injected monotonic/wall clock, and REAL timers (`schedule`) drive expiry so raw values drop at their
 * bound without any later access (rc2, review F5). One pair per server, bound at browser PAIR to its credential, admission,
 * policy version and fixture generation (rc2 F6); at most one active arm and never while a publication slot is live (rc2 F3);
 * the seen-case set is marked by `seeCase` BEFORE any fallible check and never resets in this process (rc2 F2). A slot holds ONE
 * claimed task's raw values only while BOUND/AVAILABLE/in transfer, ≤120 s from ingress. Secret comparisons are constant-time.
 */
export interface Clock { mono(): number; wall(): number; schedule?(ms: number, fn: () => void): void }
export const PAIR_NONCE_MS = 120_000;
export const PAIR_MAX_MS = 600_000;
export const SLOT_MS = 120_000;
/** 30 s shared arm/PRE/GO window minus C's 2 s PRE-age bound and the 2 s C→S hop (brief §3). */
export const ARM_WINDOW_MS = 26_000;
const iso = (ms: number) => new Date(ms).toISOString();
const nextUtcDay = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
/** Constant-time equality of two secret Token strings (rc2 F12). */
export function sameSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
const realSchedule = (ms: number, fn: () => void) => { setTimeout(fn, Math.max(0, ms) + 1).unref(); };

export interface PairBinding {
  readonly credential: string; readonly admissionId: string; readonly policyVersion: string; readonly fixtureGeneration: string;
  readonly admissionExpiresMs: number; readonly credentialExpiresMs: number | null;
}
export interface PairRecord {
  readonly pairId: string; readonly controlConnectionId: string; readonly handoffConnectionId: string; readonly nonce: string;
  readonly nonceUntilMono: number; readonly nonceExpiresAt: string;
  state: 'RESERVED' | 'PAIRED' | 'ENDED';
  sessionToken: string | null; pairedUntilMono: number; pairedExpiresAt: string | null; bound: PairBinding | null;
}
export type ArmState = 'ARMED' | 'READY' | 'CLAIMED' | 'EXPIRED' | 'REVOKED' | 'DONE';
export interface ArmRecord {
  readonly ack: ArmAck; readonly pairId: string; readonly untilMono: number; state: ArmState;
  readySequence: string | null; readyChallenge: string | null; taskId: string | null;
}
export type SlotState = 'BOUND' | 'AVAILABLE' | 'CLAIMED' | 'TRANSFER_SENT' | 'ACK_VALIDATED' | 'COMMITTED' | 'BURNED';
export interface SlotRecord {
  readonly armId: string; readonly taskId: string; readonly untilMono: number;
  /** The claimed arm's own READY (rc2 F3): TRANSFER echoes THIS, never a later arm's. */
  readonly ready: { readonly sequence: string; readonly challenge: string };
  binding: Binding | null; request: unknown;
  publication: { status: number; correlationId: string; body: unknown } | null; receiptNonce: string | null; state: SlotState;
}
export interface Registered { readonly registrationId: string; readonly serverBootId: string; readonly workspaceId: string; readonly clientId: string; readonly actorId: string }
export interface CurrentFacts {
  readonly fixtureId: string; readonly fixtureGeneration: string; readonly admissionId: string; readonly policyVersion: string; readonly policyActive: boolean;
  readonly admissionExpiresMs: number; readonly priorCollected: boolean;
}

export class EvaluationState {
  readonly #clock: Clock; readonly #schedule: (ms: number, fn: () => void) => void;
  readonly reg: Registered;
  #pair: PairRecord | null = null;
  #arm: ArmRecord | null = null;
  readonly #seen = new Set<string>();
  #slot: SlotRecord | null = null;
  /** 04 aggregate counters (sticky): unpaired/invalid-header rejections, claims, foreign-scope denials, integrity stop. */
  readonly counters = { ingress: 0, rejectedUnpairedCount: 0, claimed: 0, scopeDenied: 0, duplicateSubmit: 0 };
  integrityStopped = false;
  constructor(reg: Registered, clock: Clock) {
    this.reg = reg; this.#clock = clock; this.#schedule = clock.schedule ?? realSchedule;
  }

  get pair(): PairRecord | null { this.#expire(); return this.#pair; }
  get arm(): ArmRecord | null { this.#expire(); return this.#arm; }
  get slot(): SlotRecord | null { this.#expire(); return this.#slot; }
  /** Diagnostics without any expiry side effect: does the slot still reference a raw value or receipt? */
  rawRetained(): boolean { const s = this.#slot; return !!s && (s.request !== null || s.publication !== null || s.receiptNonce !== null); }
  /** Time-based expiry; never renews. Also run by the real timers. A lapsed pair revokes its arm and burns its slot. */
  #expire(): void {
    const now = this.#clock.mono();
    const p = this.#pair;
    if (p && p.state === 'RESERVED' && now >= p.nonceUntilMono) this.revoke('PAIR_EXPIRED');
    else if (p && p.state === 'PAIRED' && now >= p.pairedUntilMono) this.revoke('PAIR_EXPIRED');
    const a = this.#arm;
    if (a && (a.state === 'ARMED' || a.state === 'READY') && now >= a.untilMono) a.state = 'EXPIRED';
    const s = this.#slot;
    if (s && s.state !== 'COMMITTED' && s.state !== 'BURNED' && now >= s.untilMono) this.burnSlot();
  }
  #at(untilMono: number): void { this.#schedule(untilMono - this.#clock.mono(), () => this.#expire()); }
  /** Ends the pair (END_PAIR, authority/policy/fixture/credential change detected at use, instrument loss, restart path). */
  revoke(_reason: FailureCode): void {
    if (this.#pair) { this.#pair.state = 'ENDED'; this.#pair.sessionToken = null; }
    if (this.#arm && (this.#arm.state === 'ARMED' || this.#arm.state === 'READY')) this.#arm.state = 'REVOKED';
    this.burnSlot();
  }
  /** Drops every raw reference of a non-committed slot (a committed slot already dropped them). */
  burnSlot(): void { const s = this.#slot; if (s && s.state !== 'COMMITTED') { s.state = 'BURNED'; s.request = null; s.publication = null; s.receiptNonce = null; } }

  /** C's restricted PAIR install (RevalPairSecretV1). One pair per server: an occupied (RESERVED/PAIRED) pair refuses. */
  install(pairId: string, controlConnectionId: string, handoffConnectionId: string, nonce: string, expiresAtMs: number): PairAck | FailureCode {
    const live = this.pair;
    if (live && live.state !== 'ENDED') return 'PAIR_UNAVAILABLE';
    const now = this.#clock.mono(); const wall = this.#clock.wall();
    const left = expiresAtMs - wall;
    if (left <= 0 || left > PAIR_NONCE_MS) return 'PAIR_EXPIRED';
    this.#pair = { pairId, controlConnectionId, handoffConnectionId, nonce, nonceUntilMono: now + left, nonceExpiresAt: iso(expiresAtMs), state: 'RESERVED',
      sessionToken: null, pairedUntilMono: 0, pairedExpiresAt: null, bound: null };
    this.#at(now + left);
    return { pairId, expiresAt: iso(expiresAtMs), paired: false };
  }
  /** Browser PAIR: one use of the nonce; pair ≤10 min, never after the admission or the pairing credential's expiry. */
  browserPair(nonce: string, bound: PairBinding): { pairId: string; sessionToken: string; expiresAt: string } | FailureCode {
    const p = this.pair;
    if (!p || p.state !== 'RESERVED' || !sameSecret(p.nonce, nonce)) return 'PAIR_UNAVAILABLE';
    const wall = this.#clock.wall();
    const until = Math.min(wall + PAIR_MAX_MS, bound.admissionExpiresMs, bound.credentialExpiresMs ?? Number.POSITIVE_INFINITY);
    if (until <= wall) return 'PAIR_EXPIRED';
    p.state = 'PAIRED'; p.sessionToken = newToken(); p.pairedUntilMono = this.#clock.mono() + (until - wall); p.pairedExpiresAt = iso(until);
    p.bound = Object.freeze({ ...bound });
    this.#at(p.pairedUntilMono);
    return { pairId: p.pairId, sessionToken: p.sessionToken, expiresAt: p.pairedExpiresAt };
  }
  endPair(pairId: string): PairAck | FailureCode {
    const p = this.#pair;
    if (!p || p.pairId !== pairId) return 'PAIR_UNAVAILABLE';
    const expiresAt = p.pairedExpiresAt ?? p.nonceExpiresAt;
    this.revoke('PAIR_REVOKED');
    return { pairId, expiresAt, paired: false };
  }
  /** The pair's own credential (rc2 F6): a different bearer, even of the same actor, is a credential change. */
  pairCredential(hash: string): boolean { const p = this.pair; return !!p && p.state === 'PAIRED' && !!p.bound && sameSecret(p.bound.credential, hash); }

  /** 04 row S: mark the forwarded case seen/current BEFORE any fallible check (DB read included). A repeat never arms again. */
  seeCase(caseId: string): FailureCode | null {
    if (this.#seen.has(caseId)) return 'CASE_CONSUMED';
    this.#seen.add(caseId);
    return null;
  }
  /**
   * C's forwarded ARM_CASE for a case already marked by `seeCase`. `current` = the DB-read facts at this instant. A change of the
   * pair's bound admission/policy version/fixture generation or a non-ACTIVE policy revokes the pair (04 "revoked on pause/
   * fixture generation/…/policy change"). No arm while another is active or a publication slot is still live (rc2 F3).
   */
  armCase(p: Omit<ArmAck, 'armId' | 'expiresAt'> & { browserPairId: string }, current: CurrentFacts): ArmAck | FailureCode {
    if (!this.#seen.has(p.caseId)) return 'PROTOCOL_INVALID';
    const pair = this.pair;
    if (!pair || pair.state !== 'PAIRED' || !pair.bound || pair.pairId !== p.browserPairId) return 'PAIR_UNAVAILABLE';
    const a = this.arm;
    if (a && (a.state === 'ARMED' || a.state === 'READY' || a.state === 'CLAIMED')) return 'ARM_UNAVAILABLE';
    const s = this.slot;
    if (s && s.state !== 'COMMITTED' && s.state !== 'BURNED') return 'ARM_UNAVAILABLE';
    if (!current.priorCollected) return 'OBSERVATION_GAP';
    const b = pair.bound;
    if (!current.policyActive) { this.revoke('ADMISSION_NOT_ACTIVE'); return 'ADMISSION_NOT_ACTIVE'; }
    if (current.admissionId !== b.admissionId || current.policyVersion !== b.policyVersion) { this.revoke('POLICY_CHANGED'); return 'POLICY_CHANGED'; }
    if (current.fixtureGeneration !== b.fixtureGeneration) { this.revoke('FIXTURE_MISMATCH'); return 'FIXTURE_MISMATCH'; }
    if (p.admissionId !== current.admissionId || p.policyVersion !== current.policyVersion) return 'POLICY_CHANGED';
    if (current.fixtureId !== p.fixtureId || current.fixtureGeneration !== p.fixtureGeneration) return 'FIXTURE_MISMATCH';
    const wall = this.#clock.wall(); const mono = this.#clock.mono();
    const untilWall = Math.min(wall + ARM_WINDOW_MS, current.admissionExpiresMs, nextUtcDay(wall), wall + (pair.pairedUntilMono - mono));
    if (untilWall <= wall) return 'ARM_EXPIRED';
    const ack: ArmAck = { armId: randomUUID(), caseId: p.caseId, fixtureId: p.fixtureId, fixtureGeneration: p.fixtureGeneration, admissionId: p.admissionId,
      policyVersion: p.policyVersion, preSnapshotId: p.preSnapshotId, expiresAt: iso(untilWall) };
    this.#arm = { ack, pairId: pair.pairId, untilMono: mono + (untilWall - wall), state: 'ARMED', readySequence: null, readyChallenge: null, taskId: null };
    this.#at(this.#arm.untilMono);
    return ack;
  }
  /** I's READY on the paired handoff connection for the current ARMED arm (never renews the window). */
  ready(handoffConnectionId: string, armId: string, sequence: string, challenge: string): FailureCode | null {
    const p = this.pair; const a = this.arm;
    if (!p || p.state !== 'PAIRED' || p.handoffConnectionId !== handoffConnectionId) return 'PAIR_UNAVAILABLE';
    if (!a || a.ack.armId !== armId) return 'ARM_UNAVAILABLE';
    if (a.state === 'EXPIRED') return 'ARM_EXPIRED';
    if (a.state !== 'ARMED') return 'ARM_UNAVAILABLE';
    a.state = 'READY'; a.readySequence = sequence; a.readyChallenge = challenge;
    return null;
  }
  /**
   * Ingress claim (04 step 2): the session token of the current PAIRED pair and its READY, unexpired arm → CLAIMED once; the slot
   * takes that arm's READY. Any other state is a 503 rejection; the caller counts it. Never re-arms.
   */
  claim(sessionToken: string): { armId: string; taskId: string } | null {
    const p = this.pair; const a = this.arm;
    if (!p || p.state !== 'PAIRED' || !sameSecret(p.sessionToken, sessionToken) || !a || a.state !== 'READY' || a.pairId !== p.pairId
      || a.readySequence === null || a.readyChallenge === null) return null;
    a.state = 'CLAIMED'; a.taskId = randomUUID();
    this.counters.claimed += 1;
    const untilMono = this.#clock.mono() + SLOT_MS;
    this.#slot = { armId: a.ack.armId, taskId: a.taskId, untilMono, ready: { sequence: a.readySequence, challenge: a.readyChallenge }, binding: null, request: null,
      publication: null, receiptNonce: null, state: 'BOUND' };
    this.#at(untilMono);
    return { armId: a.ack.armId, taskId: a.taskId };
  }
  /** Marks the current claimed case finished (its task released and metadata collectable); the arm never returns. */
  finishArm(armId: string): void { const a = this.#arm; if (a && a.ack.armId === armId && a.state === 'CLAIMED') a.state = 'DONE'; }
  isSessionToken(token: string): boolean { const p = this.pair; return !!p && p.state === 'PAIRED' && sameSecret(p.sessionToken, token); }
}
