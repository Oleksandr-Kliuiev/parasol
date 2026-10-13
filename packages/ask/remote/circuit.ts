/**
 * Local configuration-fault circuit of ONE API process (docs/stage5/ask/remote/03/04): a model/tier/usage mismatch or an
 * upstream 401/403 closes the workspace circuit synchronously at detection, before settlement or the durable pause, so this
 * process starts no new remote work for that workspace (phase1 and immediately before dispatch). A durable pause that
 * commits records its resulting policyVersion; the circuit reopens only for a LATER owner revision (current policyVersion
 * greater than that pause). A failed or unknown pause records nothing: the workspace stays refused until restart (a pause
 * failure never opens local calls). Other processes are covered only by the durable pause and final publication rechecks.
 */
interface Entry { pausedVersion: bigint | null; trippedAt: bigint }
export class RemoteCircuit {
  readonly #entries = new Map<string, Entry>();
  /** Closes the workspace circuit for a fault of an attempt admitted under `attemptVersion`. */
  trip(workspaceId: string, attemptVersion: bigint): void {
    const entry = this.#entries.get(workspaceId);
    if (entry && (entry.pausedVersion === null || attemptVersion <= entry.pausedVersion)) return;
    this.#entries.set(workspaceId, { pausedVersion: null, trippedAt: attemptVersion });
  }
  /** A committed durable pause (or a no-op on an already inactive policy) at `version`. */
  paused(workspaceId: string, version: bigint): void {
    const entry = this.#entries.get(workspaceId);
    if (entry && (entry.pausedVersion === null || version > entry.pausedVersion) && version > entry.trippedAt) entry.pausedVersion = version;
  }
  /** False while the workspace circuit is closed for this current policyVersion. */
  allows(workspaceId: string, currentVersion: bigint): boolean {
    const entry = this.#entries.get(workspaceId);
    if (!entry) return true;
    if (entry.pausedVersion === null || currentVersion <= entry.pausedVersion) return false;
    this.#entries.delete(workspaceId);
    return true;
  }
  get size(): number { return this.#entries.size; }
}
