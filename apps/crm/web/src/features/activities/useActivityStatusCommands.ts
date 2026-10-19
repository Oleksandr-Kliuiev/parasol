import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { useActivityActions } from './api';
import type { Activity } from './types';
import { captureStatusFocus, type StatusFocusOwner } from './statusFocus';

type Command = 'complete' | 'reopen';
type Outcome = { kind: 'success' | 'conflict' | 'ignored' } | { kind: 'error'; error: unknown };
export interface StatusFocusRequest { id: string; status: 'Open' | 'Done'; owner: StatusFocusOwner }

/** The parent outlives row removal during refresh; each record has one shared status command lock. */
export function useActivityStatusCommands(actions: Pick<ReturnType<typeof useActivityActions>, 'complete' | 'reopen'>,
  { restoreFocus = false, focusBlocked = false }: { restoreFocus?: boolean; focusBlocked?: boolean } = {}) {
  const active = useRef(false);
  const blocked = useRef(focusBlocked);
  useLayoutEffect(() => { blocked.current = focusBlocked; }, [focusBlocked]);
  const pendingRef = useRef(new Set<string>()); const staleRef = useRef(new Map<string, string>());
  const owners = useRef(new Set<StatusFocusOwner>());
  const requested = useRef<StatusFocusRequest | null>(null);
  const [pending, setPending] = useState(new Set<string>()); const [stale, setStale] = useState(new Map<string, string>());
  const [focusRequest, setFocusRequest] = useState<StatusFocusRequest | null>(null);
  useEffect(() => {
    const owned = owners.current;
    active.current = true;
    return () => { active.current = false; for (const owner of owned) owner.dispose(); owned.clear(); };
  }, []);
  const clearFocusRequest = () => {
    requested.current?.owner.dispose(); requested.current = null; setFocusRequest(null);
  };
  const clearConflicts = () => {
    staleRef.current.clear(); setStale(new Map()); clearFocusRequest();
  };
  const consumeFocus = (request: StatusFocusRequest, button: HTMLButtonElement) => {
    if (!active.current || requested.current !== request) { request.owner.dispose(); return; }
    request.owner.restore(button); requested.current = null; setFocusRequest(null);
  };
  const discardFocus = (request: StatusFocusRequest) => {
    request.owner.dispose();
    if (requested.current === request) { requested.current = null; setFocusRequest(null); }
  };
  const run = async (command: Command, activity: Activity, trigger?: HTMLButtonElement): Promise<Outcome> => {
    if (!active.current || pendingRef.current.has(activity.id) || staleRef.current.get(activity.id) === activity.etag) return { kind: 'ignored' };
    if (!activity.etag) {
      staleRef.current.set(activity.id, activity.etag); setStale(new Map(staleRef.current)); return { kind: 'conflict' };
    }
    clearFocusRequest();
    pendingRef.current.add(activity.id); setPending(new Set(pendingRef.current));
    let owner: StatusFocusOwner | null = null;
    if (restoreFocus && trigger && ['Task', 'Call', 'Meeting'].includes(activity.type))
      owner = captureStatusFocus(trigger, () => { if (owner) owners.current.delete(owner); }, () => blocked.current);
    if (owner) owners.current.add(owner);
    try {
      await actions[command].mutateAsync({ id: activity.id, etag: activity.etag });
      if (!active.current) return { kind: 'ignored' };
      if (owner?.canRestore()) {
        clearFocusRequest();
        const request: StatusFocusRequest = { id: activity.id, status: command === 'complete' ? 'Done' : 'Open', owner };
        requested.current = request; setFocusRequest(request);
      }
      else if (owner) { owner.dispose(); owners.current.delete(owner); }
      return { kind: 'success' };
    } catch (error) {
      if (owner) { owner.dispose(); owners.current.delete(owner); }
      if (!active.current) return { kind: 'ignored' };
      if (error instanceof ApiError && error.status === 412) {
        staleRef.current.set(activity.id, activity.etag); setStale(new Map(staleRef.current)); return { kind: 'conflict' };
      }
      return { kind: 'error', error };
    } finally {
      pendingRef.current.delete(activity.id);
      if (active.current) setPending(new Set(pendingRef.current));
    }
  };
  return { run, clearConflicts, focusRequest, consumeFocus, discardFocus, pending, isStale: (activity: Activity) => stale.get(activity.id) === activity.etag };
}
