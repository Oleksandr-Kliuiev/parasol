/**
 * Closed codes and the operation/direction table of the local protocol (docs/stage5/ask/remote/reval-server/
 * 06_LOCAL_PROTOCOL.md, rs-a/IMPLEMENTATION_BRIEF.md §9). The FailureCode enum is EXACTLY the 43 codes of 06.
 */
export const FAILURE_CODES = [
  'UNAUTHORIZED', 'SCOPE_MISMATCH', 'OWNER_REQUIRED', 'IDENTITY_UNVERIFIED', 'REGISTRATION_MISMATCH',
  'PROTOCOL_INVALID', 'WRONG_DIRECTION', 'WRONG_BINDING', 'SEQUENCE_INVALID', 'CHALLENGE_INVALID', 'OPERATION_BUSY',
  'FRAME_TOO_LARGE', 'DEADLINE', 'PAIR_UNAVAILABLE', 'PAIR_EXPIRED', 'PAIR_REVOKED', 'ARM_UNAVAILABLE', 'ARM_EXPIRED',
  'CASE_CONSUMED', 'ADMISSION_NOT_ACTIVE', 'POLICY_CHANGED', 'FIXTURE_MISMATCH', 'SNAPSHOT_STALE',
  'CENSUS_LIMIT_EXCEEDED', 'CENSUS_UNAVAILABLE', 'CENSUS_CHANGED_UNEXPECTEDLY', 'CONTENT_MISMATCH',
  'VALUE_VALIDATION_FAILED', 'ACK_INVALID', 'ACK_TIMEOUT', 'ACK_UNCONFIRMED', 'IPC_LOST', 'RAW_EXPIRED',
  'LOCAL_HANDOFF_UNVERIFIED', 'UNATTRIBUTED_PRE_RESERVE_FAILURE', 'OBSERVATION_UNAVAILABLE', 'OBSERVATION_GAP',
  'METADATA_PERSIST_FAILED', 'CONTAINMENT_UNCONFIRMED', 'DRAIN_NOT_QUIESCENT', 'PRIVACY_UNVERIFIED',
  'PLATFORM_UNVERIFIED', 'INTERNAL_FAILURE',
] as const;
export type FailureCode = typeof FAILURE_CODES[number];
export const isFailureCode = (v: unknown): v is FailureCode => typeof v === 'string' && (FAILURE_CODES as readonly string[]).includes(v);

export const OPERATIONS = ['IDENTITY', 'SNAPSHOT', 'PROCESS_CENSUS', 'TERMINAL_OBSERVATION', 'DRAIN', 'PLATFORM_PROOF', 'PRIVACY_PROOF',
  'FIXTURE_CHECK', 'PAIR', 'END_PAIR', 'ARM_CASE', 'PAUSE_EXPORT', 'OBSERVATION_COLLECTED'] as const;
export type Operation = typeof OPERATIONS[number];
export const isOperation = (v: unknown): v is Operation => typeof v === 'string' && (OPERATIONS as readonly string[]).includes(v);

export const KINDS = ['IDENTITY', 'SNAPSHOT', 'PROCESS_CENSUS', 'TERMINAL_OBSERVATION', 'DRAIN', 'PLATFORM_PROOF', 'PRIVACY_PROOF',
  'FIXTURE_CHECK', 'PAIR_ACK', 'ARM_ACK', 'CLOSURE', 'OBSERVATION_ACK', 'FAILURE'] as const;
export type Kind = typeof KINDS[number];
export const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);

/** Principals: owner CLI, instrument, controller, server bridge. */
export type Principal = 'O' | 'I' | 'C' | 'S';
type Edge = `${Principal}->${Principal}`;
/** The complete ordinary command directions of 06 (every other pair is refused before any effect). */
export const DIRECTIONS: Readonly<Record<Operation, readonly Edge[]>> = Object.freeze({
  IDENTITY: ['O->C', 'I->C', 'C->S'],
  SNAPSHOT: ['O->C', 'I->C'],
  PROCESS_CENSUS: ['O->C', 'I->C', 'C->S'],
  TERMINAL_OBSERVATION: ['O->C', 'I->C', 'C->S'],
  DRAIN: ['O->C', 'I->C'],
  PLATFORM_PROOF: ['O->C', 'I->C'],
  PRIVACY_PROOF: ['O->C', 'I->C'],
  FIXTURE_CHECK: ['O->C'],
  PAIR: ['O->C'],
  END_PAIR: ['O->C', 'I->C', 'C->S'],
  ARM_CASE: ['I->C', 'C->S'],
  PAUSE_EXPORT: ['O->C'],
  OBSERVATION_COLLECTED: ['C->S'],
});
/** Owner-only operations: an instrument sender gets OWNER_REQUIRED; every other absent pair WRONG_DIRECTION. */
export const OWNER_ONLY: readonly Operation[] = ['PAIR', 'FIXTURE_CHECK', 'PAUSE_EXPORT'];

/** Pure authorizer: null = permitted; otherwise the fixed refusal, decided before ANY side effect. */
export function authorize(sender: Principal, receiver: Principal, op: Operation): FailureCode | null {
  if (DIRECTIONS[op].includes(`${sender}->${receiver}`)) return null;
  if (sender === 'I' && OWNER_ONLY.includes(op)) return 'OWNER_REQUIRED';
  return 'WRONG_DIRECTION';
}

/**
 * RS-A implements IDENTITY, SNAPSHOT and PAUSE_EXPORT (O→C) and IDENTITY (C→S); RS-B adds FIXTURE_CHECK (O→C); RS-C-A adds PAIR,
 * END_PAIR, ARM_CASE, TERMINAL_OBSERVATION and OBSERVATION_COLLECTED; RS-D-A adds PROCESS_CENSUS (O→C, I→C, C→S) and DRAIN (O→C,
 * I→C); RS-D-B adds PLATFORM_PROOF and PRIVACY_PROOF (O→C, I→C). Every operation is now implemented.
 */
export const NOT_IMPLEMENTED: Readonly<Partial<Record<Operation, FailureCode>>> = Object.freeze({});
/** Response kind of each implemented operation (FAILURE is always possible). */
export const RESPONSE_KIND: Readonly<Partial<Record<Operation, Kind>>> = Object.freeze({
  IDENTITY: 'IDENTITY', SNAPSHOT: 'SNAPSHOT', PAUSE_EXPORT: 'CLOSURE', FIXTURE_CHECK: 'FIXTURE_CHECK', PAIR: 'PAIR_ACK', END_PAIR: 'PAIR_ACK',
  ARM_CASE: 'ARM_ACK', TERMINAL_OBSERVATION: 'TERMINAL_OBSERVATION', OBSERVATION_COLLECTED: 'OBSERVATION_ACK', PROCESS_CENSUS: 'PROCESS_CENSUS', DRAIN: 'DRAIN',
  PLATFORM_PROOF: 'PLATFORM_PROOF', PRIVACY_PROOF: 'PRIVACY_PROOF',
});

/** The brief's fixed local exit codes of the controller, before any authenticated response can exist (brief §2): exactly three. */
export const CONTROLLER_EXIT = Object.freeze({ PLATFORM: 10, HELPER: 11, PEER: 12 });
/** O maps a controller exit code LOCALLY to a displayed code; it is never a C-authenticated response. */
export function exitCodeDisplay(code: number | null): FailureCode {
  switch (code) {
    case CONTROLLER_EXIT.PLATFORM: return 'PLATFORM_UNVERIFIED';
    case CONTROLLER_EXIT.HELPER: case CONTROLLER_EXIT.PEER: return 'IDENTITY_UNVERIFIED';
    default: return 'INTERNAL_FAILURE';
  }
}
/** Fixed platform evidence references (01 IDENTITY.platformEvidenceRef). Production has exactly one. */
export const PRODUCTION_PLATFORM_REF = 'rsa-peertoken-unixphys-v1';
/** The server bridge's inner acknowledgement ref: a self-report, never evidence (brief §2d). */
export const SERVER_INNER_ACK_REF = 'rsa-server-inner-ack-v1';
/** Fixed per-process application_name of every RS-A database connection (brief §3 step 4). */
export const APPLICATION_NAME = Object.freeze({ reader: 'atlas-reval-c-reader', runtime: 'atlas-reval-s-runtime', owner: 'atlas-reval-e-owner',
  /** RS-B: the fixture verifier V (runtime role) and the two owner maintenance connections. */
  verifier: 'atlas-reval-v-verifier', maintain: 'atlas-reval-m-owner', confirm: 'atlas-reval-m-confirm' });
