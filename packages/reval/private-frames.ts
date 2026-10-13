import { isFailureCode } from './codes.ts';
import type { FailureCode } from './codes.ts';
import { exact, isAbsPath, isBool, isDbName, isDec64, isIntIn, isPort, isPositiveDec64, isRoleName, isScopeId, isUuid, req, shapeFail } from './scalars.ts';

/**
 * Private closed frames between the controller and its children (brief §2e/§3/§6): never 06 envelopes, never persisted or
 * exported, ≤ 4 KiB, decoded only by these functions (the 06 decoder refuses them and vice versa). They carry paths and
 * expectations, never a credential value.
 */
export interface Endpoint { readonly socketDir: string; readonly port: number; readonly database: string }
/** Physical identity of the registered PostgreSQL instance (Dec64 strings; start = postmaster.pid epoch seconds). */
export interface PhysicalTuple {
  readonly systemIdentifier: string; readonly databaseOid: string; readonly postmasterStartTime: string; readonly postmasterPid: string;
  readonly dataDirectory: string; readonly socketDevice: string; readonly socketInode: string;
}
export const PHYSICAL_KEYS = ['systemIdentifier', 'databaseOid', 'postmasterStartTime', 'postmasterPid', 'dataDirectory', 'socketDevice', 'socketInode'];
export function decodeEndpoint(v: unknown): Endpoint {
  const o = exact(v, ['socketDir', 'port', 'database']);
  req(isAbsPath, o.socketDir); req(isPort, o.port); req(isDbName, o.database);
  return o as unknown as Endpoint;
}
export function decodePhysical(v: unknown): PhysicalTuple {
  const o = exact(v, PHYSICAL_KEYS);
  for (const k of PHYSICAL_KEYS) if (k === 'dataDirectory') req(isAbsPath, o[k]); else req(k === 'postmasterPid' ? isPositiveDec64 : isDec64, o[k]);
  return o as unknown as PhysicalTuple;
}

export const CHILD_HELLO_V1 = 'RevalChildHelloV1';
/** RS-B adds the fixture verifier V (rs-b brief B8); every receiver still requires its own exact kind. */
export interface ChildHello { readonly contractVersion: typeof CHILD_HELLO_V1; readonly kind: 'SERVER' | 'EXECUTOR' | 'VERIFIER'; readonly helloNonce: string }
export function decodeChildHello(v: unknown): ChildHello {
  const o = exact(v, ['contractVersion', 'kind', 'helloNonce']);
  if (o.contractVersion !== CHILD_HELLO_V1 || (o.kind !== 'SERVER' && o.kind !== 'EXECUTOR' && o.kind !== 'VERIFIER')) shapeFail();
  req(isUuid, o.helloNonce);
  return o as unknown as ChildHello;
}

export const SERVER_LAUNCH_V1 = 'RevalServerLaunchV1';
export interface ServerLaunch {
  readonly contractVersion: typeof SERVER_LAUNCH_V1; readonly registrationId: string; readonly databaseInstanceId: string;
  readonly serverBootId: string; readonly connectionId: string; readonly launchChallenge: string; readonly endpoint: Endpoint;
  readonly runtimeRole: string; readonly runtimeSecretFile: string; readonly physical: PhysicalTuple;
}
export function decodeServerLaunch(v: unknown): ServerLaunch {
  const o = exact(v, ['contractVersion', 'registrationId', 'databaseInstanceId', 'serverBootId', 'connectionId', 'launchChallenge', 'endpoint',
    'runtimeRole', 'runtimeSecretFile', 'physical']);
  if (o.contractVersion !== SERVER_LAUNCH_V1) shapeFail();
  for (const k of ['registrationId', 'databaseInstanceId', 'serverBootId', 'connectionId', 'launchChallenge']) req(isUuid, o[k]);
  req(isRoleName, o.runtimeRole); req(isAbsPath, o.runtimeSecretFile);
  return { ...(o as unknown as ServerLaunch), endpoint: decodeEndpoint(o.endpoint), physical: decodePhysical(o.physical) };
}

export const SERVER_BOUND_V1 = 'RevalServerBoundV1';
export interface ServerObserved {
  readonly systemIdentifier: string; readonly databaseOid: string; readonly postmasterStartTime: string; readonly backendPid: string;
  readonly sessionUser: string; readonly unixSocket: true;
}
export interface ServerBound { readonly contractVersion: typeof SERVER_BOUND_V1; readonly launchChallenge: string; readonly serverBootId: string; readonly observed: ServerObserved }
export function decodeServerBound(v: unknown): ServerBound {
  const o = exact(v, ['contractVersion', 'launchChallenge', 'serverBootId', 'observed']);
  if (o.contractVersion !== SERVER_BOUND_V1) shapeFail();
  req(isUuid, o.launchChallenge); req(isUuid, o.serverBootId);
  const x = exact(o.observed, ['systemIdentifier', 'databaseOid', 'postmasterStartTime', 'backendPid', 'sessionUser', 'unixSocket']);
  req(isDec64, x.systemIdentifier); req(isDec64, x.databaseOid); req(isDec64, x.postmasterStartTime); req(isPositiveDec64, x.backendPid);
  req(isRoleName, x.sessionUser); if (x.unixSocket !== true) shapeFail();
  return o as unknown as ServerBound;
}

export const OWNER_EXEC_REQUEST_V1 = 'RevalOwnerExecRequestV1';
export interface OwnerExecRequest {
  readonly contractVersion: typeof OWNER_EXEC_REQUEST_V1; readonly helloNonce: string; readonly challenge: string; readonly remainingMs: number;
  readonly registrationId: string; readonly databaseInstanceId: string; readonly workspaceId: string; readonly clientId: string;
  readonly actorId: string; readonly admissionId: string; readonly expectedPolicyVersion: string; readonly endpoint: Endpoint;
  readonly ownerRole: string; readonly physical: PhysicalTuple; readonly ownerSecretFile: string;
}
export function decodeOwnerExecRequest(v: unknown): OwnerExecRequest {
  const o = exact(v, ['contractVersion', 'helloNonce', 'challenge', 'remainingMs', 'registrationId', 'databaseInstanceId', 'workspaceId', 'clientId',
    'actorId', 'admissionId', 'expectedPolicyVersion', 'endpoint', 'ownerRole', 'physical', 'ownerSecretFile']);
  if (o.contractVersion !== OWNER_EXEC_REQUEST_V1) shapeFail();
  for (const k of ['helloNonce', 'challenge', 'registrationId', 'databaseInstanceId', 'admissionId']) req(isUuid, o[k]);
  if (!isIntIn(o.remainingMs, 1, 1400)) shapeFail();
  for (const k of ['workspaceId', 'clientId', 'actorId']) req(isScopeId, o[k]);
  req(isPositiveDec64, o.expectedPolicyVersion); req(isRoleName, o.ownerRole); req(isAbsPath, o.ownerSecretFile);
  return { ...(o as unknown as OwnerExecRequest), endpoint: decodeEndpoint(o.endpoint), physical: decodePhysical(o.physical) };
}

export const OWNER_EXEC_RESULT_V1 = 'RevalOwnerExecResultV1';
export type ExecOutcome = 'CONFIRMED_COMMIT' | 'REFUSED' | 'COMMIT_UNKNOWN';
export interface OwnerExecResult {
  readonly contractVersion: typeof OWNER_EXEC_RESULT_V1; readonly challenge: string; readonly outcome: ExecOutcome;
  readonly revisionApplied: boolean | null; readonly policyVersion: string | null; readonly fenceEpoch: string | null; readonly code: FailureCode | null;
}
/** Exact result; the outcome fixes which fields are null (CONFIRMED_COMMIT: tuple + revisionApplied; REFUSED: code only). */
export function decodeOwnerExecResult(v: unknown): OwnerExecResult {
  const o = exact(v, ['contractVersion', 'challenge', 'outcome', 'revisionApplied', 'policyVersion', 'fenceEpoch', 'code']);
  if (o.contractVersion !== OWNER_EXEC_RESULT_V1) shapeFail();
  req(isUuid, o.challenge);
  if (o.outcome === 'CONFIRMED_COMMIT') {
    if (!isBool(o.revisionApplied) || !isPositiveDec64(o.policyVersion) || !isPositiveDec64(o.fenceEpoch) || o.code !== null) shapeFail();
  } else if (o.outcome === 'REFUSED') {
    if (o.revisionApplied !== null || o.policyVersion !== null || o.fenceEpoch !== null || !isFailureCode(o.code)) shapeFail();
  } else if (o.outcome === 'COMMIT_UNKNOWN') {
    if (o.revisionApplied !== null || o.policyVersion !== null || o.fenceEpoch !== null || o.code !== null) shapeFail();
  } else shapeFail();
  return o as unknown as OwnerExecResult;
}

export const FIXTURE_VERIFY_REQUEST_V1 = 'RevalFixtureVerifyRequestV1';
/** C → V after its verified HELLO: paths and expectations only (the runtime secret FILE path, never its value). */
export interface FixtureVerifyRequest {
  readonly contractVersion: typeof FIXTURE_VERIFY_REQUEST_V1; readonly helloNonce: string; readonly challenge: string; readonly remainingMs: number;
  readonly registrationId: string; readonly databaseInstanceId: string; readonly workspaceId: string; readonly clientId: string; readonly actorId: string;
  readonly admissionId: string; readonly fixtureId: string; readonly fixtureGeneration: string; readonly endpoint: Endpoint; readonly runtimeRole: string;
  readonly physical: PhysicalTuple; readonly runtimeSecretFile: string;
}
export function decodeFixtureVerifyRequest(v: unknown): FixtureVerifyRequest {
  const o = exact(v, ['contractVersion', 'helloNonce', 'challenge', 'remainingMs', 'registrationId', 'databaseInstanceId', 'workspaceId', 'clientId',
    'actorId', 'admissionId', 'fixtureId', 'fixtureGeneration', 'endpoint', 'runtimeRole', 'physical', 'runtimeSecretFile']);
  if (o.contractVersion !== FIXTURE_VERIFY_REQUEST_V1) shapeFail();
  for (const k of ['helloNonce', 'challenge', 'registrationId', 'databaseInstanceId', 'admissionId']) req(isUuid, o[k]);
  if (!isIntIn(o.remainingMs, 1, 1400)) shapeFail();
  for (const k of ['workspaceId', 'clientId', 'actorId']) req(isScopeId, o[k]);
  if (typeof o.fixtureId !== 'string' || !/^FX(0[1-9]|1[01])$/.test(o.fixtureId)) shapeFail();
  req(isPositiveDec64, o.fixtureGeneration); req(isRoleName, o.runtimeRole); req(isAbsPath, o.runtimeSecretFile);
  return { ...(o as unknown as FixtureVerifyRequest), endpoint: decodeEndpoint(o.endpoint), physical: decodePhysical(o.physical) };
}
export const FIXTURE_VERIFY_RESULT_V1 = 'RevalFixtureVerifyResultV1';
/** V → C: four booleans (CHECKED) or one fixed code (REFUSED); nothing else ever leaves V. */
export interface FixtureVerifyResult {
  readonly contractVersion: typeof FIXTURE_VERIFY_RESULT_V1; readonly challenge: string; readonly outcome: 'CHECKED' | 'REFUSED';
  readonly rowIdentity: boolean | null; readonly sourceProjection: boolean | null; readonly expectedFacts: boolean | null;
  readonly allFiveIntents: boolean | null; readonly code: FailureCode | null;
}
const VERIFY_BOOLEANS = ['rowIdentity', 'sourceProjection', 'expectedFacts', 'allFiveIntents'];
export function decodeFixtureVerifyResult(v: unknown): FixtureVerifyResult {
  const o = exact(v, ['contractVersion', 'challenge', 'outcome', ...VERIFY_BOOLEANS, 'code']);
  if (o.contractVersion !== FIXTURE_VERIFY_RESULT_V1) shapeFail();
  req(isUuid, o.challenge);
  if (o.outcome === 'CHECKED') { if (!VERIFY_BOOLEANS.every(k => isBool(o[k])) || o.code !== null) shapeFail(); }
  else if (o.outcome === 'REFUSED') { if (!VERIFY_BOOLEANS.every(k => o[k] === null) || !isFailureCode(o.code)) shapeFail(); }
  else shapeFail();
  return o as unknown as FixtureVerifyResult;
}
