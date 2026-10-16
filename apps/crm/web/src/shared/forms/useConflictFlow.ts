import { useEffect, useRef, useState } from 'react';
import { compareWithLatest, rebase } from './diff';
import type { ConflictDetails } from './ConflictBar';

function show(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (typeof value === 'object') {
    const named = (value as { displayName?: unknown }).displayName;
    return typeof named === 'string' ? named : JSON.stringify(value);
  }
  return String(value);
}

interface ConflictFlowOptions<T> {
  /** The 412 the last save was refused with, or null; a new error starts a new comparison. */
  conflict: unknown;
  /** The values the form was loaded with. */
  base: T;
  /** The values on screen now. */
  getMine: () => T;
  /** Reads the record as it is now, without touching the cached one the form is keyed by. */
  readLatest: () => Promise<T>;
  /** Label of a field path, in the user's language. */
  labelOf: (path: string) => string;
}

/**
 * Behind a 412: reads the latest version once, tells which fields both sides changed, and builds the draft laid over the
 * latest version for "keep mine". Nothing is saved here; the user reviews the result and saves again.
 */
export function useConflictFlow<T>({ conflict, base, getMine, readLatest, labelOf }: ConflictFlowOptions<T>) {
  const [state, setState] = useState<{ conflict: unknown; details: ConflictDetails } | null>(null);
  const latest = useRef<T | null>(null);
  const options = useRef({ base, getMine, readLatest, labelOf });
  useEffect(() => {
    options.current = { base, getMine, readLatest, labelOf };
  });

  useEffect(() => {
    latest.current = null;
    if (conflict === null || conflict === undefined) return;
    let cancelled = false;
    void (async () => {
      const { base: b, getMine: mine, readLatest: read, labelOf: label } = options.current;
      try {
        const current = await read();
        if (cancelled) return;
        latest.current = current;
        const result = compareWithLatest(b, mine(), current);
        setState({
          conflict,
          details: {
            conflicts: result.conflicts.map((c) => ({ label: label(c.path), mine: show(c.mine), theirs: show(c.theirs) })),
            changedByOthers: result.changedByOthers.map(label),
          },
        });
      } catch {
        if (!cancelled) setState({ conflict, details: { conflicts: [], changedByOthers: [] } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conflict]);

  const keepMine = (): T | null => (latest.current === null ? null : rebase(options.current.base, options.current.getMine(), latest.current));
  return { details: state !== null && state.conflict === conflict ? state.details : null, keepMine };
}
