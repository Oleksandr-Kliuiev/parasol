import { randomBytes } from 'node:crypto';
import { isFailureCode } from './codes.ts';
import { decodeServerLaunch, SERVER_LAUNCH_V1 } from './private-frames.ts';
import type { ServerLaunch } from './private-frames.ts';
import { exact, isAbsPath, isBool, isDigest, isIntIn, isPositiveDec64, isScopeId, isTime, isUuid, req, shapeFail } from './scalars.ts';

/**
 * Exact RS-C-A schemas (docs/stage5/ask/remote/reval-server/06 "Roles, channels", "PAIR_ACK…", "Original-task terminal
 * observation"; rs-c/IMPLEMENTATION_BRIEF.md §2–§3). Every object is closed; Tokens are 256-bit OS-random canonical
 * 43-character base64url. Secrets (pairing nonce, session token, receipt nonce) appear only in their dedicated private
 * frames/DTOs, never in a safe payload.
 */
export const isToken = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) return false;
  const b = Buffer.from(v, 'base64url');
  return b.length === 32 && b.toString('base64url') === v;
};
export const newToken = (): string => randomBytes(32).toString('base64url');
export const isFixtureIdText = (v: unknown): v is string => typeof v === 'string' && /^FX(0[1-9]|1[01])$/.test(v);

// ---- instrument / handoff hellos (private, before 06 envelopes) --------------------------------------------------------
export const INSTRUMENT_HELLO_V1 = 'RevalInstrumentHelloV1';
export const INSTRUMENT_WELCOME_V1 = 'RevalInstrumentWelcomeV1';
export const HANDOFF_HELLO_V1 = 'RevalHandoffHelloV1';
export const HANDOFF_WELCOME_V1 = 'RevalHandoffWelcomeV1';
export interface InstrumentHello { readonly contractVersion: typeof INSTRUMENT_HELLO_V1; readonly kind: 'CONTROL'; readonly helloNonce: string }
export function decodeInstrumentHello(v: unknown): InstrumentHello {
  const o = exact(v, ['contractVersion', 'kind', 'helloNonce']);
  if (o.contractVersion !== INSTRUMENT_HELLO_V1 || o.kind !== 'CONTROL') shapeFail();
  req(isUuid, o.helloNonce);
  return o as unknown as InstrumentHello;
}
export interface InstrumentWelcome {
  readonly contractVersion: typeof INSTRUMENT_WELCOME_V1; readonly helloNonce: string; readonly registrationId: string; readonly serverBootId: string;
  readonly connectionId: string;
}
export function decodeInstrumentWelcome(v: unknown): InstrumentWelcome {
  const o = exact(v, ['contractVersion', 'helloNonce', 'registrationId', 'serverBootId', 'connectionId']);
  if (o.contractVersion !== INSTRUMENT_WELCOME_V1) shapeFail();
  for (const k of ['helloNonce', 'registrationId', 'serverBootId', 'connectionId']) req(isUuid, o[k]);
  return o as unknown as InstrumentWelcome;
}
export interface HandoffHello { readonly contractVersion: typeof HANDOFF_HELLO_V1; readonly helloNonce: string; readonly controlConnectionId: string }
export function decodeHandoffHello(v: unknown): HandoffHello {
  const o = exact(v, ['contractVersion', 'helloNonce', 'controlConnectionId']);
  if (o.contractVersion !== HANDOFF_HELLO_V1) shapeFail();
  req(isUuid, o.helloNonce); req(isUuid, o.controlConnectionId);
  return o as unknown as HandoffHello;
}
export interface HandoffWelcome {
  readonly contractVersion: typeof HANDOFF_WELCOME_V1; readonly helloNonce: string; readonly registrationId: string; readonly serverBootId: string;
  readonly connectionId: string; readonly controlConnectionId: string;
}
export function decodeHandoffWelcome(v: unknown): HandoffWelcome {
  const o = exact(v, ['contractVersion', 'helloNonce', 'registrationId', 'serverBootId', 'connectionId', 'controlConnectionId']);
  if (o.contractVersion !== HANDOFF_WELCOME_V1) shapeFail();
  for (const k of ['helloNonce', 'registrationId', 'serverBootId', 'connectionId', 'controlConnectionId']) req(isUuid, o[k]);
  return o as unknown as HandoffWelcome;
}

// ---- launch V2 ----------------------------------------------------------------------------------------------------
export const SERVER_LAUNCH_V2 = 'RevalServerLaunchV2';
export interface ServerLaunchV2 extends Omit<ServerLaunch, 'contractVersion'> {
  readonly contractVersion: typeof SERVER_LAUNCH_V2; readonly workspaceId: string; readonly askMode: 'remote'; readonly handoffSocketPath: string;
  readonly nativePeerHelper: string; readonly nativePeerHelperSha256: string;
}
const V2_EXTRA = ['workspaceId', 'askMode', 'handoffSocketPath', 'nativePeerHelper', 'nativePeerHelperSha256'];
export function decodeServerLaunchV2(v: unknown): ServerLaunchV2 {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) shapeFail();
  const o = v as Record<string, unknown>;
  if (o.contractVersion !== SERVER_LAUNCH_V2) shapeFail();
  const base: Record<string, unknown> = { contractVersion: SERVER_LAUNCH_V1 };
  for (const [k, x] of Object.entries(o)) if (k !== 'contractVersion' && !V2_EXTRA.includes(k)) base[k] = x;
  const v1 = decodeServerLaunch(base);
  const extra = exact(Object.fromEntries(V2_EXTRA.map(k => [k, o[k]])), V2_EXTRA);
  if (Object.keys(o).length !== Object.keys(base).length + V2_EXTRA.length) shapeFail();
  req(isScopeId, extra.workspaceId); if (extra.askMode !== 'remote') shapeFail();
  req(isAbsPath, extra.handoffSocketPath); req(isAbsPath, extra.nativePeerHelper); req(isDigest, extra.nativePeerHelperSha256);
  return { ...v1, ...(extra as object), contractVersion: SERVER_LAUNCH_V2 } as ServerLaunchV2;
}

// ---- pair secret (C→O and C→S, private, ≤2 KiB) ----------------------------------------------------------------------
export const PAIR_SECRET_V1 = 'RevalPairSecretV1';
export interface PairSecret {
  readonly contractVersion: typeof PAIR_SECRET_V1; readonly registrationId: string; readonly serverBootId: string; readonly connectionId: string;
  readonly sequence: string; readonly challenge: string; readonly requestSequence: string; readonly pairId: string;
  readonly instrumentControlConnectionId: string; readonly instrumentHandoffConnectionId: string; readonly pairingNonce: string; readonly expiresAt: string;
}
export const PAIR_SECRET_KEYS = ['contractVersion', 'registrationId', 'serverBootId', 'connectionId', 'sequence', 'challenge', 'requestSequence', 'pairId',
  'instrumentControlConnectionId', 'instrumentHandoffConnectionId', 'pairingNonce', 'expiresAt'] as const;
export function decodePairSecret(v: unknown): PairSecret {
  const o = exact(v, PAIR_SECRET_KEYS);
  if (o.contractVersion !== PAIR_SECRET_V1) shapeFail();
  for (const k of ['registrationId', 'serverBootId', 'connectionId', 'challenge', 'pairId', 'instrumentControlConnectionId', 'instrumentHandoffConnectionId']) req(isUuid, o[k]);
  req(isPositiveDec64, o.sequence); req(isPositiveDec64, o.requestSequence); req(isToken, o.pairingNonce); req(isTime, o.expiresAt);
  return o as unknown as PairSecret;
}

// ---- safe response payloads -------------------------------------------------------------------------------------------
export interface PairAck { readonly pairId: string; readonly expiresAt: string; readonly paired: boolean }
export function decodePairAck(v: unknown): PairAck {
  const o = exact(v, ['pairId', 'expiresAt', 'paired']); req(isUuid, o.pairId); req(isTime, o.expiresAt); req(isBool, o.paired);
  return o as unknown as PairAck;
}
export interface ArmAck {
  readonly armId: string; readonly caseId: string; readonly fixtureId: string; readonly fixtureGeneration: string; readonly admissionId: string;
  readonly policyVersion: string; readonly preSnapshotId: string; readonly expiresAt: string;
}
export const ARM_ACK_KEYS = ['armId', 'caseId', 'fixtureId', 'fixtureGeneration', 'admissionId', 'policyVersion', 'preSnapshotId', 'expiresAt'] as const;
export function decodeArmAck(v: unknown): ArmAck {
  const o = exact(v, ARM_ACK_KEYS);
  req(isUuid, o.armId); req(isScopeId, o.caseId); req(isFixtureIdText, o.fixtureId); req(isPositiveDec64, o.fixtureGeneration); req(isUuid, o.admissionId);
  req(isPositiveDec64, o.policyVersion); req(isUuid, o.preSnapshotId); req(isTime, o.expiresAt);
  return o as unknown as ArmAck;
}
export interface ObservationAck { readonly armId: string; readonly observationId: string; readonly revision: number; readonly collected: true }
export function decodeObservationAck(v: unknown): ObservationAck {
  const o = exact(v, ['armId', 'observationId', 'revision', 'collected']);
  req(isUuid, o.armId); req(isUuid, o.observationId); if (!isIntIn(o.revision, 1, 16) || o.collected !== true) shapeFail();
  return o as unknown as ObservationAck;
}

// ---- Binding and the terminal observation (≤8 KiB) ---------------------------------------------------------------------
export const BINDING_KEYS = ['registrationId', 'serverBootId', 'guardEpoch', 'handoffConnectionId', 'pairId', 'armId', 'taskId', 'caseId', 'fixtureId',
  'fixtureGeneration', 'admissionId', 'policyVersion', 'preSnapshotId', 'correlationId'] as const;
export type Binding = Readonly<Record<typeof BINDING_KEYS[number], string>>;
export function decodeBinding(v: unknown): Binding {
  const o = exact(v, BINDING_KEYS);
  for (const k of BINDING_KEYS) {
    if (k === 'caseId') req(isScopeId, o[k]); else if (k === 'fixtureId') req(isFixtureIdText, o[k]);
    else if (k === 'fixtureGeneration' || k === 'policyVersion') req(isPositiveDec64, o[k]); else req(isUuid, o[k]);
  }
  return o as unknown as Binding;
}
export const DETECTED_FAULTS = ['NONE', 'MODEL_OR_TIER_MISMATCH', 'USAGE_INVALID', 'UPSTREAM_AUTH', 'UPSTREAM_INVALID'] as const;
export type DetectedFault = typeof DETECTED_FAULTS[number];
export const RESERVATIONS = ['NONE_CONFIRMED', 'COMMITTED', 'COMMIT_UNKNOWN'] as const;
export const SETTLEMENTS = ['NOT_ATTEMPTED', 'CONFIRMED', 'FAILED_KNOWN', 'COMMIT_UNKNOWN'] as const;
export const PUBLICATION_STATES = ['NOT_ATTEMPTED', 'PENDING', 'FAILED', 'SERVER_FINISHED'] as const;
/** The accepted 19-code PublicError union and its fixed statuses (06 "Closed codes"). */
export const PUBLIC_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ASK_REQUEST_INVALID: 400, ASK_SCOPE_DENIED: 403, ASK_AUTHENTICATION_FAILED: 401, ASK_CONTEXT_UNAVAILABLE: 404, ASK_TOO_LARGE: 413,
  ASK_SCOPE_CHANGED: 409, ASK_BUSY: 429, ASK_DEADLINE: 504, ASK_PLANNER_INVALID: 503, ASK_AUDIT_FAILED: 503, ASK_RUNTIME_NOT_READY: 503,
  ASK_SOURCE_INVALID: 503, ASK_REMOTE_NOT_ADMITTED: 503, ASK_REMOTE_POLICY_CHANGED: 409, ASK_REMOTE_BUDGET: 429, ASK_REMOTE_UNAVAILABLE: 503,
  ASK_REMOTE_INVALID: 503, ASK_REMOTE_MODEL_MISMATCH: 503, ASK_REMOTE_USAGE_INVALID: 503,
});
export interface Publication { readonly state: typeof PUBLICATION_STATES[number]; readonly kind: 'NONE' | 'ANSWER' | 'ERROR'; readonly status: number | null; readonly code: string | null }
export interface TerminalObservation {
  readonly contractVersion: 'RevalTerminalObservationV1'; readonly observationId: string; readonly revision: number; readonly binding: Binding;
  readonly detectedFault: DetectedFault; readonly detectedAt: string | null; readonly reservation: typeof RESERVATIONS[number];
  readonly settlement: typeof SETTLEMENTS[number]; readonly attemptId: string | null; readonly publication: Publication;
  readonly physicalOwnerReleased: boolean; readonly final: boolean;
}
export const TERMINAL_KEYS = ['contractVersion', 'observationId', 'revision', 'binding', 'detectedFault', 'detectedAt', 'reservation', 'settlement', 'attemptId',
  'publication', 'physicalOwnerReleased', 'final'] as const;
export function decodePublication(v: unknown): Publication {
  const o = exact(v, ['state', 'kind', 'status', 'code']);
  if (!(PUBLICATION_STATES as readonly unknown[]).includes(o.state)) shapeFail();
  if (o.state === 'SERVER_FINISHED') {
    if (o.kind === 'ANSWER') { if (o.status !== 200 || o.code !== null) shapeFail(); }
    else if (o.kind === 'ERROR') { if (typeof o.code !== 'string' || PUBLIC_ERROR_STATUS[o.code] === undefined || o.status !== PUBLIC_ERROR_STATUS[o.code]) shapeFail(); }
    else shapeFail();
  } else if (o.kind !== 'NONE' || o.status !== null || o.code !== null) shapeFail();
  return o as unknown as Publication;
}
export function decodeTerminalObservation(v: unknown): TerminalObservation {
  const o = exact(v, TERMINAL_KEYS);
  if (o.contractVersion !== 'RevalTerminalObservationV1') shapeFail();
  req(isUuid, o.observationId); if (!isIntIn(o.revision, 1, 16)) shapeFail();
  decodeBinding(o.binding);
  if (!(DETECTED_FAULTS as readonly unknown[]).includes(o.detectedFault)) shapeFail();
  if (o.detectedFault === 'NONE' ? o.detectedAt !== null : !isTime(o.detectedAt)) shapeFail();
  if (!(RESERVATIONS as readonly unknown[]).includes(o.reservation) || !(SETTLEMENTS as readonly unknown[]).includes(o.settlement)) shapeFail();
  if (o.attemptId !== null) req(isUuid, o.attemptId);
  const p = decodePublication(o.publication);
  req(isBool, o.physicalOwnerReleased); req(isBool, o.final);
  if (o.final !== (o.physicalOwnerReleased === true && (p.state === 'SERVER_FINISHED' || p.state === 'FAILED'))) shapeFail();
  return o as unknown as TerminalObservation;
}
export const isPublicErrorCode = (v: unknown): v is string => typeof v === 'string' && PUBLIC_ERROR_STATUS[v] !== undefined;
export { isFailureCode };
