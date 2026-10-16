import type { EvalCase, Intent } from './dataset.ts';
import type { FixtureFile } from './fixtures.ts';
import { localProjection, runCase } from './harness.ts';
import type { PreparedFixture } from './harness.ts';
import { STUB_USAGE } from './provider-stub.ts';
import { costMicro, RESERVE_MICRO, Supervisor, utcDay } from './supervisor.ts';
import type { Admission, Clock, FrozenCase, Outcome, Publication, Settlement } from './supervisor.ts';

// Offline procedural rehearsal: scripted scenarios drive the supervisor model against a SIMULATED server (policy tuple,
// day/month ledger, reservation/settlement) and the accepted pure pipeline with scripted provider intents. Nothing here is
// product authority, a DB proof or a live supervisor. Each scenario declares the outcome the RC6 plan requires and the
// receipt records only expected-vs-observed enums/numbers.

export interface Context {
  readonly cases: readonly EvalCase[]; readonly fixtures: ReadonlyMap<string, PreparedFixture>; readonly scope: FixtureFile['scope'];
  readonly order: readonly string[]; readonly datasetSha256: string; readonly fixtureSha256: string; readonly orderSha256: string;
}
const ADMISSION_ID = '5e1f7a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
export const START = Date.UTC(2026, 10, 2, 8, 0, 0);
const DAY = 86_400_000;
export const STUB_COST = costMicro(STUB_USAGE.promptTokens, STUB_USAGE.completionTokens);

export function admission(ctx: Context, patch: Partial<Admission> = {}): Admission {
  return { admissionId: ADMISSION_ID, startUtcMs: START, expiryUtcMs: START + 6 * DAY, dayCapMicro: 2_000_000, monthCapMicro: 10_000_000,
    reserveMicro: RESERVE_MICRO, datasetSha256: ctx.datasetSha256, fixtureSha256: ctx.fixtureSha256, orderSha256: ctx.orderSha256,
    manualRerunAllowance: 0, pacingMax: 10, pacingWindowMs: 60_000, openingFenceEpoch: '1', ...patch };
}
export function frozenCases(cases: readonly EvalCase[]): Map<string, FrozenCase> {
  return new Map(cases.map(c => [c.caseId, { question: c.question, hasFocus: c.hasFocus, fixtureId: c.fixtureId, expectedIntent: c.expectedIntent,
    supportedGroup: c.group.startsWith('SUPPORTED_') ? c.group : null }] as const));
}

/** Simulated server side: policy tuple and the app-accounted ledger (reserve, settle, retain). */
export class SimServer {
  active = true; version = 1n; fence = 1n; dispatches = 0;
  readonly #days = new Map<number, number>(); #month = 0;
  readonly dayCap: number; readonly monthCap: number;
  constructor(dayCap: number, monthCap: number) { this.dayCap = dayCap; this.monthCap = monthCap; }
  counters = (utcMs: number) => ({ dayChargedMicro: this.#days.get(utcDay(utcMs)) ?? 0, monthChargedMicro: this.#month });
  capability() { return { active: this.active, admissionId: ADMISSION_ID, policyVersion: String(this.version) }; }
  tuple() { return { admissionId: ADMISSION_ID, policyVersion: String(this.version) }; }
  reserve(utcMs: number): boolean {
    const day = this.#days.get(utcDay(utcMs)) ?? 0;
    if (day + RESERVE_MICRO > this.dayCap || this.#month + RESERVE_MICRO > this.monthCap) return false;
    this.#days.set(utcDay(utcMs), day + RESERVE_MICRO); this.#month += RESERVE_MICRO;
    return true;
  }
  settle(utcMs: number, settlement: Settlement, cost: number): void {
    const release = settlement === 'CONFIRMED' ? RESERVE_MICRO - cost : settlement === 'NO_DISPATCH' ? RESERVE_MICRO : 0;
    this.#days.set(utcDay(utcMs), (this.#days.get(utcDay(utcMs)) ?? 0) - release); this.#month -= release;
  }
  /** Fence-first pause: inactive policy with a new version and fence epoch → the safe closure receipt fields. */
  pause(): { policyVersion: string; fenceEpoch: string } { this.active = false; this.version += 1n; this.fence += 1n; return { policyVersion: String(this.version), fenceEpoch: String(this.fence) }; }
  reactivate(): void { this.active = true; this.version += 1n; }
  get monthCharged(): number { return this.#month; }
}

export class SimClock {
  utcMs: number; monoMs = 1_000;
  constructor(utcMs: number) { this.utcMs = utcMs; }
  now(): Clock { return { utcMs: this.utcMs, monoMs: this.monoMs }; }
  advance(ms: number): void { this.utcMs += ms; this.monoMs += ms; }
  /** Jump to 08:00 UTC of the next day (the monotonic clock keeps counting). */
  nextUtcMorning(): void { const target = (utcDay(this.utcMs) + 1) * DAY + 8 * 3_600_000; this.advance(target - this.utcMs); }
}

export type Script =
  | { readonly kind: 'STUB'; readonly intent?: Intent; readonly settlement?: Settlement; readonly tamper?: boolean; readonly publication?: Publication }
  | { readonly kind: 'WITHHELD'; readonly settlement: Settlement }
  | { readonly kind: 'ERROR'; readonly code: string; readonly commit: 'KNOWN' | 'UNKNOWN' | 'NONE'; readonly reserved: boolean; readonly settlement: Settlement; readonly configFaultProven?: boolean }
  | { readonly kind: 'TIMEOUT' };

export interface Run { readonly ctx: Context; readonly sup: Supervisor; readonly server: SimServer; readonly clock: SimClock; pacingWaits: number }
export function newRun(ctx: Context, patch: Partial<Admission> = {}, startUtc = START): Run {
  const a = admission(ctx, patch);
  const server = new SimServer(a.dayCapMicro, a.monthCapMicro);
  const clock = new SimClock(startUtc);
  const sup = new Supervisor(a, frozenCases(ctx.cases), ctx.order, server.counters);
  if (sup.confirmCapability({ ...server.tuple(), active: true }) !== 'CONFIRMED') throw new Error('CONFIRM');
  return { ctx, sup, server, clock, pacingWaits: 0 };
}

const caseById = (ctx: Context, id: string): EvalCase => ctx.cases.find(c => c.caseId === id)!;
const latencyFor = (i: number): number => 300 + ((i * 53) % 1400);

/** Simulated server handling of one dispatched submission → the transient browser outcome. */
function serve(run: Run, c: EvalCase, script: Script): Outcome {
  const at = run.clock.utcMs;
  if (script.kind === 'TIMEOUT') { run.server.reserve(at); run.server.dispatches += 1; return { kind: 'TIMEOUT' }; }
  if (script.kind === 'WITHHELD') {
    // Dispatched and classified, then final authority failed before publication: no answer; reserve per the script.
    if (!run.server.reserve(at)) return { kind: 'ERROR', code: 'ASK_REMOTE_BUDGET', commit: 'NONE', settlement: 'NO_RESERVATION' };
    run.server.dispatches += 1; run.server.settle(at, script.settlement, STUB_COST);
    return { kind: 'WITHHELD', settlement: script.settlement };
  }
  if (script.kind === 'ERROR') {
    if (script.reserved && !run.server.reserve(at)) return { kind: 'ERROR', code: 'ASK_REMOTE_BUDGET', commit: 'NONE', settlement: 'NO_RESERVATION' };
    if (script.reserved) { run.server.dispatches += script.settlement === 'NO_DISPATCH' ? 0 : 1; run.server.settle(at, script.settlement, STUB_COST); }
    return { kind: 'ERROR', code: script.code, commit: script.commit, configFaultProven: script.configFaultProven, settlement: script.settlement };
  }
  if (!run.server.reserve(at)) return { kind: 'ERROR', code: 'ASK_REMOTE_BUDGET', commit: 'NONE', settlement: 'NO_RESERVATION' };
  run.server.dispatches += 1;
  const intent = script.intent ?? c.expectedIntent;
  let truthPass: boolean;
  if (script.tamper) {
    const f = run.ctx.fixtures.get(c.fixtureId)!;
    const tampered = structuredClone(f.spec.expected) as unknown as { urgent: string[] };
    tampered.urgent = tampered.urgent.slice(1).concat(['O:syn-obs-not-in-bank']);
    truthPass = localProjection({ ...f, spec: { ...f.spec, expected: tampered as never } }, intent, run.ctx.scope, c.caseId).truthPass;
  } else {
    const r = runCase(c, run.ctx.fixtures, run.ctx.scope, { outcome: 'INTENT', intent });
    truthPass = r.truthPass === true && r.wire.requestOk && r.wire.payloadOk && r.wire.hasFocusOk && r.wire.noSourceOnWire;
  }
  const settlement = script.settlement ?? 'CONFIRMED';
  run.server.settle(at, settlement, STUB_COST);
  return { kind: 'ANSWER', observedIntent: intent, truthPass, publication: script.publication ?? 'CURRENT', settlement };
}

/** Manual steps up to and including the one submission of the next case; returns 'DISPATCH' or the blocking result. */
export function dispatchNext(run: Run): { result: string; id: string | null } {
  const id = run.sup.nextCaseId;
  if (id === null) return { result: 'NO_CASE', id };
  while (run.sup.pacingFree(run.clock.now()) < 2) { run.clock.advance(1_000); run.pacingWaits += 1; }
  const pre = run.sup.preflight(run.clock.now(), run.server.capability());
  if (pre !== 'OK') return { result: pre, id };
  const c = caseById(run.ctx, id);
  run.clock.advance(150);
  if (run.sup.stage(id, c.question, c.hasFocus, c.fixtureId) !== 'STAGED') return { result: 'STAGE_FAILED', id };
  if (run.sup.consent(id, run.server.tuple()) !== 'CONSENTED') return { result: 'CONSENT_FAILED', id };
  run.clock.advance(150);
  return { result: run.sup.submit(run.clock.now(), id, c.question), id };
}
/** Simulated server handling of the dispatched case, then the supervisor's terminal observation. */
export function deliver(run: Run, id: string, script: Script): string {
  const outcome = serve(run, caseById(run.ctx, id), script);
  run.clock.advance(script.kind === 'TIMEOUT' ? 10_000 : latencyFor(run.ctx.order.indexOf(id)));
  return run.sup.outcome(run.clock.now(), id, outcome);
}
/** One manual-procedure step sequence for the next case: pacing wait, preflight, exact paste, consent, submit, outcome. */
export function step(run: Run, script: Script): string {
  const { result, id } = dispatchNext(run);
  return result === 'DISPATCH' ? deliver(run, id!, script) : result;
}

/** Fence-first closure: the simulated owner pauses the policy and the supervisor records the receipt. */
export function closeWithPause(run: Run): string {
  return run.sup.close({ admissionId: ADMISSION_ID, paused: true, ...run.server.pause() });
}
/** Manual next-UTC-day resume within the same admission: reactivate (new version), re-confirm the tuple. */
export function resumeNextDay(run: Run): string {
  run.clock.nextUtcMorning();
  const r = run.sup.resume(run.clock.now(), { admissionId: ADMISSION_ID, datasetSha256: run.ctx.datasetSha256, fixtureSha256: run.ctx.fixtureSha256, orderSha256: run.ctx.orderSha256 });
  if (r !== 'RESUMED') return r;
  run.server.reactivate();
  return run.sup.confirmCapability({ ...run.server.tuple(), active: true }) === 'CONFIRMED' ? 'RESUMED' : 'CONFIRM_FAILED';
}
export const identity = (ctx: Context) => ({ admissionId: ADMISSION_ID, datasetSha256: ctx.datasetSha256, fixtureSha256: ctx.fixtureSha256, orderSha256: ctx.orderSha256 });

/** Run steps with a per-case script chooser until the supervisor leaves ACTIVE or a step is blocked. */
export function runUntilStop(run: Run, choose: (c: EvalCase, index: number) => Script, maxSteps = 1_000): string {
  let last = 'ACTIVE';
  for (let i = 0; i < maxSteps && run.sup.state === 'ACTIVE'; i += 1) {
    const id = run.sup.nextCaseId;
    if (id === null) break;
    last = step(run, choose(caseById(run.ctx, id), i));
    if (!['ACTIVE', 'RESUMABLE_DAY', 'TERMINAL_INCOMPLETE', 'TERMINAL_FAILED', 'COMPLETE_PENDING_REVIEW', 'STOPPED'].includes(last)) return last;
  }
  return run.sup.state;
}
