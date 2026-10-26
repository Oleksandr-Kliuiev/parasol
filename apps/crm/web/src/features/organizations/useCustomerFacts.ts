import { useQueries, useQuery } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { useCurrentUser } from '../../auth/CurrentUserContext';
import { parseCustomerAttention, parseCustomerFacts, type CustomerFacts } from './customerFactsContract';

/**
 * The facts of the customers the list shows (UX 2026, В6): one read per loaded page of the list (at most 50 ids), never one
 * per row (M33). A page whose read fails or is refused shows its rows without facts, and the list says so.
 */
export function useCustomerFacts(pages: readonly (readonly string[])[]) {
  const user = useCurrentUser();
  const results = useQueries({
    queries: pages.filter((ids) => ids.length > 0).map((ids) => ({
      queryKey: ['organizations', 'facts', user.id, ids] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        parseCustomerFacts((await api.get<unknown>(`/api/v1/customers/organizations/facts${query({ ids: ids.join(',') })}`, signal)).data, ids),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const facts = new Map<string, CustomerFacts>();
  let asOf: string | null = null;
  for (const result of results) {
    if (!result.data) continue;
    asOf = result.data.asOf;
    for (const [id, item] of result.data.facts) facts.set(id, item);
  }
  return { facts, asOf, failed: results.some((result) => result.isError || result.data === null) };
}

/** The customers that need attention now (the attention view), for everyone the person may see or only their own. */
export function useCustomerAttention(mine: boolean) {
  const user = useCurrentUser();
  return useQuery({
    queryKey: ['organizations', 'attention', user.id, mine] as const,
    queryFn: async ({ signal }) => parseCustomerAttention((await api.get<unknown>(`/api/v1/customers/organizations/attention${query({ mine })}`, signal)).data),
    staleTime: 60_000,
    retry: false,
  });
}
