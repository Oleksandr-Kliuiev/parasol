// OFFLINE fake V2 server, ledger and browser request builder for the execution REHEARSAL only. It is SIMULATED: no DB,
// network, key, provider or clock of its own. Answers are produced by the ACCEPTED pure compiler path (remoteAnswer over
// the frozen fixture projection) and the accepted capabilityV2/AskErrorV1 shapes, so the rehearsal proves that the
// instrument's measurement/assertion integration works end to end — never provider semantics, server authority, fence
// or ledger behaviour. Scripted outcomes (intent, error, settlement, tampering) are chosen by the scenario, not derived.
import { createHash } from 'node:crypto';
import { remoteAnswer } from '../../packages/ask/remote/answer.ts';
import { capabilityV2 } from '../../packages/ask/remote/contracts.ts';
import { askRemoteRequest } from '../../packages/ask/remote/input.ts';
import type { Intent } from '../ask-remote-eval/dataset.ts';
import type { FixtureFile } from '../ask-remote-eval/fixtures.ts';
import type { PreparedFixture } from '../ask-remote-eval/harness.ts';
import { costMicro, RESERVE_MICRO, utcDay, utcMonth } from '../ask-remote-eval/supervisor.ts';
import type { Settlement } from '../ask-remote-eval/supervisor.ts';
import type { TransientHttp, Tuple } from './transient.ts';
import type { CountersInput, LedgerInput } from './validate.ts';

/** Deterministic lowercase UUIDv4 from a label (replayable rehearsal identifiers). */
export function fakeUuid(label: string): string {
  const h = createHash('sha256').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type Tamper = 'OBSERVATION_SUMMARY' | 'DROP_URGENT' | 'COVERAGE_FLAG' | 'DROP_PROVENANCE';
export type FakeScript =
  | { readonly kind: 'INTENT'; readonly intent: Intent; readonly settlement?: Settlement; readonly tamper?: Tamper; readonly attempts?: number }
  | { readonly kind: 'ERROR'; readonly code: string; readonly settlement: Settlement }
  | { readonly kind: 'TIMEOUT' };

export interface FakeReply { readonly http: TransientHttp | 'TIMEOUT'; readonly correlationId: string | null }
interface Attempt { attempts: number; settlement: Settlement; charged: number; day: number; month: number }

export class FakeV2 {
  readonly admissionId: string; #active = true; #version: bigint; #fence: bigint; #seq = 0;
  readonly #fixtures: ReadonlyMap<string, PreparedFixture>; readonly #scope: FixtureFile['scope'];
  readonly #day = new Map<number, number>(); readonly #month = new Map<number, number>(); readonly #ledger = new Map<string, Attempt>();
  dayCapMicro: number; monthCapMicro: number;

  constructor(fixtures: ReadonlyMap<string, PreparedFixture>, scope: FixtureFile['scope'], o: { admissionId: string; version: string; fence: string; dayCap: number; monthCap: number }) {
    this.#fixtures = fixtures; this.#scope = scope; this.admissionId = o.admissionId; this.#version = BigInt(o.version); this.#fence = BigInt(o.fence);
    this.dayCapMicro = o.dayCap; this.monthCapMicro = o.monthCap;
  }
  get tuple(): Tuple { return { admissionId: this.admissionId, policyVersion: String(this.#version) }; }
  #corr(): string { this.#seq += 1; return fakeUuid(`fake-v2:${this.admissionId}:${this.#seq}`); }
  #error(code: string, status: number): { http: TransientHttp; correlationId: string } {
    const correlationId = this.#corr();
    return { http: { status, correlationHeader: correlationId, body: JSON.stringify({ contractVersion: 'AskErrorV1', code, correlationId }) }, correlationId };
  }

  /** Refusal before any reservation: the ledger read shows no attempt (NO_RESERVATION) for this correlation. */
  #early(code: string, status: number, utcMs: number): { http: TransientHttp; correlationId: string } {
    const reply = this.#error(code, status);
    this.#settle(reply.correlationId, utcMs, 'NO_RESERVATION', 0);
    return reply;
  }

  /** GET /ask/capabilities: exact AskCapabilityV2 while active, else 503 ASK_REMOTE_NOT_ADMITTED. */
  capability(): { http: TransientHttp; correlationId: string } {
    if (!this.#active) return this.#error('ASK_REMOTE_NOT_ADMITTED', 503);
    const correlationId = this.#corr();
    return { http: { status: 200, correlationHeader: correlationId, body: JSON.stringify(capabilityV2(this.admissionId, String(this.#version))) }, correlationId };
  }
  counters(utcMs: number): CountersInput {
    return { dayChargedMicro: String(this.#day.get(utcDay(utcMs)) ?? 0), monthChargedMicro: String(this.#month.get(utcMonth(utcMs)) ?? 0) };
  }
  #account(utcMs: number, delta: number): void {
    this.#day.set(utcDay(utcMs), (this.#day.get(utcDay(utcMs)) ?? 0) + delta); this.#month.set(utcMonth(utcMs), (this.#month.get(utcMonth(utcMs)) ?? 0) + delta);
  }

  /** POST /clients/:id/ask with the request bytes the fake browser sent; ledger effects follow the script. */
  ask(requestText: string, fixtureId: string, script: FakeScript, utcMs: number): FakeReply {
    let request;
    try { request = askRemoteRequest(JSON.parse(requestText)); } catch { return this.#early('ASK_REQUEST_INVALID', 400, utcMs); }
    if (request.acknowledgement.admissionId !== this.admissionId || request.acknowledgement.policyVersion !== String(this.#version)) return this.#early('ASK_REMOTE_POLICY_CHANGED', 409, utcMs);
    if (!this.#active) return this.#early('ASK_REMOTE_NOT_ADMITTED', 503, utcMs);
    const counters = this.counters(utcMs);
    if (this.monthCapMicro - Number(counters.monthChargedMicro) < RESERVE_MICRO || this.dayCapMicro - Number(counters.dayChargedMicro) < RESERVE_MICRO) {
      return this.#early('ASK_REMOTE_BUDGET', 429, utcMs);
    }
    // The simulated synthetic DB holds exactly the case's frozen fixture (an explicit rehearsal assumption, not a provisioning proof).
    const fixture = this.#fixtures.get(fixtureId) ?? null;
    if (script.kind === 'TIMEOUT') { this.#settle(this.#corr(), utcMs, 'RETAINED_UNKNOWN_COMMIT', 1); return { http: 'TIMEOUT', correlationId: null }; }
    if (script.kind === 'ERROR') {
      const reply = this.#error(script.code, script.code === 'ASK_DEADLINE' ? 504 : script.code === 'ASK_BUSY' ? 429 : 503);
      this.#settle(reply.correlationId!, utcMs, script.settlement, script.settlement === 'NO_RESERVATION' ? 0 : 1);
      return reply;
    }
    if (fixture === null) return this.#error('ASK_CONTEXT_UNAVAILABLE', 404);
    const correlationId = this.#corr();
    const frame = { requestId: request.requestId, correlationId, workspaceId: this.#scope.workspaceId, clientId: this.#scope.clientId, sourceMode: 'db' as const,
      focusObservationId: request.observationId, generatedAt: '2026-10-10T08:00:00.000Z' };
    const answer = JSON.parse(remoteAnswer(script.intent, frame, fixture.projection, request.observationId).json) as Record<string, any>;
    if (script.tamper) tamper(answer, script.tamper);
    this.#settle(correlationId, utcMs, script.settlement ?? 'CONFIRMED', script.attempts ?? 1);
    return { http: { status: 200, correlationHeader: correlationId, body: JSON.stringify(answer) }, correlationId };
  }
  #settle(correlationId: string, utcMs: number, settlement: Settlement, attempts: number): void {
    const charged = settlement === 'CONFIRMED' ? costMicro(1200, 8) : settlement === 'NO_DISPATCH' || settlement === 'NO_RESERVATION' ? 0 : RESERVE_MICRO;
    this.#account(utcMs, charged);
    const c = this.counters(utcMs);
    this.#ledger.set(correlationId, { attempts, settlement, charged, day: Number(c.dayChargedMicro), month: Number(c.monthChargedMicro) });
  }
  /** Numeric ledger metadata of one attempt as an owner read would show it (here: simulated). */
  ledgerFor(correlationId: string | null): LedgerInput | null {
    const a = correlationId === null ? undefined : this.#ledger.get(correlationId);
    if (!a) return null;
    return { correlationId: correlationId!, attempts: String(a.attempts), settlement: a.settlement, chargedMicro: String(a.charged),
      dayChargedMicro: String(a.day), monthChargedMicro: String(a.month) };
  }
  /** Owner fence-first pause: fence and policyVersion advance; the receipt is what an owner read would report. */
  pause(): { admissionId: string; paused: string; policyVersion: string; fenceEpoch: string } {
    this.#fence += 1n; this.#version += 1n; this.#active = false;
    return { admissionId: this.admissionId, paused: 'true', policyVersion: String(this.#version), fenceEpoch: String(this.#fence) };
  }
  /** Owner revision back to ACTIVE (new version and fence; counters are never reset). */
  reactivate(): void { this.#fence += 1n; this.#version += 1n; this.#active = true; }
  /** Concurrent owner revision that changes the version without pausing (consent becomes stale). */
  revise(): void { this.#fence += 1n; this.#version += 1n; }
}

function tamper(answer: Record<string, any>, kind: Tamper): void {
  const firstObservation = (answer.evidence as any[]).find(f => f.kind === 'OBSERVATION');
  if (kind === 'OBSERVATION_SUMMARY' && firstObservation) firstObservation.data.summary = `${String(firstObservation.data.summary)} (altered)`;
  if (kind === 'DROP_URGENT') answer.urgentRefs = [];
  if (kind === 'COVERAGE_FLAG') answer.coverage.fixture = !answer.coverage.fixture;
  if (kind === 'DROP_PROVENANCE') delete answer.provenance;
}

/** The fake browser's AskRequestV2 bytes for one submission (question as typed, requested focus, captured tuple). */
export function fakeRequest(label: string, question: string, observationId: string | null, tuple: Tuple): string {
  return JSON.stringify({ contractVersion: 'AskRequestV2', requestId: fakeUuid(`request:${label}`), question, observationId,
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: tuple.admissionId, policyVersion: tuple.policyVersion, questionDataClass: 'SYNTHETIC' } });
}
