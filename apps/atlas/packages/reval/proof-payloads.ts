import { exact, isDec64, isDigest, isEvidenceRef, isTime, isUuid, req, shapeFail } from './scalars.ts';

/**
 * Exact PLATFORM_PROOF and PRIVACY_PROOF payloads (05 "Egress proof interface", "Privacy proof and destination completeness"; rs-d brief
 * B §2). The decoders enforce the 05 rule for `countsAsVerifiedZero`: true only for a MEASURED interval with complete coverage, zero
 * unknown/unexpected/unmeasured counts and accepted evidence; OFFLINE_SIMULATED is always false. No software flag can manufacture it.
 */
/** The one platform policy reference this implementation can produce for an enforced server process tree (packages/reval/platform.ts). */
export const SERVER_POLICY_REF = 'rsd-seatbelt-s-v2';
export const NO_POLICY_REF = 'rsd-platform-policy-absent-v1';

const PLATFORM_KEYS = ['environmentId', 'buildManifestSha256', 'serverBootId', 'policyEvidenceRef', 'destinationInventorySha256', 'intervalStart', 'intervalEnd',
  'processCoverage', 'destinationCoverage', 'unexpectedDestinationCount', 'unknownDestinationCount', 'unmeasuredProcessCount', 'mode', 'countsAsVerifiedZero'];
export interface PlatformProof {
  readonly environmentId: string; readonly buildManifestSha256: string; readonly serverBootId: string; readonly policyEvidenceRef: string;
  readonly destinationInventorySha256: string; readonly intervalStart: string; readonly intervalEnd: string;
  readonly processCoverage: 'COMPLETE' | 'UNKNOWN'; readonly destinationCoverage: 'COMPLETE' | 'UNKNOWN';
  readonly unexpectedDestinationCount: string; readonly unknownDestinationCount: string; readonly unmeasuredProcessCount: string;
  readonly mode: 'MEASURED' | 'OFFLINE_SIMULATED'; readonly countsAsVerifiedZero: boolean;
}
const coverage = (v: unknown) => { if (v !== 'COMPLETE' && v !== 'UNKNOWN') shapeFail(); };
const modeOf = (v: unknown) => { if (v !== 'MEASURED' && v !== 'OFFLINE_SIMULATED') shapeFail(); };
/** The 05 rule (also what a producer must compute). */
export function platformVerifiedZero(p: Omit<PlatformProof, 'countsAsVerifiedZero'>): boolean {
  return p.mode === 'MEASURED' && p.processCoverage === 'COMPLETE' && p.destinationCoverage === 'COMPLETE' && p.unexpectedDestinationCount === '0'
    && p.unknownDestinationCount === '0' && p.unmeasuredProcessCount === '0' && p.policyEvidenceRef === SERVER_POLICY_REF;
}
export function decodePlatformProof(v: unknown): PlatformProof {
  const o = exact(v, PLATFORM_KEYS);
  req(isUuid, o.environmentId); req(isDigest, o.buildManifestSha256); req(isUuid, o.serverBootId); req(isEvidenceRef, o.policyEvidenceRef);
  req(isDigest, o.destinationInventorySha256); req(isTime, o.intervalStart); req(isTime, o.intervalEnd);
  if ((o.intervalStart as string) > (o.intervalEnd as string)) shapeFail();
  coverage(o.processCoverage); coverage(o.destinationCoverage); modeOf(o.mode);
  for (const k of ['unexpectedDestinationCount', 'unknownDestinationCount', 'unmeasuredProcessCount']) req(isDec64, o[k]);
  if (typeof o.countsAsVerifiedZero !== 'boolean') shapeFail();
  const p = o as unknown as PlatformProof;
  if (p.countsAsVerifiedZero !== platformVerifiedZero(p)) shapeFail();
  return p;
}

const PRIVACY_KEYS = ['environmentId', 'destinationInventorySha256', 'scannerManifestSha256', 'intervalStart', 'intervalEnd', 'coveredDestinationCount',
  'unreadableDestinationCount', 'newUnclassifiedDestinationCount', 'forbiddenContentMatchCount', 'metadataViolationCount', 'collectionState',
  'externalRetentionEvidenceRef', 'mode', 'countsAsVerifiedZero'];
export interface PrivacyProof {
  readonly environmentId: string; readonly destinationInventorySha256: string; readonly scannerManifestSha256: string; readonly intervalStart: string;
  readonly intervalEnd: string; readonly coveredDestinationCount: string; readonly unreadableDestinationCount: string; readonly newUnclassifiedDestinationCount: string;
  readonly forbiddenContentMatchCount: string; readonly metadataViolationCount: string; readonly collectionState: 'DISABLED_AS_REQUIRED' | 'UNKNOWN';
  readonly externalRetentionEvidenceRef: string | null; readonly mode: 'MEASURED' | 'OFFLINE_SIMULATED'; readonly countsAsVerifiedZero: boolean;
}
export function privacyVerifiedZero(p: Omit<PrivacyProof, 'countsAsVerifiedZero'>): boolean {
  return p.mode === 'MEASURED' && p.coveredDestinationCount !== '0' && p.unreadableDestinationCount === '0' && p.newUnclassifiedDestinationCount === '0'
    && p.forbiddenContentMatchCount === '0' && p.metadataViolationCount === '0' && p.collectionState === 'DISABLED_AS_REQUIRED'
    && p.externalRetentionEvidenceRef !== null;
}
export function decodePrivacyProof(v: unknown): PrivacyProof {
  const o = exact(v, PRIVACY_KEYS);
  req(isUuid, o.environmentId); req(isDigest, o.destinationInventorySha256); req(isDigest, o.scannerManifestSha256);
  req(isTime, o.intervalStart); req(isTime, o.intervalEnd);
  if ((o.intervalStart as string) > (o.intervalEnd as string)) shapeFail();
  for (const k of ['coveredDestinationCount', 'unreadableDestinationCount', 'newUnclassifiedDestinationCount', 'forbiddenContentMatchCount', 'metadataViolationCount']) req(isDec64, o[k]);
  if (o.collectionState !== 'DISABLED_AS_REQUIRED' && o.collectionState !== 'UNKNOWN') shapeFail();
  if (o.externalRetentionEvidenceRef !== null) req(isEvidenceRef, o.externalRetentionEvidenceRef);
  modeOf(o.mode);
  if (typeof o.countsAsVerifiedZero !== 'boolean') shapeFail();
  const p = o as unknown as PrivacyProof;
  if (p.countsAsVerifiedZero !== privacyVerifiedZero(p)) shapeFail();
  return p;
}
