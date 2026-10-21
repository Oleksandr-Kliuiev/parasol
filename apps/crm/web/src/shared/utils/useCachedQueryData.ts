import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Reads what another component's query holds, without becoming an observer of it: the owner keeps its request, its
 * options (retry, refetch, cache time) and its refresh, and this never fetches or changes them.
 */
export function useCachedQueryData<T>(key: QueryKey): T | undefined {
  const client = useQueryClient();
  const hash = JSON.stringify(key);
  const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe(onChange), [client]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is compared by its serialised form
  const read = useCallback(() => client.getQueryData<T>(key), [client, hash]);
  return useSyncExternalStore(subscribe, read, read);
}
