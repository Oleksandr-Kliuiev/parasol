import { DATASET_MANIFEST_SHA256, isFixtureId, SYNTHETIC_FRESHNESS_AT } from './dataset.ts';
import { isPositiveDec64 } from './scalars.ts';

/**
 * The source-only clock boundary (03 "Explicit source-only freshness exception", rs-b brief §3). The ONE pinned reference
 * of this fixture package is released only for a binding read through the trusted registration that carries exactly the
 * frozen dataset digest, a frozen fixture ID, a positive generation and exactly that reference. It is never an
 * environment/user/model override or a mutable `now`: callers cannot pass another instant. The returned Date may enter ONLY
 * the resource-age projection of the accepted source reader (`readDbSource(..., now)`); every other clock (credential,
 * policy/price/admission expiry, finance day/month, reserve/settle, audit, deadlines, latency, evidence freshness,
 * installedAt) stays real. RS-B uses it in the fixture verifier only; RS-C wires phase1 under the same rule.
 */
export class SourceClockRefused extends Error { constructor() { super('SOURCE_CLOCK_REFUSED'); this.name = 'SourceClockRefused'; } }
export interface BindingClockFacts {
  readonly fixtureId: string; readonly generation: string; readonly syntheticFreshnessAt: string; readonly datasetManifestSha256: string;
}
export function syntheticSourceReference(binding: BindingClockFacts): Date {
  if (!isFixtureId(binding.fixtureId) || !isPositiveDec64(binding.generation) || binding.datasetManifestSha256 !== DATASET_MANIFEST_SHA256
    || binding.syntheticFreshnessAt !== SYNTHETIC_FRESHNESS_AT) throw new SourceClockRefused();
  return new Date(SYNTHETIC_FRESHNESS_AT);
}
