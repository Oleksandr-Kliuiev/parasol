import { randomUUID } from 'node:crypto';
import type { FailureCode } from './codes.ts';
import type { Request } from './envelope.ts';
import { loadCaseFixtures } from './eval-cases.ts';
import type { CensusLink } from './eval-drain.ts';
import type { ProofLink } from './eval-proofs.ts';
import type { InstrumentConn, InstrumentHandler, InstrumentResult } from './eval-instrument-link.ts';
import { TerminalJournal } from './eval-journal.ts';
import { isFailureCode } from './codes.ts';
import { decodeArmAck, decodeObservationAck, decodePairAck, decodeTerminalObservation, newToken } from './eval-wire.ts';
import type { FixtureCheckPayload, Snapshot } from './payloads.ts';
import type { ServerLink } from './server-link.ts';

/**
 * Controller-side RS-C-A evaluation logic (04 "Pairing and arm", "First-current-GO bookkeeping"; 06 PAIR/ARM/terminal rows;
 * rs-c/IMPLEMENTATION_BRIEF.md §3). Every operation runs inside the controller's ONE serialized operation queue (shared with O),
 * within its own 1800 ms budget. C never holds a credential beyond the reader; S is reached only through its measured link.
 * rc2 (review F7, NB9): ANY failure after a case was consumed (seen) — S failure, lost/invalid ACK, PRE/case/pair checks — and an
 * armed case that expired unused STOP arming for the rest of this controller process (no automatic continuation); the active
 * case retires only when its FINAL terminal observation was journaled. Resume = the owner's fence-first closure (`pause-export`),
 * the POST census and DRAIN (RS-D-A) and a new owner session. rc2 (F8): every forwarded S response is kind- and schema-checked.
 */
export const PRE_SNAPSHOT_MAX_AGE_MS = 2000;
export const PAIR_NONCE_TTL_MS = 120_000;
const S_HOP_MS = 600;
export interface ControllerHooks {
  server(): ServerLink | null;
  identity(until: number): Promise<InstrumentResult>;
  snapshot(until: number): Promise<{ result: InstrumentResult; snapshot: Snapshot | null; completed: number }>;
  readCurrent(until: number): Promise<{ fixtureId: string; fixtureGeneration: string } | null>;
  serialize<T>(fn: () => Promise<T>): Promise<T>;
  /** RS-D-A: C's census link (PROCESS_CENSUS forwarding with the epoch rule, DRAIN composition), shared with O's operations. */
  readonly census: CensusLink;
  /** RS-D-B: C's platform/privacy evidence adapters, shared with O's operations. */
  readonly proofs: ProofLink;
  now(): number; wallMs(): number;
  readonly admissionId: string; readonly serverBootId: string; readonly registrationId: string;
}
interface CPair { readonly pairId: string; readonly controlConnectionId: string; readonly handoffConnectionId: string; ended: boolean }
interface Exported { readonly connectionId: string; readonly completed: number; readonly snapshot: Snapshot }
export type ArmStop = 'ARM_PHASE_FAILURE' | 'ARM_EXPIRED_UNUSED' | 'METADATA_PERSIST_FAILED';
const fail = (code: FailureCode): InstrumentResult => ({ kind: 'FAILURE', payload: { code }, emitter: 'CONTROLLER' });
/** An S response forwarded as SERVER only when it is a valid FAILURE or exactly the expected kind with a valid payload. */
export function fromServer(r: { kind: string; payload: unknown } | null, kind: string, decode: (v: unknown) => unknown): InstrumentResult {
  if (r === null) return fail('IPC_LOST');
  if (r.kind === 'FAILURE') {
    const code = (r.payload as { code?: unknown } | null)?.code;
    return isFailureCode(code) ? { kind: 'FAILURE', payload: { code }, emitter: 'SERVER' } : fail('PROTOCOL_INVALID');
  }
  if (r.kind !== kind) return fail('PROTOCOL_INVALID');
  try { decode(r.payload); } catch { return fail('PROTOCOL_INVALID'); }
  return { kind: r.kind as never, payload: r.payload, emitter: 'SERVER' };
}

export class ControllerEvaluation implements InstrumentHandler {
  readonly #h: ControllerHooks; readonly #journal: TerminalJournal; readonly #cases: ReadonlyMap<string, string>;
  #fixtureOk: { fixtureId: string; fixtureGeneration: string } | null = null;
  #pair: CPair | null = null;
  readonly #seen = new Set<string>();
  #currentArm: { armId: string; expiresMs: number } | null = null;
  readonly #exports = new Map<string, Exported>();
  readonly #live = new Set<string>();
  /** NB9 arm-phase run state: null while arming may continue; sticky once set (this process never arms again). */
  stopped: ArmStop | null = null;
  constructor(hooks: ControllerHooks, journalPath: string, cases: ReadonlyMap<string, string> = loadCaseFixtures()) {
    this.#h = hooks; this.#journal = new TerminalJournal(journalPath); this.#cases = cases;
  }
  /** FIXTURE_CHECK with ALL six proofs true records the generation PAIR may use (any other result clears it). */
  fixtureChecked(p: FixtureCheckPayload | null): void {
    this.#fixtureOk = p && p.rowIdentity && p.sourceProjection && p.expectedFacts && p.allFiveIntents && p.financeUnchanged
      ? { fixtureId: p.fixtureId, fixtureGeneration: p.fixtureGeneration } : null;
  }
  connected(conn: InstrumentConn): void { this.#live.add(conn.connectionId); }

  /** O→C PAIR: returns S's installation acknowledgement and the secret fields for O's private frame. */
  async ownerPair(p: { instrumentControlConnectionId: string; instrumentHandoffConnectionId: string }, until: number):
    Promise<{ ack: unknown; secret: { pairId: string; pairingNonce: string; expiresAt: string } } | FailureCode> {
    if (this.#pair && !this.#pair.ended) return 'PAIR_UNAVAILABLE';
    if (!this.#live.has(p.instrumentControlConnectionId)) return 'PAIR_UNAVAILABLE';
    const current = await this.#h.readCurrent(until - S_HOP_MS);
    const ok = this.#fixtureOk;
    if (!current || !ok || ok.fixtureId !== current.fixtureId || ok.fixtureGeneration !== current.fixtureGeneration) return 'FIXTURE_MISMATCH';
    const server = this.#h.server(); if (!server) return 'PAIR_UNAVAILABLE';
    const secret = { pairId: randomUUID(), pairingNonce: newToken(), expiresAt: new Date(this.#h.wallMs() + PAIR_NONCE_TTL_MS).toISOString() };
    const r = fromServer(await server.evaluationRequest('PAIR', {}, Math.max(1, Math.min(S_HOP_MS, until - this.#h.now())), { ...secret, ...p }),
      'PAIR_ACK', decodePairAck);
    if (r.kind === 'FAILURE') return (r.payload as { code: FailureCode }).code;
    const ack = r.payload as { pairId: string; paired: boolean };
    if (ack.pairId !== secret.pairId || ack.paired) return 'PROTOCOL_INVALID';
    this.#pair = { pairId: secret.pairId, controlConnectionId: p.instrumentControlConnectionId, handoffConnectionId: p.instrumentHandoffConnectionId, ended: false };
    return { ack, secret };
  }
  /** END_PAIR from O (any current pair) or from the paired instrument (its own pair only). */
  async endPair(pairId: string, until: number, by: InstrumentConn | null): Promise<InstrumentResult> {
    const pair = this.#pair;
    if (!pair || pair.pairId !== pairId || (by !== null && by.connectionId !== pair.controlConnectionId)) return fail('PAIR_UNAVAILABLE');
    pair.ended = true;
    const server = this.#h.server();
    const r = fromServer(server ? await server.evaluationRequest('END_PAIR', { pairId }, Math.max(1, Math.min(S_HOP_MS, until - this.#h.now()))) : null,
      'PAIR_ACK', v => { if (decodePairAck(v).pairId !== pairId) throw new Error('pair'); });
    // 06: PAIR_ACK is CONTROLLER for owner initiation/end; the paired instrument's END_PAIR gets S's acknowledgement (SERVER).
    return by === null && r.kind === 'PAIR_ACK' ? { ...r, emitter: 'CONTROLLER' } : r;
  }
  /**
   * TERMINAL_OBSERVATION: S's fresh authenticated record — exactly the requested arm of this registration/boot — is validated and
   * ATOMICALLY journaled BEFORE OBSERVATION_COLLECTED and before the requester sees it. A schema/binding mismatch is
   * PROTOCOL_INVALID (nothing saved); a save failure is METADATA_PERSIST_FAILED, keeps S's record and stops arming for good.
   * The active case retires on its FINAL record; an expired active case that S never claimed (no record) stops arming (NB9).
   */
  async terminal(armId: string, until: number): Promise<InstrumentResult> {
    const server = this.#h.server(); if (!server) return fail('OBSERVATION_UNAVAILABLE');
    const r = fromServer(await server.evaluationRequest('TERMINAL_OBSERVATION', { armId }, Math.max(1, Math.min(S_HOP_MS, until - 400 - this.#h.now()))),
      'TERMINAL_OBSERVATION', v => {
        const o = decodeTerminalObservation(v);
        if (o.binding.armId !== armId || o.binding.registrationId !== this.#h.registrationId || o.binding.serverBootId !== this.#h.serverBootId) throw new Error('binding');
      });
    if (r.kind === 'FAILURE') {
      const cur = this.#currentArm;
      if ((r.payload as { code: string }).code === 'OBSERVATION_UNAVAILABLE' && r.emitter === 'SERVER' && cur?.armId === armId && this.#h.wallMs() >= cur.expiresMs) {
        this.#stop('ARM_EXPIRED_UNUSED'); this.#currentArm = null;
      }
      return r;
    }
    let obs;
    try { obs = this.#journal.save(r.payload, { serverBootId: this.#h.serverBootId, receivedAt: new Date(this.#h.wallMs()).toISOString() }); }
    catch { this.#stop('METADATA_PERSIST_FAILED'); return fail('METADATA_PERSIST_FAILED'); }
    const ack = await server.evaluationRequest('OBSERVATION_COLLECTED', { armId, observationId: obs.observationId, revision: obs.revision },
      Math.max(1, Math.min(S_HOP_MS, until - this.#h.now())));
    try { if (ack?.kind !== 'OBSERVATION_ACK') throw new Error('ack'); decodeObservationAck(ack.payload); } catch { /* S keeps it; a later collection may retry */ }
    if (obs.final && this.#currentArm?.armId === armId) this.#currentArm = null;
    return { kind: 'TERMINAL_OBSERVATION', payload: obs, emitter: 'SERVER' };
  }
  #stop(reason: ArmStop): void { if (this.stopped === null) this.stopped = reason; }
  /**
   * I→C ARM_CASE (brief §3; 04 "First-current-GO bookkeeping" row C). Admission: the paired (registered) control connection, a
   * frozen case ID, not yet seen, arming not stopped and no active case. Only then is the case marked seen — BEFORE every later
   * check; any later failure stops arming (NB9). One forward to S; a valid ARM_ACK echoing the tuple is forwarded (origin SERVER).
   */
  async arm(conn: InstrumentConn, p: Record<string, string>, until: number): Promise<InstrumentResult> {
    const pair = this.#pair;
    if (!pair || pair.ended || pair.controlConnectionId !== conn.connectionId) return fail('PAIR_UNAVAILABLE');
    const mapped = this.#cases.get(p.caseId!);
    if (mapped === undefined) return fail('FIXTURE_MISMATCH');
    if (this.#seen.has(p.caseId!)) return fail('CASE_CONSUMED');
    if (this.stopped !== null || this.#currentArm !== null) return fail('ARM_UNAVAILABLE');
    this.#seen.add(p.caseId!);
    const failed = (code: FailureCode): InstrumentResult => { this.#stop('ARM_PHASE_FAILURE'); return fail(code); };
    const now = this.#h.wallMs();
    if (mapped !== p.fixtureId) return failed('FIXTURE_MISMATCH');
    if (p.browserPairId !== pair.pairId) return failed('PAIR_UNAVAILABLE');
    const pre = this.#exports.get(p.preSnapshotId!);
    if (!pre || pre.connectionId !== conn.connectionId || this.#h.now() - pre.completed > PRE_SNAPSHOT_MAX_AGE_MS) return failed('SNAPSHOT_STALE');
    const problem = preSnapshotProblem(pre.snapshot, p, this.#h.admissionId, now);
    if (problem) return failed(problem);
    const server = this.#h.server(); if (!server) return failed('ARM_UNAVAILABLE');
    const r = fromServer(await server.evaluationRequest('ARM_CASE', p, Math.max(1, Math.min(S_HOP_MS, until - this.#h.now()))), 'ARM_ACK', v => {
      const ack = decodeArmAck(v);
      if (ack.caseId !== p.caseId || ack.fixtureId !== p.fixtureId || ack.fixtureGeneration !== p.fixtureGeneration || ack.admissionId !== p.admissionId
        || ack.policyVersion !== p.policyVersion || ack.preSnapshotId !== p.preSnapshotId) throw new Error('echo');
    });
    if (r.kind !== 'ARM_ACK') { this.#stop('ARM_PHASE_FAILURE'); return r; }
    const ack = r.payload as { armId: string; expiresAt: string };
    this.#currentArm = { armId: ack.armId, expiresMs: Date.parse(ack.expiresAt) };
    return r;
  }

  // ---- InstrumentHandler --------------------------------------------------------------------------------------------
  handle(conn: InstrumentConn, r: Request, received: number): Promise<InstrumentResult> {
    const until = received + 1800;
    return this.#h.serialize(async () => {
      if (this.#h.now() >= until - 100) return fail('DEADLINE');
      const p = r.payload as Record<string, string>;
      switch (r.operation) {
        case 'IDENTITY': return this.#h.identity(until);
        case 'SNAPSHOT': {
          const s = await this.#h.snapshot(until);
          if (s.snapshot) {
            this.#exports.set(s.snapshot.snapshotId, { connectionId: conn.connectionId, completed: s.completed, snapshot: s.snapshot });
            if (this.#exports.size > 32) this.#exports.delete(this.#exports.keys().next().value!);
          }
          return s.result;
        }
        case 'TERMINAL_OBSERVATION': return this.terminal(p.armId!, until);
        case 'PROCESS_CENSUS': return this.#h.census.census(until - 40);
        case 'DRAIN': return this.#h.census.drain(until - 40);
        case 'PLATFORM_PROOF': return this.#h.proofs.platform();
        case 'PRIVACY_PROOF': return this.#h.proofs.privacy(until - 40);
        case 'END_PAIR': return this.endPair(p.pairId!, until, conn);
        case 'ARM_CASE': return this.arm(conn, p, until);
        default: return fail('WRONG_DIRECTION');
      }
    });
  }
  lost(conn: InstrumentConn): void {
    this.#live.delete(conn.connectionId);
    for (const [id, e] of this.#exports) if (e.connectionId === conn.connectionId) this.#exports.delete(id);
    const pair = this.#pair;
    if (pair && !pair.ended && pair.controlConnectionId === conn.connectionId) {
      void this.#h.serialize(() => this.endPair(pair.pairId, this.#h.now() + 1800, null)).catch(() => undefined);
    }
  }
}
const today = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The PRE snapshot must be fresh-day, ACTIVE, consistent, foreign-free, with headroom and exactly the armed tuple. */
export function preSnapshotProblem(s: Snapshot, p: Record<string, string>, admissionId: string, nowMs: number): FailureCode | null {
  if (s.currentDay !== today(nowMs) || s.currentMonth !== `${today(nowMs).slice(0, 7)}-01`) return 'SNAPSHOT_STALE';
  if (s.admissionId !== admissionId || p.admissionId !== admissionId) return 'POLICY_CHANGED';
  if (s.policyState !== 'ACTIVE' || Date.parse(s.expiresAt) <= nowMs) return 'ADMISSION_NOT_ACTIVE';
  if (s.policyVersion !== p.policyVersion) return 'POLICY_CHANGED';
  if (s.fixtureId !== p.fixtureId || s.fixtureGeneration !== p.fixtureGeneration) return 'FIXTURE_MISMATCH';
  if (!s.consistent || s.foreignScopeAttemptCount !== '0') return 'CENSUS_CHANGED_UNEXPECTEDLY';
  const charged = (kind: 'DAY' | 'MONTH', start: string) => BigInt(s.periods.find(x => x.kind === kind && x.periodStart === start)?.chargedMicroUsd ?? '0');
  const reserve = BigInt(s.reserveMicroUsd);
  if (charged('DAY', s.currentDay) + reserve > BigInt(s.dayCapMicroUsd) || charged('MONTH', s.currentMonth) + reserve > BigInt(s.monthCapMicroUsd)) return 'ADMISSION_NOT_ACTIVE';
  return null;
}
