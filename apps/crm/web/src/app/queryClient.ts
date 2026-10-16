import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';

export const queryClient = new QueryClient({
  defaultOptions: {
    // TanStack Query pauses a request while the browser says it is offline and sends it when the connection returns: a save
    // would then wait in silence and go out later, perhaps after the user changed their mind. Send now and report the failure.
    mutations: { networkMode: 'always' },
    queries: {
      networkMode: 'always',
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Client errors (403, 404, 412…) will not succeed on retry.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
    },
  },
});
