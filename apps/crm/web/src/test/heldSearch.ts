import { act, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';

type Answer = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * A fetch that holds back the answers to the requests `held` picks (the reads of a search) until `answer` lets them in, and gives
 * every other request to `others`: a test sees a list while its search is read, then gives the search its answer. A search is read
 * after a pause in typing; a click on a row must not get lost while its answer is on the way (M42 e2e, Firefox).
 */
export function holdSearch(held: (url: string) => boolean, others: Answer) {
  const waiting: Array<{ url: string; resolve: (response: Response) => void }> = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    return held(url) ? new Promise<Response>((resolve) => { waiting.push({ url, resolve }); }) : others(url, init);
  });
  return {
    fetch,
    /** Waits until the held search has been asked for, so the list is being read: 300 ms after typing, later on a busy machine. */
    requested: () => waitFor(() => expect(waiting.length).toBeGreaterThan(0), { timeout: 5_000 }),
    /** Answers every held request with `body`, or with what `body` gives for its address. */
    answer: (body: unknown) => act(async () => {
      waiting.splice(0).forEach(({ url, resolve }) => resolve(new Response(
        JSON.stringify(typeof body === 'function' ? (body as (url: string) => unknown)(url) : body),
        { status: 200, headers: { 'Content-Type': 'application/json' } })));
    }),
  };
}
