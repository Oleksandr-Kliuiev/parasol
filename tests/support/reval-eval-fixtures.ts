import { randomUUID } from 'node:crypto';
import type { Binding, TerminalObservation } from '../../packages/reval/eval-wire.ts';

/**
 * TEST-ONLY builders for the R-EVAL RS-C-A schemas (unit and PG tests). Synthetic values only: random UUIDs, the frozen
 * fixture IDs and a synthetic question; never a provider key, a pairing nonce or a session token of a real session.
 */
export const binding = (over: Partial<Record<keyof Binding, string>> = {}): Binding => ({ registrationId: randomUUID(), serverBootId: randomUUID(),
  guardEpoch: randomUUID(), handoffConnectionId: randomUUID(), pairId: randomUUID(), armId: randomUUID(), taskId: randomUUID(), caseId: 'case-01',
  fixtureId: 'FX02', fixtureGeneration: '1', admissionId: randomUUID(), policyVersion: '3', preSnapshotId: randomUUID(), correlationId: randomUUID(), ...over });
export const terminal = (over: Partial<TerminalObservation> = {}): TerminalObservation => ({ contractVersion: 'RevalTerminalObservationV1',
  observationId: randomUUID(), revision: 1, binding: binding(), detectedFault: 'NONE', detectedAt: null, reservation: 'NONE_CONFIRMED',
  settlement: 'NOT_ATTEMPTED', attemptId: null, publication: { state: 'NOT_ATTEMPTED', kind: 'NONE', status: null, code: null },
  physicalOwnerReleased: false, final: false, ...over });
export const askRequest = (consent: { admissionId: string; policyVersion: string } = { admissionId: randomUUID(), policyVersion: '3' },
  observationId: string | null = null, question = 'What needs attention for this client?') => ({ contractVersion: 'AskRequestV2', requestId: randomUUID(), question,
  observationId, acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: consent.admissionId, policyVersion: consent.policyVersion,
    questionDataClass: 'SYNTHETIC' } });
export const answerResult = { requestMatchesFrozen: true, semantic: 'MATCH', schema: true, claims: true, coverage: true, urgency: true,
  publicOutcome: 'ANSWER', publicErrorCode: null } as const;
export const errorResult = (code = 'ASK_REMOTE_UNAVAILABLE') => ({ requestMatchesFrozen: true, semantic: 'NOT_EVALUATED', schema: true, claims: null,
  coverage: null, urgency: null, publicOutcome: 'ERROR', publicErrorCode: code } as const);
/** A controllable monotonic + wall clock (ms) for the pure state machines. */
export class TestClock {
  mono0 = 1_000_000; wall0 = Date.parse('2026-10-11T12:00:00.000Z');
  offset = 0;
  mono = (): number => this.mono0 + this.offset;
  wall = (): number => this.wall0 + this.offset;
  advance(ms: number): void { this.offset += ms; }
}
/** Expects `fn` to throw the scalar schema failure (any thrown error counts; returns the message for diagnostics). */
export function rejects(fn: () => unknown): boolean { try { fn(); return false; } catch { return true; } }
