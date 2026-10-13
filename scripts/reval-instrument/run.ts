// The measured run (rs-c brief B §3–§5, §8 rc2): drives the ACCEPTED, unchanged RC5 ExecutionSession with measured inputs. GO =
// PRE SNAPSHOT (nothing consumed if it fails) → RC5 counters(PRE) + submit (irreversible consumption) + the persisted `armIssued`
// marker → ONE ARM_CASE → READY → persisted arm details → GO permission, all inside the 30 s PRE window and the arm's expiresAt.
// Any failure after consumption abandons the in-flight case in the session (consumed, UNKNOWN commit, TERMINAL_INCOMPLETE),
// ends this instrument's own pair once it was armed (a stray click cannot claim the READY arm) and stops arming for this process
// (NB9 at I). The transfer is received in the background; `handoff` reports it without blocking for long and `finish` needs it
// settled (or abandoned). `finish` collects the terminal observation until FINAL and the POST SNAPSHOT ledger and records the RC5
// outcome once. A COMMITTED handoff always gives RC5 the EXACT values (rc3 N1: authenticated failure evidence is never erased);
// a case without an authenticated FINAL record, with a detected fault or with a publication that contradicts it gets no credit
// by withholding the ledger binding of an ANSWER (RC5's accepted unknown-liability path: no pass/credit, a truth failure stays
// FAILED; an ERROR never earns credit and keeps its measured ledger), and a fault stops arming for good (06).
// N2 (brief §4): before anything is consumed, the next GO needs the previous case FINISHED — its handoff COMMITTED, or (unless
// COMMITTED) 125 s past its GO with its background transfer reader ended plus S's 2 s handoff deadline — and its terminal record
// FINAL and (re-)collected (C's next arm needs that). Every result is a fixed code; nothing here prints or persists a raw value.
// RS-D-A (rs-d brief A §6): a PRE process census before the PRE SNAPSHOT (nothing consumed on failure; same guard epoch for the whole
// run; nothing but capability/handoff traffic since the last POST) and a POST census before the RC5 outcome (census.ts compareCase:
// a mismatch stops arming and blocks the case's credit, an extra submission/reservation/dispatch is RC5's duplicate-dispatch
// integrity failure). At a fixture-segment boundary (owner decision D1/D2) GO needs a confirmed RC5 voluntary-pause closure after the
// previous case and a QUIESCENT DRAIN taken in that paused state.
import { createHash, randomUUID } from 'node:crypto';
import { decodeDrain, decodeProcessCensus } from '../../packages/reval/census-payloads.ts';
import type { Drain, ProcessCensus } from '../../packages/reval/census-payloads.ts';
import { decodePlatformProof, decodePrivacyProof } from '../../packages/reval/proof-payloads.ts';
import type { PlatformProof, PrivacyProof } from '../../packages/reval/proof-payloads.ts';
import type { Kind, Operation } from '../../packages/reval/codes.ts';
import type { ConnectionBinding } from '../../packages/reval/envelope.ts';
import { decodeReadyAck, READY_V1 } from '../../packages/reval/eval-transient.ts';
import type { HandoffSummary } from '../../packages/reval/eval-transient.ts';
import { decodeArmAck, decodeTerminalObservation } from '../../packages/reval/eval-wire.ts';
import type { TerminalObservation } from '../../packages/reval/eval-wire.ts';
import type { ExecutionSession, Corpus, OutcomeInput } from '../ask-remote-eval-execution/session.ts';
import type { CaseContext, Tuple } from '../ask-remote-eval-execution/transient.ts';
import { compareCase, compareGap, segmentBoundaryProblem, toRecord } from './census.ts';
import type { CensusReason, CensusRecord, CensusVerdict, DrainEntry } from './census.ts';
import { PAIR_MAX_MS, PAIR_NONCE_MS } from '../../packages/reval/eval-state.ts';
import { decodeIdentity } from '../../packages/reval/payloads.ts';
import { countersOf, decodeSnapshot, ledgerOf } from './ledger.ts';
import type { ExecutedOrder } from './order.ts';
import type { Snapshot } from './ledger.ts';
import { creditBlockOf, terminalMatches } from './terminal.ts';
import type { CreditBlock, Handed } from './terminal.ts';
import { receiveTransfer, withinCap } from './transfer.ts';
import type { HandoffPort, ReadySent, TransferResult } from './transfer.ts';

export const GO_WINDOW_MS = 30_000;
export const SLOT_CLEAR_MS = 125_000;
/** S settles a transfer within its 2 s handoff deadline; margin before a reader that saw a frame counts as cleared. */
export const HANDOFF_SETTLE_MS = 5_000;
/** `handoff` waits at most this long, then reports HANDOFF_PENDING (abandon-handoff stays typeable). */
export const HANDOFF_WAIT_MS = 5_000;
const TERMINAL_POLLS = 40; const TERMINAL_POLL_MS = 250;
const CENSUS_POLLS = 20; const MAX_DRAINS = 256; const MAX_PROOFS = 64;
/** What one case needs of the pair after its GO: GO work (≤ 30 s) + the 26 s arm window + the 120 s slot + the 2 s handoff + margin. */
export const CASE_PAIR_RESERVE_MS = 200_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * rc2 (review F3): C's answers that mean S's continuity is gone — another guard epoch (C's sticky epoch rule) or S unreachable (C never
 * relaunches S). 04 "Loss of … process identity stops that run": a persisted stop, never a retryable block.
 */
const CONTINUITY_LOST: ReadonlySet<string> = new Set(['FAILURE_IDENTITY_UNVERIFIED', 'FAILURE_IPC_LOST']);
export interface ControlPort { readonly binding: ConnectionBinding; readonly closed: boolean; request(op: Operation, payload: Record<string, unknown>): Promise<{ kind: Kind; payload: unknown; emitter: string }> }
export interface RunPorts { readonly control: ControlPort; readonly handoff: HandoffPort & { readonly closed: boolean } }
export interface RunDeps {
  readonly session: ExecutionSession; readonly corpus: Corpus; readonly ports: RunPorts; readonly mono: () => number; readonly wallMs: () => number;
  /** RS-D-A: the executed order record; its sha256 must be the digest of `corpus.order` (the order the RC5 session follows). */
  readonly order: ExecutedOrder;
  /** Atomically persists the whole receipt v3 (false = failed). */
  persist(): boolean;
  /** The chained identity is still drift-free and unchanged since start. */
  identityHolds(): boolean;
}
export type ArmStop = 'ARM_PHASE_FAILURE' | 'ARM_EXPIRED_UNUSED' | 'PERSIST_FAILED' | 'TERMINAL_FAULT' | 'OBSERVATION_INVALID' | 'CENSUS_CONTINUITY_LOST'
  | 'CENSUS_CHANGED_UNEXPECTEDLY' | 'TERMINAL_EXPIRED_UNCOLLECTED';
export const ARM_STOPS: readonly ArmStop[] = ['ARM_PHASE_FAILURE', 'ARM_EXPIRED_UNUSED', 'PERSIST_FAILED', 'TERMINAL_FAULT', 'OBSERVATION_INVALID',
  'CENSUS_CONTINUITY_LOST', 'CENSUS_CHANGED_UNEXPECTEDLY', 'TERMINAL_EXPIRED_UNCOLLECTED'];
export type { DrainEntry };
export interface CaseMeasure {
  readonly caseId: string; preSnapshotId: string; armIssued: boolean; armId: string | null; armExpiresAt: string | null;
  /** PRE completion → ARM_CASE sent (counters, RC5 submit incl. its identity re-check, receipt fsync): inside C's 2 s PRE-age bound. */
  preToArmMs: number | null; armMs: number | null;
  readyMs: number | null; armFailure: string | null; handoffState: 'NOT_RECEIVED' | 'COMMITTED' | 'UNVERIFIED'; handoffCode: string | null;
  abandonedByOperator: boolean; handoff: HandoffSummary | null; terminal: TerminalObservation | null; creditBlock: CreditBlock | null;
  ledgerSource: 'CONTROLLER_POST_SNAPSHOT' | 'UNAVAILABLE'; ledgerWithheld: boolean;
  /** RS-D-A: S's guard census records (no task items) around the case and the compareCase verdict. */
  preCensus: CensusRecord | null; postCensus: CensusRecord | null; census: CensusVerdict | null; censusReason: CensusReason | null;
}
interface Current { readonly caseId: string; readonly armId: string; readonly goMono: number; readonly expiresMs: number; readonly transfer: Promise<TransferResult>;
  readonly fixtureId: string; readonly preAttempts: bigint;
  abandoned: boolean; arrived: boolean; result: TransferResult | null; readonly settled: Promise<TransferResult>; readonly release: (r: TransferResult) => void }
interface Previous { readonly caseId: string; readonly armId: string; readonly goMono: number; readonly expiresMs: number; readonly committed: boolean;
  settledMono: number | null; terminalFinal: boolean; readonly fixtureId: string; readonly closures: number; readonly preAttempts: bigint }
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const codeOf = (e: unknown, fallback = 'IPC_LOST'): string => (e as { code?: string }).code ?? fallback;
const handedOf = (r: TransferResult): Handed | null => r.values === null ? null
  : { correlationId: r.values.response.correlationId, status: r.values.response.status,
    code: r.values.response.status === 200 ? null : String((r.values.response.body as { code?: unknown }).code ?? '') };

export class MeasuredRun {
  readonly #d: RunDeps;
  tuple: Tuple | null = null; armStop: ArmStop | null = null;
  /**
   * RS-D-C: the pair the operator recorded from the owner's PAIR_ACK (`pair-ack`). The browser PAIR happens inside the nonce window
   * (≤ PAIR_NONCE_MS, ending at the ack's `expiresAt`), and S ends the pair PAIR_MAX_MS after that PAIR (04), so the pair lives at
   * least until expiresAt − PAIR_NONCE_MS + PAIR_MAX_MS whatever the typing delay (rc2, review F3). A GO is refused BEFORE
   * consumption once less than CASE_PAIR_RESERVE_MS of that remains: re-pair first.
   */
  #pairId: string | null = null; #pairGoUntilMono: number | null = null;
  get pairId(): string | null { return this.#pairId; }
  /** `ack` = the owner's exact PAIR_ACK payload `{pairId, expiresAt, paired:false}` (or its JSON line). */
  setPair(ack: unknown): string {
    let o: Record<string, unknown>;
    try { o = typeof ack === 'string' ? JSON.parse(ack.slice(ack.indexOf('{'))) as Record<string, unknown> : ack as Record<string, unknown>; } catch { return 'PAIR_ACK_INVALID'; }
    const keys = o !== null && typeof o === 'object' ? Object.keys(o).sort().join(',') : '';
    const expires = typeof o?.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(o.expiresAt) ? Date.parse(o.expiresAt) : NaN;
    if (keys !== 'expiresAt,pairId,paired' || o.paired !== false || typeof o.pairId !== 'string' || !UUID_V4.test(o.pairId) || !Number.isFinite(expires)) return 'PAIR_ACK_INVALID';
    this.#pairId = o.pairId;
    this.#pairGoUntilMono = this.#d.mono() + (expires - PAIR_NONCE_MS + PAIR_MAX_MS - CASE_PAIR_RESERVE_MS - this.#d.wallMs());
    return 'PAIR_RECORDED';
  }
  readonly cases = new Map<string, CaseMeasure>();
  #current: Current | null = null;
  /** The previous case (N2): handoff COMMITTED, or its reader's settle instant and GO instant; terminal FINAL collected. */
  #previous: Previous | null = null;
  /** Per armed case: the READY it answers and the safe facts S handed off (for the terminal-record checks; no raw value). */
  readonly #bound = new Map<string, { readonly ready: ReadySent; handed: Handed | null }>();
  /** RS-D-A: the run's one guard epoch (first PRE census), the last POST census, and every DRAIN taken. */
  #epoch: string | null = null; #lastPost: CensusRecord | null = null;
  /** rc2 (review N2): the controller's projectAttemptCount at the last recorded POST census (the next PRE must equal it). */
  #lastPostAttempts: bigint | null = null;
  readonly drains: DrainEntry[] = [];
  /** RS-D-C: C's registered build digest (its IDENTITY) the run is bound to — set by the first answer; every later one must equal it. */
  build: { readonly buildManifestSha256: string } | null = null;
  /** RS-D-B: C's platform/privacy proofs the operator took (`proofs`), recorded only — never a flag upgrade. */
  readonly proofs: { readonly afterCaseId: string | null; readonly platform: PlatformProof; readonly privacy: PrivacyProof }[] = [];
  constructor(deps: RunDeps) {
    if (createHash('sha256').update(deps.corpus.order.join('\n')).digest('hex') !== deps.order.sha256) throw Object.assign(new Error('ORDER_DRIFT'), { code: 'ORDER_DRIFT' });
    this.#d = deps;
  }
  /** The executed order this run's corpus follows (bound in the constructor). */
  get order(): ExecutedOrder { return this.#d.order; }
  get inFlight(): string | null { return this.#current?.caseId ?? null; }
  #ctx(caseId: string): CaseContext {
    const frozen = this.#d.corpus.cases.get(caseId)!;
    return { frozen, fixture: this.#d.corpus.fixtures.get(frozen.fixtureId)!, scope: this.#d.corpus.scope };
  }
  /** RC5 confirm + the tuple this run checks every PRE snapshot against. */
  confirm(admissionId: unknown, policyVersion: unknown): string {
    const r = this.#d.session.confirmTuple(admissionId, policyVersion);
    this.tuple = r === 'CONFIRMED' ? { admissionId: String(admissionId), policyVersion: String(policyVersion) } : null;
    return r;
  }
  async #snapshot(): Promise<Snapshot | string> {
    try {
      const a = await this.#d.ports.control.request('SNAPSHOT', {});
      return a.kind === 'SNAPSHOT' ? decodeSnapshot(a.payload) : `FAILURE_${(a.payload as { code: string }).code}`;
    } catch (e) { return codeOf(e); }
  }
  #stop(reason: ArmStop): void { if (this.armStop === null) this.armStop = reason; }
  /**
   * RS-D-C (receipt v6): C's IDENTITY (I→C), asked ONCE (first GO or first `proofs`), binds the run to C's build digest — C computes it
   * once at startup, so it cannot change within this session (rc2, review N1), and every later IDENTITY would only re-prove S (C ends
   * S when its reader recheck fails, rc2 F1). C's continuity-loss answers (S lost: IDENTITY_UNVERIFIED / IPC_LOST) are the persisted
   * CENSUS_CONTINUITY_LOST stop (RS-D-A rc2 F3); any other failure is retryable.
   */
  async #bindBuild(): Promise<string | null> {
    if (this.build !== null) return null;
    let a;
    try { a = await this.#d.ports.control.request('IDENTITY', {}); } catch (e) { return `BLOCKED_C_IDENTITY_${codeOf(e)}`; }
    if (a.kind !== 'IDENTITY') {
      const code = (a.payload as { code: string }).code;
      return this.#continuity(`FAILURE_${code}`) ?? `BLOCKED_C_IDENTITY_${code}`;
    }
    let build: string;
    try { build = decodeIdentity(a.payload).buildManifestSha256; } catch { return 'BLOCKED_C_IDENTITY_PROTOCOL_INVALID'; }
    this.build = Object.freeze({ buildManifestSha256: build });
    return this.#d.persist() ? null : (this.#stop('PERSIST_FAILED'), `BLOCKED_ARM_STOPPED_${this.armStop}`);
  }
  async #census(): Promise<ProcessCensus | string> {
    try {
      const a = await this.#d.ports.control.request('PROCESS_CENSUS', {});
      return a.kind === 'PROCESS_CENSUS' ? decodeProcessCensus(a.payload) : `FAILURE_${(a.payload as { code: string }).code}`;
    } catch (e) { return codeOf(e); }
  }
  /** The latest voluntary-pause closure that is CONFIRMED and still standing (the RC5 session is paused on it), else null. */
  #standingClosure(): { policyVersion: string | null; fenceEpoch: string | null } | null {
    const s = this.#d.session; if (s.voluntary !== 'CONFIRMED') return null;
    const last = [...s.facts().closureHistory].reverse().find(e => e.kind === 'VOLUNTARY');
    return last?.result === 'CONFIRMED' ? { policyVersion: last.policyVersion, fenceEpoch: last.fenceEpoch } : null;
  }
  /** rc2 (review F3): a continuity-loss answer is a persisted stop; anything else stays the caller's retryable block. */
  #continuity(code: string): string | null {
    if (!CONTINUITY_LOST.has(code)) return null;
    this.#stop('CENSUS_CONTINUITY_LOST'); this.#d.persist();
    return `BLOCKED_ARM_STOPPED_${this.armStop}`;
  }
  /** Segment boundary (D1/D2, census.ts segmentBoundaryProblem) against the RC5 closures recorded since `p` finished. */
  #boundaryProblem(p: Previous): string | null {
    return segmentBoundaryProblem(p.caseId, this.#d.session.facts().closureHistory.slice(p.closures), this.drains);
  }
  /** `drain`: C's DRAIN, recorded with the previous case and the standing voluntary closure (no case may be in flight). */
  async drain(): Promise<string> {
    if (this.#current !== null) return 'BLOCKED_CASE_IN_FLIGHT';
    if (this.drains.length >= MAX_DRAINS) return 'BLOCKED_DRAIN_LIMIT';
    let drain: Drain;
    try {
      const a = await this.#d.ports.control.request('DRAIN', {});
      if (a.kind !== 'DRAIN') return `DRAIN_FAILED_${(a.payload as { code: string }).code}`;
      drain = decodeDrain(a.payload);
    } catch (e) { return `DRAIN_FAILED_${codeOf(e, 'PROTOCOL_INVALID')}`; }
    const closure = this.#standingClosure();
    this.drains.push({ afterCaseId: this.#previous?.caseId ?? null, closurePolicyVersion: closure?.policyVersion ?? null, closureFenceEpoch: closure?.fenceEpoch ?? null, drain });
    if (!this.#d.persist()) { this.#stop('PERSIST_FAILED'); return 'DRAIN_NOT_PERSISTED'; }
    return `DRAIN ${drain.state} ${drain.continuity} owners=${drain.physicalOwnerCount} commits=${drain.pendingCommitCount} unmapped=${drain.unmappedAttemptCount}`;
  }
  /** `proofs`: C's PLATFORM_PROOF and PRIVACY_PROOF (no case may be in flight), recorded with the previous case. */
  async takeProofs(): Promise<string> {
    if (this.#current !== null) return 'BLOCKED_CASE_IN_FLIGHT';
    if (this.proofs.length >= MAX_PROOFS) return 'BLOCKED_PROOF_LIMIT';
    const bound = await this.#bindBuild(); if (bound !== null) return bound;
    let platform: PlatformProof; let privacy: PrivacyProof;
    try {
      const a = await this.#d.ports.control.request('PLATFORM_PROOF', {});
      if (a.kind !== 'PLATFORM_PROOF') return `PROOF_FAILED_${(a.payload as { code: string }).code}`;
      platform = decodePlatformProof(a.payload);
      const b = await this.#d.ports.control.request('PRIVACY_PROOF', {});
      if (b.kind !== 'PRIVACY_PROOF') return `PROOF_FAILED_${(b.payload as { code: string }).code}`;
      privacy = decodePrivacyProof(b.payload);
    } catch (e) { return `PROOF_FAILED_${codeOf(e, 'PROTOCOL_INVALID')}`; }
    const own = this.#d.ports.control.binding; // rc2 N10: proofs of THIS registration and S boot only
    if (platform.environmentId !== own.registrationId || platform.serverBootId !== own.serverBootId || privacy.environmentId !== own.registrationId
      || platform.buildManifestSha256 !== this.build!.buildManifestSha256) {
      return 'PROOF_FAILED_PROTOCOL_INVALID';
    }
    this.proofs.push({ afterCaseId: this.#previous?.caseId ?? null, platform, privacy });
    if (!this.#d.persist()) { this.#stop('PERSIST_FAILED'); return 'PROOF_NOT_PERSISTED'; }
    return `PROOFS platform=${platform.policyEvidenceRef} process=${platform.processCoverage} destinations=${platform.destinationCoverage}`
      + ` verifiedZero=${platform.countsAsVerifiedZero} privacy=${privacy.collectionState} unreadable=${privacy.unreadableDestinationCount}`
      + ` matches=${privacy.forbiddenContentMatchCount} verifiedZero=${privacy.countsAsVerifiedZero}`;
  }
  /** `census`: a diagnostic PROCESS_CENSUS (not recorded; GO and finish take their own). */
  async census(): Promise<string> {
    const c = await this.#census();
    return typeof c === 'string' ? `CENSUS_FAILED_${c}` : `CENSUS ${c.coverage} active=${c.activeTaskCount} commits=${c.pendingCommitCount} submits=${c.submitIngressCount}`;
  }
  /**
   * Accepts a collected record for `caseId` only if its Binding answers I's own READY (rc2 F4); an authenticated non-NONE fault in
   * ANY revision stops arming for good (rc2 F2). A foreign or undecodable record is not stored and stops arming.
   */
  #accept(caseId: string, payload: unknown): TerminalObservation | null {
    const b = this.#bound.get(caseId); const m = this.cases.get(caseId)!;
    let o: TerminalObservation;
    try { o = decodeTerminalObservation(payload); } catch { this.#stop('OBSERVATION_INVALID'); return null; }
    if (!b || !terminalMatches(o, b.ready, this.#d.ports.handoff.connectionId, b.handed)) { this.#stop('OBSERVATION_INVALID'); return null; }
    m.terminal = o;
    if (o.detectedFault !== 'NONE') this.#stop('TERMINAL_FAULT');
    return o;
  }
  /**
   * Re-collects the previous case's record before anything is consumed (null = FINAL and collected; C re-sends its COLLECTED). RS-D-A:
   * a case whose POST census is still missing (its record was not FINAL at `finish`, or a read failed) gets it now, as a deferred
   * census; a failed read blocks this GO (nothing consumed) and is retried by the next one.
   */
  async #collectPrevious(p: Previous): Promise<string | null> {
    const g = await this.#previousTerminal(p);
    if (g !== null) return g;
    const d = this.#d; const m = this.cases.get(p.caseId)!;
    if (m.census !== null || m.preCensus === null) return null;
    const failed = await this.#postCensus(m, p.preAttempts, true);
    if (failed !== null) return this.#continuity(failed) ?? `BLOCKED_PREVIOUS_CENSUS_${failed}`;
    // rc2 (review F1): EXTRA activity is RC5's duplicate-dispatch integrity failure on the deferred path too (the outcome is recorded).
    if (m.census === 'EXTRA_ACTIVITY') d.session.unrecordedClick(p.caseId);
    if (this.armStop !== null) { d.persist(); return `BLOCKED_ARM_STOPPED_${this.armStop}`; }
    return d.persist() ? null : (this.#stop('PERSIST_FAILED'), `BLOCKED_ARM_STOPPED_${this.armStop}`);
  }
  async #previousTerminal(p: Previous): Promise<string | null> {
    const d = this.#d; const m = this.cases.get(p.caseId)!;
    let a;
    try { a = await d.ports.control.request('TERMINAL_OBSERVATION', { armId: p.armId }); } catch (e) { return `BLOCKED_PREVIOUS_TERMINAL_${codeOf(e)}`; }
    if (a.kind !== 'TERMINAL_OBSERVATION') {
      const code = (a.payload as { code: string }).code;
      // RS-D-C rc2 (review F1): S lost (C answers IPC_LOST / IDENTITY_UNVERIFIED) is the persisted continuity stop, not a retry.
      const lost = this.#continuity(`FAILURE_${code}`); if (lost !== null) return lost;
      // A FINAL record already collected is swept by S after its collection: nothing left to collect.
      if (code === 'OBSERVATION_UNAVAILABLE' && p.terminalFinal) return null;
      // An arm S never claimed has no record; once expired C stops arming for good (NB9), and so does this run.
      if (code === 'OBSERVATION_UNAVAILABLE' && m.terminal === null && d.wallMs() >= p.expiresMs) { this.#stop('ARM_EXPIRED_UNUSED'); d.persist(); return `BLOCKED_ARM_STOPPED_${this.armStop}`; }
      return `BLOCKED_PREVIOUS_TERMINAL_${code}`;
    }
    const o = this.#accept(p.caseId, a.payload);
    if (o === null || this.armStop !== null) { d.persist(); return `BLOCKED_ARM_STOPPED_${this.armStop}`; }
    if (!o.final) { d.persist(); return 'BLOCKED_PREVIOUS_TERMINAL_NOT_FINAL'; }
    p.terminalFinal = true;
    return d.persist() ? null : (this.#stop('PERSIST_FAILED'), `BLOCKED_ARM_STOPPED_${this.armStop}`);
  }
  /**
   * RS-D-A POST census of a consumed case once nothing of it can still run (FINAL record, or no record at all): gauges back to 0
   * (bounded), the controller's attempt count, then compareCase. A failed census or snapshot READ records nothing (returns its code;
   * retried as a deferred census by the next GO); a recorded verdict other than MATCH stops arming.
   */
  async #postCensus(m: CaseMeasure, preAttempts: bigint, deferred: boolean): Promise<string | null> {
    let post: ProcessCensus | string = 'UNAVAILABLE';
    for (let i = 0; i < CENSUS_POLLS; i += 1) {
      post = await this.#census();
      if (typeof post === 'string' || (post.activeTaskCount === '0' && post.pendingCommitCount === '0')) break;
      await sleep(TERMINAL_POLL_MS);
    }
    if (typeof post === 'string') return post;
    const snap = await this.#snapshot();
    if (typeof snap === 'string') return snap;
    m.postCensus = toRecord(post);
    const attempts = !snap.consistent || snap.foreignScopeAttemptCount !== '0' ? null : BigInt(snap.projectAttemptCount) - preAttempts;
    const c = compareCase(m.preCensus!, m.postCensus, m.terminal, attempts, deferred);
    m.census = c.verdict; m.censusReason = c.reason;
    if (post.guardEpoch === this.#epoch) this.#lastPost = m.postCensus;
    if (attempts !== null) this.#lastPostAttempts = BigInt(snap.projectAttemptCount);
    if (m.census !== 'MATCH') this.#stop('CENSUS_CHANGED_UNEXPECTEDLY');
    return null;
  }

  /** 04 GO procedure for `caseId`. Returns `GO_CLICK_ASK_NOW <caseId> <seconds>` or a fixed refusal/failure code. */
  async go(caseId: string): Promise<string> {
    const d = this.#d; const c = d.ports.control; const h = d.ports.handoff;
    if (this.armStop !== null) return `BLOCKED_ARM_STOPPED_${this.armStop}`;
    if (this.#current !== null) return 'BLOCKED_CASE_IN_FLIGHT';
    const p = this.#previous;
    if (p && !p.committed && (p.settledMono === null || d.mono() < Math.max(p.settledMono + HANDOFF_SETTLE_MS, p.goMono + SLOT_CLEAR_MS))) return 'BLOCKED_PREVIOUS_SLOT_LIVE';
    if (this.pairId === null) return 'BLOCKED_NO_PAIR_ID';
    if (this.#pairGoUntilMono === null || this.#d.mono() > this.#pairGoUntilMono) return 'BLOCKED_PAIR_REFRESH_REQUIRED';
    if (this.tuple === null) return 'BLOCKED_NO_CONFIRMED_TUPLE';
    if (c.closed || h.closed) return 'BLOCKED_IPC_LOST';
    if (!this.#d.corpus.cases.has(caseId)) return 'BLOCKED_UNKNOWN_CASE';
    if (!d.identityHolds()) return 'BLOCKED_IDENTITY_DRIFT';
    if (p) { const g = await this.#collectPrevious(p); if (g !== null) return g; }
    const fixtureId = this.#d.corpus.cases.get(caseId)!.fixtureId; const pairId = this.pairId;
    if (p && p.fixtureId !== fixtureId) { const b = this.#boundaryProblem(p); if (b !== null) return b; }
    // RS-D-C: the run's build (C's IDENTITY) — before anything is consumed.
    const bound = await this.#bindBuild(); if (bound !== null) return bound;
    // PRE process census — before consumption: one epoch for the run, an idle complete census, nothing hidden since the last POST.
    const preC = await this.#census();
    if (typeof preC === 'string') return this.#continuity(preC) ?? `BLOCKED_PRE_CENSUS_${preC}`;
    const preCensus = toRecord(preC);
    const stopped = (r: ArmStop) => { this.#stop(r); d.persist(); return `BLOCKED_ARM_STOPPED_${this.armStop}`; };
    if (this.#epoch !== null && preC.guardEpoch !== this.#epoch) return stopped('CENSUS_CONTINUITY_LOST');
    // RS-D-C (carried "swept vs expired-uncollected", 06 frozen): a FINAL record S swept after its collection leaves no trace, but one it
    // expired uncollected (its collection ACK lost, 10 min after release) grows S's sticky uncollectedTerminalCount — seen HERE, before
    // any consumption, as its own stop (not a generic census change, not an OBSERVATION_GAP after the next consumption).
    if (BigInt(preCensus.uncollectedTerminalCount) > (this.#lastPost === null ? 0n : BigInt(this.#lastPost.uncollectedTerminalCount))) {
      return stopped('TERMINAL_EXPIRED_UNCOLLECTED');
    }
    if (preC.coverage !== 'COMPLETE' || (this.#lastPost !== null && compareGap(this.#lastPost, preCensus).verdict !== 'MATCH')) return stopped('CENSUS_CHANGED_UNEXPECTEDLY');
    if (preC.activeTaskCount !== '0' || preC.pendingCommitCount !== '0') return 'BLOCKED_PRE_CENSUS_NOT_QUIESCENT';
    this.#epoch = preC.guardEpoch;
    // (a) PRE — before consumption: a failure consumes nothing.
    const pre = await this.#snapshot();
    const preDone = d.mono();
    if (typeof pre === 'string') return `BLOCKED_PRE_${pre}`;
    if (pre.policyState !== 'ACTIVE' || pre.admissionId !== this.tuple.admissionId || pre.policyVersion !== this.tuple.policyVersion) return 'BLOCKED_PRE_TUPLE';
    if (pre.fixtureId !== fixtureId || !pre.consistent || pre.foreignScopeAttemptCount !== '0') return 'BLOCKED_PRE_FIXTURE_OR_CENSUS';
    // rc2 (review N2): no attempt row may appear between the last POST and this PRE (S's census alone cannot see a foreign process).
    if (this.#lastPostAttempts !== null && BigInt(pre.projectAttemptCount) !== this.#lastPostAttempts) return stopped('CENSUS_CHANGED_UNEXPECTEDLY');
    // (b) RC5 counters(PRE) + submit = irreversible consumption.
    const counters = d.session.counters(countersOf(pre));
    if (counters !== 'RECORDED') return `BLOCKED_COUNTERS_${counters}`;
    const submitted = d.session.submit(caseId);
    if (submitted !== 'DISPATCH') return submitted;
    const m: CaseMeasure = { caseId, preSnapshotId: pre.snapshotId, armIssued: false, armId: null, armExpiresAt: null, preToArmMs: null, armMs: null, readyMs: null, armFailure: null,
      handoffState: 'NOT_RECEIVED', handoffCode: null, abandonedByOperator: false, handoff: null, terminal: null, creditBlock: null, ledgerSource: 'UNAVAILABLE',
      ledgerWithheld: false, preCensus, postCensus: null, census: null, censusReason: null };
    this.cases.set(caseId, m);
    const fail = async (code: string): Promise<string> => {
      m.armFailure = code; d.session.abandonInFlight(); this.#stop('ARM_PHASE_FAILURE');
      // rc2 F6: once armed, end this instrument's own pair so no stray click can claim the READY arm (best effort; no retry).
      if (m.armId !== null) { try { await c.request('END_PAIR', { pairId }); } catch { /* lost: the arm still expires at its deadline */ } }
      d.persist();
      return `ARM_FAILED_${code}`;
    };
    // (c) the consumption and the `armIssued` marker are persisted, then exactly ONE ARM_CASE (issued even if its write then fails).
    m.armIssued = true;
    if (!d.persist()) { this.#stop('PERSIST_FAILED'); return fail('METADATA_PERSIST_FAILED'); }
    const arm = { caseId, fixtureId, fixtureGeneration: pre.fixtureGeneration, admissionId: pre.admissionId, policyVersion: pre.policyVersion,
      preSnapshotId: pre.snapshotId, browserPairId: pairId };
    const t0 = d.mono(); m.preToArmMs = Math.round(t0 - preDone);
    let ack;
    try {
      const a = await c.request('ARM_CASE', arm);
      if (a.kind !== 'ARM_ACK') return fail((a.payload as { code: string }).code);
      ack = decodeArmAck(a.payload);
    } catch (e) { return fail(codeOf(e)); }
    m.armMs = Math.round(d.mono() - t0);
    if (ack.caseId !== caseId || ack.fixtureId !== fixtureId || ack.admissionId !== pre.admissionId || ack.preSnapshotId !== pre.snapshotId
      || ack.fixtureGeneration !== pre.fixtureGeneration || ack.policyVersion !== pre.policyVersion) return fail('PROTOCOL_INVALID');
    m.armId = ack.armId; m.armExpiresAt = ack.expiresAt;
    // (d) READY on the handoff connection; READY_ACK (≤4 KiB) must echo it from this registration/boot.
    const ready: ReadySent = { sequence: '', challenge: randomUUID(), registrationId: c.binding.registrationId, serverBootId: c.binding.serverBootId,
      pairId, armId: ack.armId, caseId, fixtureId, fixtureGeneration: ack.fixtureGeneration, admissionId: ack.admissionId,
      policyVersion: ack.policyVersion, preSnapshotId: ack.preSnapshotId };
    const t1 = d.mono();
    let sentReady: ReadySent;
    try {
      const { sequence: _ignored, ...frame } = ready;
      const sequence = h.send({ contractVersion: READY_V1, ...frame });
      sentReady = { ...ready, sequence };
      const raw = await h.next(2000);
      if (!withinCap(raw)) return fail('FRAME_TOO_LARGE');
      const r = decodeReadyAck(raw);
      if (r.challenge !== sentReady.challenge || r.readySequence !== sequence || r.armId !== ack.armId
        || r.registrationId !== c.binding.registrationId || r.serverBootId !== c.binding.serverBootId) return fail('PROTOCOL_INVALID');
      if (r.disposition !== 'READY') return fail(r.failureCode ?? 'ARM_UNAVAILABLE');
    } catch (e) { return fail(codeOf(e)); }
    m.readyMs = Math.round(d.mono() - t1);
    this.#bound.set(caseId, { ready: sentReady, handed: null });
    // The arm details are durable BEFORE the GO line is printed (rc2 F6).
    if (!d.persist()) { this.#stop('PERSIST_FAILED'); return fail('METADATA_PERSIST_FAILED'); }
    // (e) GO permission only inside the 30 s PRE window and before the arm's real-time ceiling.
    const expiresMs = Date.parse(ack.expiresAt);
    const left = Math.min(preDone + GO_WINDOW_MS - d.mono(), expiresMs - d.wallMs());
    if (left <= 0) return fail('ARM_EXPIRED');
    const goMono = d.mono();
    const ctx = this.#ctx(caseId); const tuple = { admissionId: pre.admissionId, policyVersion: pre.policyVersion };
    // The one TRANSFER can only come while S's raw slot exists: claim before expiresAt, then ≤120 s from ingress (+ the 2 s handoff).
    let release!: (r: TransferResult) => void;
    const abandon = new Promise<TransferResult>(res => { release = res; });
    const transfer = receiveTransfer(h, sentReady, ctx, tuple, goMono + left + SLOT_CLEAR_MS, s => { m.handoff = s; return d.persist(); }, d.mono,
      () => { cur.arrived = true; d.session.arrived(caseId); }, () => cur.abandoned);
    const cur: Current = { caseId, armId: ack.armId, goMono, expiresMs, abandoned: false, arrived: false, result: null, release, transfer, fixtureId,
      preAttempts: BigInt(pre.projectAttemptCount),
      settled: Promise.race([transfer, abandon]).then(r => { cur.result = r; return r; }) };
    this.#current = cur;
    return `GO_CLICK_ASK_NOW ${caseId} ${Math.floor(left / 1000)}`;
  }

  /**
   * The operator states the browser handoff will not come (no RESPONSE was posted): the case's handoff is UNVERIFIED now (code
   * RAW_EXPIRED, `abandonedByOperator`); the background reader keeps draining until S's slot bound and never acknowledges a late frame.
   */
  abandonHandoff(): string {
    const cur = this.#current; if (!cur) return 'NO_CASE_IN_FLIGHT';
    if (cur.abandoned) return 'HANDOFF_ALREADY_ABANDONED';
    if (cur.arrived) return 'BLOCKED_TRANSFER_RECEIVED'; // its validation/ACK/COMMIT decides; never overridden by the operator
    if (cur.result !== null) return 'HANDOFF_ALREADY_SETTLED';
    cur.abandoned = true; this.cases.get(cur.caseId)!.abandonedByOperator = true;
    cur.release({ state: 'UNVERIFIED', code: 'RAW_EXPIRED', summary: null, values: null, arrivedMono: null });
    return 'HANDOFF_ABANDONED_UNVERIFIED';
  }
  /** The current case's handoff state, waiting at most HANDOFF_WAIT_MS (then HANDOFF_PENDING; abandon-handoff stays possible). */
  async handoff(): Promise<string> {
    const cur = this.#current; if (!cur) return 'NO_CASE_IN_FLIGHT';
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([cur.settled, new Promise(res => { timer = setTimeout(res, HANDOFF_WAIT_MS); })]);
    clearTimeout(timer);
    const r = cur.result; if (r === null) return 'HANDOFF_PENDING';
    const m = this.cases.get(cur.caseId)!;
    m.handoffState = r.state; m.handoffCode = r.state === 'UNVERIFIED' ? r.code : null;
    return r.state === 'COMMITTED' ? 'HANDOFF_COMMITTED' : `HANDOFF_UNVERIFIED_${r.code}`;
  }

  /** Collects the FINAL terminal observation and the POST ledger, records the RC5 outcome exactly once and persists. */
  async finish(): Promise<string> {
    const cur = this.#current; if (!cur) return 'NO_CASE_IN_FLIGHT';
    const r = cur.result; if (r === null) return 'BLOCKED_HANDOFF_PENDING';
    const d = this.#d; const m = this.cases.get(cur.caseId)!; const b = this.#bound.get(cur.caseId)!;
    m.handoffState = r.state; m.handoffCode = r.state === 'UNVERIFIED' ? r.code : null;
    b.handed = handedOf(r);
    // Terminal observation: poll until FINAL (bounded); each record must answer I's own arm; an unclaimed expired arm has no record.
    for (let i = 0; i < TERMINAL_POLLS; i += 1) {
      let a;
      try { a = await d.ports.control.request('TERMINAL_OBSERVATION', { armId: cur.armId }); } catch { break; }
      if (a.kind === 'TERMINAL_OBSERVATION') { const o = this.#accept(cur.caseId, a.payload); if (o === null || o.final) break; }
      else if (d.wallMs() >= cur.expiresMs && r.values === null) break;
      await sleep(TERMINAL_POLL_MS);
    }
    const correlation = b.handed?.correlationId ?? m.terminal?.binding.correlationId ?? null;
    // POST ledger from a consistent, foreign-free controller snapshot of THIS case's admission (its PRE tuple, rc3 N3; bounded
    // re-read while the attempt is still EGRESS_COMMITTED).
    let ledger: OutcomeInput['ledger'] = null;
    if (correlation !== null) {
      for (let i = 0; i < 20 && ledger === null; i += 1) {
        const post = await this.#snapshot();
        if (typeof post === 'string' || !post.consistent || post.foreignScopeAttemptCount !== '0' || post.admissionId !== b.ready.admissionId) break;
        const l = ledgerOf(post, correlation, i === 19);
        if (l !== 'PENDING') { ledger = l; m.ledgerSource = 'CONTROLLER_POST_SNAPSHOT'; } else await sleep(500);
      }
    }
    // RS-D-A POST census (before the outcome) once nothing of the case can still run; a non-FINAL record defers it to the next GO's
    // re-collection (its credit is already blocked by TERMINAL_NOT_FINAL).
    if (m.terminal === null || m.terminal.final) { const failed = await this.#postCensus(m, cur.preAttempts, false); if (failed !== null) this.#continuity(failed); }
    // Credit: no authenticated FINAL record, a detected fault or a publication contradicting the COMMITTED handoff → no credit;
    // RS-D-A: an unverified census blocks it too.
    m.creditBlock = creditBlockOf(m.terminal, r.state === 'COMMITTED' ? b.handed : null) ?? (m.census !== 'MATCH' ? 'CENSUS_UNVERIFIED' : null);
    if (m.creditBlock === 'TERMINAL_MISMATCH') this.#stop('OBSERVATION_INVALID');
    // COMMITTED → the exact server-bound values; an ANSWER whose credit is blocked loses only its ledger binding (rc3 N1). Any other
    // received transfer → LOCAL_HANDOFF_UNVERIFIED (no credit, 06); no transfer → TIMEOUT; the server's safe record stays in v3.
    const v = r.values;
    m.ledgerWithheld = r.state === 'COMMITTED' && v !== null && m.creditBlock !== null && v.response.status === 200 && ledger !== null;
    const input: OutcomeInput = r.state === 'COMMITTED' && v
      ? { request: JSON.stringify(v.request), reply: { status: v.response.status, correlationHeader: v.response.correlationId, body: JSON.stringify(v.response.body) },
        ledger: m.ledgerWithheld ? null : ledger }
      : v ? { request: JSON.stringify(v.request), reply: { status: v.response.status, correlationHeader: v.response.correlationId, body: '' }, replyUnparseable: true, ledger }
        : { request: '{}', reply: 'TIMEOUT', ledger };
    if (r.values === null && m.terminal === null && d.wallMs() >= cur.expiresMs) this.#stop('ARM_EXPIRED_UNUSED');
    let state: string;
    try { state = String(d.session.outcome(cur.caseId, input)); } catch (e) { state = `OUTCOME_REFUSED_${codeOf(e, 'ERROR')}`; }
    // An extra submission/reservation/dispatch during the case: RC5's duplicate-dispatch integrity failure of the consumed case.
    if (m.census === 'EXTRA_ACTIVITY') state = String(d.session.unrecordedClick(cur.caseId));
    const previous: Previous = { caseId: cur.caseId, armId: cur.armId, goMono: cur.goMono, expiresMs: cur.expiresMs, committed: r.state === 'COMMITTED',
      settledMono: null, terminalFinal: m.terminal?.final === true, fixtureId: cur.fixtureId, closures: d.session.facts().closureHistory.length,
      preAttempts: cur.preAttempts };
    void cur.transfer.then(() => { previous.settledMono = d.mono(); });
    this.#previous = previous;
    this.#current = null;
    if (!d.persist()) this.#stop('PERSIST_FAILED');
    return `CASE_RECORDED ${cur.caseId} ${state} ${m.handoffState}${m.creditBlock ? ` NO_CREDIT_${m.creditBlock}` : ''}`;
  }
}
