// ONE effective closure floor for the whole run, shared by voluntary pauses and supervisor DAY/terminal stops. A closure
// receipt (attested owner fence-first pause) must have EXACTLY the four keys, name this admission, paused === 'true', and
// carry a policyVersion and fence epoch that are canonical signed-64-bit decimals strictly above every version ever
// observed and every fence ever confirmed (opening fence included). Anything else — invalid, stale, equal, foreign, extra
// key, unpaused, out of range — is CONTAINMENT_UNCONFIRMED and ABSORBING for the run. History keeps validated numbers only.
const CLOSURE_KEYS = 'admissionId,fenceEpoch,paused,policyVersion';
const DECIMAL = /^[1-9][0-9]{0,18}$/;
const MAX = 9223372036854775807n;
const bounded = (v: unknown): bigint | null => typeof v === 'string' && DECIMAL.test(v) && BigInt(v) <= MAX ? BigInt(v) : null;

export type ClosureKind = 'VOLUNTARY' | 'DAY' | 'TERMINAL';
export interface ClosureEntry {
  readonly seq: number; readonly kind: ClosureKind; readonly result: 'CONFIRMED' | 'CONTAINMENT_UNCONFIRMED';
  readonly policyVersion: string | null; readonly fenceEpoch: string | null;
}

export class ClosureFloor {
  #version = 0n; #fence: bigint; #pauseVersion = 0n; #containment = false; readonly #history: ClosureEntry[] = [];
  constructor(openingFence: string) { this.#fence = BigInt(openingFence); }
  get containment(): boolean { return this.#containment; }
  /** Highest confirmed pause version: a later confirmation must be strictly newer. */
  get pauseVersion(): bigint { return this.#pauseVersion; }
  get history(): readonly ClosureEntry[] { return this.#history.map(e => ({ ...e })); }
  /** Every validated policyVersion seen (confirmation/capability) raises the version floor; never lowered. */
  observe(version: string): void { const v = bounded(version); if (v !== null && v > this.#version) this.#version = v; }

  /** Evaluate one receipt; returns the validated receipt for the supervisor on success, null on containment. */
  evaluate(input: unknown, admissionId: string, kind: ClosureKind): { admissionId: string; paused: true; policyVersion: string; fenceEpoch: string } | null {
    const r = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
    const version = bounded(r?.policyVersion); const fence = bounded(r?.fenceEpoch);
    const ok = !this.#containment && r !== null && Object.keys(r).sort().join() === CLOSURE_KEYS && r.admissionId === admissionId && r.paused === 'true'
      && version !== null && fence !== null && version > this.#version && fence > this.#fence;
    this.#history.push({ seq: this.#history.length + 1, kind, result: ok ? 'CONFIRMED' : 'CONTAINMENT_UNCONFIRMED',
      policyVersion: version === null ? null : String(version), fenceEpoch: fence === null ? null : String(fence) });
    if (!ok) { this.#containment = true; return null; }
    this.#version = version!; this.#fence = fence!; this.#pauseVersion = version!;
    return { admissionId, paused: true, policyVersion: String(version), fenceEpoch: String(fence) };
  }
}
