import { ASK_REMOTE_PROFILE } from '../ask/remote/budget.ts';
import { exact, isBool, isDay, isDec64, isDigest, isEvidenceRef, isMonth, isPositiveDec64, isPriceRevision, isTime, isUuid, req, shapeFail,
  utcDay, utcMonthOf } from './scalars.ts';

/**
 * Exact exported payloads (01 IDENTITY, 02 SNAPSHOT/CLOSURE) and the internal snapshot wrapper of atlas_reval_snapshot()
 * (brief §7). Validation uses checked BigInt; a violated relationship of a `consistent:true` snapshot is CENSUS_UNAVAILABLE
 * (never exported). Pricing/physical facts of the wrapper never leave the controller.
 */
export const RESERVE_MICRO_USD = 300000n;
export const PROMPT_RATE = '275';
export const COMPLETION_RATE = '825';
const DAY_CAP_MAX = 2000000n;
const MONTH_CAP_MAX = 10000000n;

export interface IdentityPayload {
  readonly databaseInstanceId: string; readonly buildManifestSha256: string; readonly runtimeImageSha256: string;
  readonly launcherManifestSha256: string; readonly platformEvidenceRef: string; readonly loadedBinding: 'MEASURED' | 'UNVERIFIED'; readonly startedAt: string;
}
export function decodeIdentity(v: unknown): IdentityPayload {
  const o = exact(v, ['databaseInstanceId', 'buildManifestSha256', 'runtimeImageSha256', 'launcherManifestSha256', 'platformEvidenceRef', 'loadedBinding', 'startedAt']);
  req(isUuid, o.databaseInstanceId); req(isDigest, o.buildManifestSha256); req(isDigest, o.runtimeImageSha256); req(isDigest, o.launcherManifestSha256);
  req(isEvidenceRef, o.platformEvidenceRef); if (o.loadedBinding !== 'MEASURED' && o.loadedBinding !== 'UNVERIFIED') shapeFail(); req(isTime, o.startedAt);
  return o as unknown as IdentityPayload;
}

/** The exact four-key closure; `paused` is the JSON boolean true. */
export interface Closure { readonly admissionId: string; readonly paused: true; readonly policyVersion: string; readonly fenceEpoch: string }
export function decodeClosure(v: unknown): Closure {
  const o = exact(v, ['admissionId', 'paused', 'policyVersion', 'fenceEpoch']);
  req(isUuid, o.admissionId); if (o.paused !== true) shapeFail(); req(isPositiveDec64, o.policyVersion); req(isPositiveDec64, o.fenceEpoch);
  return o as unknown as Closure;
}

const SNAPSHOT_KEYS = ['snapshotId', 'dbObservedAt', 'admissionId', 'policyVersion', 'fenceEpoch', 'policyState', 'reserveMicroUsd', 'dayCapMicroUsd',
  'monthCapMicroUsd', 'expiresAt', 'currentDay', 'currentMonth', 'fixtureGeneration', 'fixtureId', 'projectAttemptCount', 'foreignScopeAttemptCount',
  'periods', 'attempts', 'consistent'];
const PERIOD_KEYS = ['kind', 'periodStart', 'chargedMicroUsd', 'attemptCount'];
const ATTEMPT_KEYS = ['attemptId', 'correlationId', 'admissionId', 'policyVersion', 'createdAt', 'dayStart', 'monthStart', 'reservedMicroUsd',
  'accountedMicroUsd', 'state', 'outcome', 'settledAt'];
const POLICY_STATES = ['INACTIVE', 'ACTIVE', 'PAUSED', 'REVOKED', 'TOMBSTONE'];
const UNKNOWN_OUTCOMES = ['DELIVERY_UNKNOWN', 'USAGE_INVALID', 'MODEL_MISMATCH', 'UPSTREAM_REJECTED'];
export interface Period { readonly kind: 'DAY' | 'MONTH'; readonly periodStart: string; readonly chargedMicroUsd: string; readonly attemptCount: string }
export interface Attempt {
  readonly attemptId: string; readonly correlationId: string; readonly admissionId: string; readonly policyVersion: string; readonly createdAt: string;
  readonly dayStart: string; readonly monthStart: string; readonly reservedMicroUsd: string; readonly accountedMicroUsd: string;
  readonly state: 'EGRESS_COMMITTED' | 'SETTLED' | 'UNKNOWN'; readonly outcome: string | null; readonly settledAt: string | null;
}
export interface Snapshot {
  readonly snapshotId: string; readonly dbObservedAt: string; readonly admissionId: string; readonly policyVersion: string; readonly fenceEpoch: string;
  readonly policyState: string; readonly reserveMicroUsd: string; readonly dayCapMicroUsd: string; readonly monthCapMicroUsd: string;
  readonly expiresAt: string; readonly currentDay: string; readonly currentMonth: string; readonly fixtureGeneration: string; readonly fixtureId: string;
  readonly projectAttemptCount: string; readonly foreignScopeAttemptCount: string; readonly periods: readonly Period[]; readonly attempts: readonly Attempt[];
  readonly consistent: boolean;
}

/** Thrown when a schema-valid consistent snapshot breaks a census relationship (→ CENSUS_UNAVAILABLE, not exported). */
export class CensusRelationError extends Error { constructor() { super('CENSUS_RELATION'); this.name = 'CensusRelationError'; } }
const relation = (ok: boolean) => { if (!ok) throw new CensusRelationError(); };

function decodePeriod(v: unknown): Period {
  const o = exact(v, PERIOD_KEYS);
  if (o.kind !== 'DAY' && o.kind !== 'MONTH') shapeFail();
  req(o.kind === 'MONTH' ? isMonth : isDay, o.periodStart); req(isDec64, o.chargedMicroUsd); req(isDec64, o.attemptCount);
  return o as unknown as Period;
}
function decodeAttempt(v: unknown): Attempt {
  const o = exact(v, ATTEMPT_KEYS);
  req(isUuid, o.attemptId); req(isUuid, o.correlationId); req(isUuid, o.admissionId); req(isPositiveDec64, o.policyVersion); req(isTime, o.createdAt);
  req(isDay, o.dayStart); req(isMonth, o.monthStart); req(isDec64, o.reservedMicroUsd); req(isDec64, o.accountedMicroUsd);
  if (o.outcome !== null && typeof o.outcome !== 'string') shapeFail();
  if (o.settledAt !== null) req(isTime, o.settledAt);
  const reserved = BigInt(o.reservedMicroUsd as string); const accounted = BigInt(o.accountedMicroUsd as string);
  if (reserved !== RESERVE_MICRO_USD || o.dayStart !== utcDay(o.createdAt as string) || o.monthStart !== utcMonthOf(o.dayStart as string)) shapeFail();
  const settledOk = o.settledAt !== null && (o.settledAt as string) >= (o.createdAt as string);
  switch (o.state) {
    case 'EGRESS_COMMITTED': if (o.outcome !== null || o.settledAt !== null || accounted !== reserved) shapeFail(); break;
    case 'SETTLED':
      if (!settledOk || !((o.outcome === 'USAGE_VERIFIED' && accounted <= reserved) || (o.outcome === 'NO_DISPATCH' && accounted === 0n))) shapeFail();
      break;
    case 'UNKNOWN': if (!settledOk || !UNKNOWN_OUTCOMES.includes(o.outcome as string) || accounted !== reserved) shapeFail(); break;
    default: shapeFail();
  }
  return o as unknown as Attempt;
}

/** Exact SNAPSHOT payload + every relationship of brief §7 (consistent:false is schema-validated only). */
export function decodeSnapshot(v: unknown): Snapshot {
  const o = exact(v, SNAPSHOT_KEYS);
  req(isUuid, o.snapshotId); req(isTime, o.dbObservedAt); req(isUuid, o.admissionId); req(isPositiveDec64, o.policyVersion); req(isDec64, o.fenceEpoch);
  if (!POLICY_STATES.includes(o.policyState as string)) shapeFail();
  req(isDec64, o.reserveMicroUsd); req(isDec64, o.dayCapMicroUsd); req(isDec64, o.monthCapMicroUsd); req(isTime, o.expiresAt);
  req(isDay, o.currentDay); req(isMonth, o.currentMonth); req(isPositiveDec64, o.fixtureGeneration);
  if (typeof o.fixtureId !== 'string' || !/^FX(0[1-9]|1[01])$/.test(o.fixtureId)) shapeFail();
  req(isDec64, o.projectAttemptCount); req(isDec64, o.foreignScopeAttemptCount); req(isBool, o.consistent);
  if (!Array.isArray(o.periods) || !Array.isArray(o.attempts)) shapeFail();
  const periods = (o.periods as unknown[]).map(decodePeriod);
  const attempts = (o.attempts as unknown[]).map(decodeAttempt);
  if (BigInt(o.reserveMicroUsd as string) !== RESERVE_MICRO_USD || BigInt(o.dayCapMicroUsd as string) > DAY_CAP_MAX
    || BigInt(o.monthCapMicroUsd as string) > MONTH_CAP_MAX) shapeFail();
  if (o.currentDay !== utcDay(o.dbObservedAt as string) || o.currentMonth !== utcMonthOf(o.currentDay as string)) shapeFail();
  // Ordering and presence: MONTH then DAY, each by date, unique; current and every referenced period present.
  const key = (p: Period) => `${p.kind === 'MONTH' ? 0 : 1}:${p.periodStart}`;
  for (let i = 1; i < periods.length; i += 1) if (key(periods[i - 1]!) >= key(periods[i]!)) shapeFail();
  const has = (kind: string, start: string) => periods.some(p => p.kind === kind && p.periodStart === start);
  if (!has('DAY', o.currentDay as string) || !has('MONTH', o.currentMonth as string)) shapeFail();
  for (let i = 0; i < attempts.length; i += 1) {
    const a = attempts[i]!;
    if (a.admissionId !== o.admissionId || BigInt(a.policyVersion) > BigInt(o.policyVersion as string)) shapeFail();
    if (!has('DAY', a.dayStart) || !has('MONTH', a.monthStart)) shapeFail();
    if (i > 0) { const p = attempts[i - 1]!; if (p.createdAt > a.createdAt || (p.createdAt === a.createdAt && p.attemptId >= a.attemptId)) shapeFail(); }
  }
  const snapshot = { ...(o as unknown as Snapshot), periods, attempts };
  if (snapshot.consistent) checkRelations(snapshot);
  return snapshot;
}
function checkRelations(s: Snapshot): void {
  const project = BigInt(s.projectAttemptCount); const foreign = BigInt(s.foreignScopeAttemptCount);
  relation(project === BigInt(s.attempts.length) + foreign);
  const sum = (kind: string) => s.periods.filter(p => p.kind === kind).reduce((n, p) => n + BigInt(p.attemptCount), 0n);
  relation(sum('DAY') === project && sum('MONTH') === project);
  for (const m of s.periods.filter(p => p.kind === 'MONTH')) {
    const days = s.periods.filter(p => p.kind === 'DAY' && p.periodStart.slice(0, 7) === m.periodStart.slice(0, 7));
    relation(days.reduce((n, p) => n + BigInt(p.chargedMicroUsd), 0n) === BigInt(m.chargedMicroUsd));
  }
  for (const p of s.periods) {
    const mine = s.attempts.filter(a => p.kind === 'DAY' ? a.dayStart === p.periodStart : a.monthStart === p.periodStart)
      .reduce((n, a) => n + BigInt(a.accountedMicroUsd), 0n);
    const charged = BigInt(p.chargedMicroUsd);
    relation(foreign === 0n ? mine === charged : mine <= charged);
  }
}

/** Internal wrapper of atlas_reval_snapshot() (never exported). */
export interface PricingTuple { readonly profile: string; readonly priceRevision: string; readonly reservedMicroUsd: string; readonly promptRate: string; readonly completionRate: string }
export interface SnapshotWrapper {
  readonly registrationId: string; readonly databaseInstanceId: string; readonly buildManifestSha256: string; readonly systemIdentifier: string;
  readonly databaseOid: string; readonly postmasterStartTime: string;
  readonly pricing: { readonly policy: { readonly profile: string; readonly priceRevision: string; readonly reserveMicroUsd: string }; readonly attempts: readonly PricingTuple[] };
  readonly snapshot: Record<string, unknown>;
}
export function decodeWrapper(v: unknown): SnapshotWrapper {
  const o = exact(v, ['registrationId', 'databaseInstanceId', 'buildManifestSha256', 'systemIdentifier', 'databaseOid', 'postmasterStartTime', 'pricing', 'snapshot']);
  req(isUuid, o.registrationId); req(isUuid, o.databaseInstanceId); req(isDigest, o.buildManifestSha256);
  req(isDec64, o.systemIdentifier); req(isDec64, o.databaseOid); req(isDec64, o.postmasterStartTime);
  const pricing = exact(o.pricing, ['policy', 'attempts']);
  const policy = exact(pricing.policy, ['profile', 'priceRevision', 'reserveMicroUsd']);
  if (typeof policy.profile !== 'string' || typeof policy.priceRevision !== 'string') shapeFail(); req(isDec64, policy.reserveMicroUsd);
  if (!Array.isArray(pricing.attempts) || pricing.attempts.length > 8) shapeFail();
  for (const t of pricing.attempts as unknown[]) {
    const x = exact(t, ['profile', 'priceRevision', 'reservedMicroUsd', 'promptRate', 'completionRate']);
    if (typeof x.profile !== 'string' || typeof x.priceRevision !== 'string') shapeFail();
    req(isDec64, x.reservedMicroUsd); req(isDec64, x.promptRate); req(isDec64, x.completionRate);
  }
  exact(o.snapshot, SNAPSHOT_KEYS.filter(k => k !== 'snapshotId'));
  return o as unknown as SnapshotWrapper;
}
/**
 * Approved pricing (brief §7 A8): accepted ASK_REMOTE_PROFILE, reserve 300000 and rates 275/825 (accepted CHECKs) plus the
 * owner-config approvedPriceRevision. The policy AND every project attempt must match; never a policy-to-itself comparison.
 */
export function pricingMatches(w: SnapshotWrapper, approvedPriceRevision: string): boolean {
  if (!isPriceRevision(approvedPriceRevision)) return false;
  const p = w.pricing.policy;
  if (p.profile !== ASK_REMOTE_PROFILE || p.priceRevision !== approvedPriceRevision || p.reserveMicroUsd !== String(RESERVE_MICRO_USD)) return false;
  if (w.pricing.attempts.length === 0) return true;
  if (w.pricing.attempts.length !== 1) return false;
  const a = w.pricing.attempts[0]!;
  return a.profile === ASK_REMOTE_PROFILE && a.priceRevision === approvedPriceRevision && a.reservedMicroUsd === String(RESERVE_MICRO_USD)
    && a.promptRate === PROMPT_RATE && a.completionRate === COMPLETION_RATE;
}

/** RS-B: the exact FIXTURE_CHECK payload of 03 "DB equals fixture proof" (key order as specified; booleans strict). */
export const FIXTURE_CHECK_KEYS = ['fixtureId', 'fixtureGeneration', 'datasetManifestSha256', 'seedMappingSha256', 'syntheticFreshnessAt', 'sourceMode',
  'rowIdentity', 'sourceProjection', 'expectedFacts', 'allFiveIntents', 'financeUnchanged', 'realTimeFreshnessClaim'] as const;
export interface FixtureCheckPayload {
  readonly fixtureId: string; readonly fixtureGeneration: string; readonly datasetManifestSha256: string; readonly seedMappingSha256: string;
  readonly syntheticFreshnessAt: string; readonly sourceMode: 'db'; readonly rowIdentity: boolean; readonly sourceProjection: boolean;
  readonly expectedFacts: boolean; readonly allFiveIntents: boolean; readonly financeUnchanged: boolean; readonly realTimeFreshnessClaim: false;
}
export function decodeFixtureCheck(v: unknown): FixtureCheckPayload {
  const o = exact(v, FIXTURE_CHECK_KEYS);
  if (typeof o.fixtureId !== 'string' || !/^FX(0[1-9]|1[01])$/.test(o.fixtureId)) shapeFail();
  req(isPositiveDec64, o.fixtureGeneration); req(isDigest, o.datasetManifestSha256); req(isDigest, o.seedMappingSha256); req(isTime, o.syntheticFreshnessAt);
  if (o.sourceMode !== 'db' || o.realTimeFreshnessClaim !== false) shapeFail();
  for (const k of ['rowIdentity', 'sourceProjection', 'expectedFacts', 'allFiveIntents', 'financeUnchanged']) req(isBool, o[k]);
  return o as unknown as FixtureCheckPayload;
}
