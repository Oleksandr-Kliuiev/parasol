import { dirname, join } from 'node:path';
import type { FailureCode } from './codes.ts';
import { bounded } from './deadline.ts';
import type { OwnerConfig } from './config.ts';
import type { InstrumentResult } from './eval-instrument-link.ts';
import type { QueryClient } from './physical.ts';
import { composePlatformProof, destinationInventorySha256 } from './platform.ts';
import { composePrivacyProof, loadCanaries, readPgLogging, scanConfigDirectory } from './privacy-scan.ts';
import type { Canaries } from './privacy-scan.ts';
import type { ServerLink } from './server-link.ts';

/**
 * C's closed local evidence adapters for PLATFORM_PROOF and PRIVACY_PROOF (06: O→C, I→C, CONTROLLER; rs-d brief B §2.3–§2.4). The
 * platform interval runs from C's verification of S (sandbox enforced, before it listened) to the proof instant; the privacy scan is ONE
 * point-in-time scan at the proof instant (rc2 N5), reported over the same interval. Both proofs are honest about
 * this platform: destination coverage UNKNOWN, unenforced components counted, declared destinations outside C counted unreadable,
 * no external-retention evidence — so neither can be a verified zero here. A missing/unverified S is a fixed FAILURE, not a proof.
 */
export interface ProofHooks {
  server(): ServerLink | null;
  readonly config: OwnerConfig; readonly configPath: string; readonly serverBootId: string;
  buildManifestSha256(): string | null;
  /** The bound confined reader (null = unavailable by `until`). */
  reader(until: number): Promise<QueryClient | null>;
  /** `until` (C's clock) as an absolute performance.now() deadline for `bounded`. */
  deadline(until: number): number;
  wallIso(): string;
}
const fail = (code: FailureCode): InstrumentResult => ({ kind: 'FAILURE', payload: { code }, emitter: 'CONTROLLER' });
export class ProofLink {
  readonly #h: ProofHooks;
  #canaries: Canaries | null = null;
  constructor(hooks: ProofHooks) { this.#h = hooks; }
  async platform(): Promise<InstrumentResult> {
    const s = this.#h.server(); const build = this.#h.buildManifestSha256();
    if (!s || !s.verifiedAt || build === null) return fail('PLATFORM_UNVERIFIED');
    const enforced = await s.enforcedNow();
    const dir = dirname(this.#h.configPath);
    const proof = composePlatformProof({ registrationId: this.#h.config.registrationId, buildManifestSha256: build, serverBootId: this.#h.serverBootId, enforced,
      inventorySha256: destinationInventorySha256({ apiPort: this.#h.config.server.port, endpoint: this.#h.config.endpoint,
        unixSockets: [join(dir, 'reval-instrument.sock'), join(dir, 'reval-handoff.sock')] }), intervalStart: s.verifiedAt, intervalEnd: this.#h.wallIso() });
    return { kind: 'PLATFORM_PROOF', payload: proof, emitter: 'CONTROLLER' };
  }
  async privacy(until: number): Promise<InstrumentResult> {
    const s = this.#h.server();
    if (!s || !s.verifiedAt) return fail('PRIVACY_UNVERIFIED');
    try {
      this.#canaries ??= loadCanaries();
      const reader = await this.#h.reader(until);
      const logging = reader ? await bounded(readPgLogging(reader, this.#h.config.roles), this.#h.deadline(until)).catch(() => null) : null;
      const f = this.#h.config.secretFiles; // never opened by the scan (frozen 01; rc2 F1)
      const proof = composePrivacyProof({ registrationId: this.#h.config.registrationId, intervalStart: s.verifiedAt, intervalEnd: this.#h.wallIso(),
        canaries: this.#canaries, scan: scanConfigDirectory(this.#h.configPath, this.#canaries, [f.owner, f.runtime, f.reader]), logging });
      return { kind: 'PRIVACY_PROOF', payload: proof, emitter: 'CONTROLLER' };
    } catch { return fail('PRIVACY_UNVERIFIED'); }
  }
}
