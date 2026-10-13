/**
 * Absolute operation deadlines (brief §6/§9: one 1800 ms controller budget per operation, delivered before O's 2 s). Every
 * awaited step of an RS-A operation is bounded by the SAME absolute instant on performance.now(). A step that is still
 * running when its deadline passes is abandoned, never awaited again: `bounded()` hands a late VALUE to `dispose` (for
 * example to destroy a late database client) so an abandoned step can never deliver a resource or a result afterwards.
 * Work that must stop as well (an in-flight query) is cancelled by its owner destroying the underlying connection.
 */
export class DeadlineExceeded extends Error {
  constructor() { super('DEADLINE_EXCEEDED'); this.name = 'DeadlineExceeded'; }
}
/** Milliseconds left until `until` (absolute performance.now()), floored; ≤ 0 means expired. */
export const msLeft = (until: number): number => Math.floor(until - performance.now());

/** Resolves/rejects like `work` if it settles before `until`; otherwise rejects with DeadlineExceeded and disposes a late value. */
export function bounded<T>(work: Promise<T>, until: number, dispose?: (late: T) => void): Promise<T> {
  const left = until - performance.now();
  if (left <= 0) {
    work.then(v => dispose?.(v), () => undefined);
    return Promise.reject(new DeadlineExceeded());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new DeadlineExceeded()); }, left);
    work.then(
      v => { if (settled) { dispose?.(v); return; } settled = true; clearTimeout(timer); resolve(v); },
      e => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
  });
}
