import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, MAINTENANCE_EVENT, query, RequestTimeoutError, REVERIFY_EVENT, reverifyHref } from './client';

function mockFetch(response: Response) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function problem(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('sends the CSRF header and If-Match on writes', async () => {
    const fetch = mockFetch(new Response(JSON.stringify({ id: '1' }), { status: 200, headers: { ETag: '"v2"' } }));

    const result = await api.put('/api/v1/x', { a: 1 }, '"v1"');

    const [, init] = fetch.mock.calls[0]!;
    expect(init.headers['X-CSRF']).toBe('1');
    expect(init.headers['If-Match']).toBe('"v1"');
    expect(init.credentials).toBe('same-origin');
    expect(result.etag).toBe('"v2"');
  });

  it('does not send the CSRF header on reads', async () => {
    const fetch = mockFetch(new Response('[]', { status: 200 }));
    await api.get('/api/v1/x');
    expect(fetch.mock.calls[0]![1].headers['X-CSRF']).toBeUndefined();
  });

  it('turns problem responses into ApiError with field errors', async () => {
    mockFetch(
      new Response(
        JSON.stringify({ title: 'VALIDATION_FAILED', status: 400, code: 'VALIDATION_FAILED', errors: { OrgNumber: ['Invalid'], 'VisitAddress.City': ['Too long'] } }),
        { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    const error = await api.post('/api/v1/x', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_FAILED');
    expect((error as ApiError).fieldErrors).toEqual({ orgNumber: 'Invalid', 'visitAddress.city': 'Too long' });
  });

  it('handles 204 No Content', async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(api.delete('/api/v1/x')).resolves.toEqual({ data: undefined, etag: null });
  });

  it('sends the browser to sign in again when an API call answers 401, and back to this page afterwards', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/billing/runs/r1', search: '?tab=bases', assign });
    mockFetch(problem(401, { title: 'Unauthorized', status: 401 }));

    const error = await api.post('/api/v1/billing/runs/r1/approve', {}).catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(401);
    expect(assign).toHaveBeenCalledWith('/bff/login?returnUrl=%2Fbilling%2Fruns%2Fr1%3Ftab%3Dbases');
  });

  it('asks the page to open the identity confirmation on a 403 AUTH_REVERIFY_REQUIRED, and does not redirect by itself', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mockFetch(problem(403, { title: 'Forbidden', status: 403, code: 'AUTH_REVERIFY_REQUIRED', reverifyUrl: '/bff/login?reverify=1' }));
    const heard = vi.fn();
    window.addEventListener(REVERIFY_EVENT, heard);

    const error = await api.post('/api/v1/billing/runs/r1/approve', {}).catch((e: unknown) => e);
    window.removeEventListener(REVERIFY_EVENT, heard);

    expect((error as ApiError).code).toBe('AUTH_REVERIFY_REQUIRED');
    expect(assign).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toEqual({ url: '/bff/login?reverify=1' });
  });

  it('does not open the confirmation for an ordinary 403', async () => {
    mockFetch(problem(403, { title: 'Forbidden', status: 403 }));
    const heard = vi.fn();
    window.addEventListener(REVERIFY_EVENT, heard);

    await api.post('/api/v1/billing/runs/r1/approve', {}).catch(() => undefined);
    window.removeEventListener(REVERIFY_EVENT, heard);

    expect(heard).not.toHaveBeenCalled();
  });

  it('builds the confirmation address only from the sign-in path and carries this page as the way back', () => {
    expect(reverifyHref('/bff/login?reverify=1', '/billing/runs/r1?tab=bases')).toBe('/bff/login?reverify=1&returnUrl=%2Fbilling%2Fruns%2Fr1%3Ftab%3Dbases');
    // Anything else the server (or a spoofed response) offers is ignored.
    expect(reverifyHref('https://evil.example/login?x=1', '/a')).toBe('/bff/login?reverify=1&returnUrl=%2Fa');
    expect(reverifyHref('//evil.example', '/a')).toBe('/bff/login?reverify=1&returnUrl=%2Fa');
    expect(reverifyHref(undefined, '/a')).toBe('/bff/login?reverify=1&returnUrl=%2Fa');
  });

  it('does not redirect when /bff/user answers 401: the sign-in gate shows its own page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mockFetch(problem(401, { title: 'Unauthorized', status: 401 }));

    await api.get('/bff/user').catch(() => undefined);

    expect(assign).not.toHaveBeenCalled();
  });

  it('builds query strings without empty values', () => {
    expect(query({ search: 'fjord it', status: null, limit: 20, cursor: undefined, flag: false })).toBe('?search=fjord+it&limit=20&flag=false');
    expect(query({ search: '' })).toBe('');
  });

  it('announces a change refused for maintenance, so the banner appears at once (DEV-13)', async () => {
    mockFetch(problem(503, { title: 'MAINTENANCE_READ_ONLY', status: 503, code: 'MAINTENANCE_READ_ONLY', since: '2026-10-04T08:00:00Z' }));
    const heard = vi.fn();
    window.addEventListener(MAINTENANCE_EVENT, heard);
    try {
      const error = await api.post('/api/v1/customers/organizations', { name: 'x' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('MAINTENANCE_READ_ONLY');
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(MAINTENANCE_EVENT, heard);
    }
  });

  it('keeps how long the server asked to wait on a 429', async () => {
    mockFetch(new Response('{}', { status: 429, headers: { 'Retry-After': '17', 'Content-Type': 'application/problem+json' } }));
    const error = await api.post('/api/v1/x', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryAfterSeconds).toBe(17);
  });

  it('reads a Retry-After date and leaves it undefined when absent', async () => {
    mockFetch(new Response('{}', { status: 503, headers: { 'Retry-After': new Date(Date.now() + 30_000).toUTCString() } }));
    const dated = (await api.get('/api/v1/x').catch((e: unknown) => e)) as ApiError;
    expect(dated.retryAfterSeconds).toBeGreaterThan(20);
    expect(dated.retryAfterSeconds).toBeLessThanOrEqual(30);
    mockFetch(new Response('{}', { status: 429 }));
    expect(((await api.get('/api/v1/x').catch((e: unknown) => e)) as ApiError).retryAfterSeconds).toBeUndefined();
  });

  it('reports a request that got no answer as a timeout, not as a failure of the server', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', (_: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
      const pending = api.post('/api/v1/x', {}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await pending).toBeInstanceOf(RequestTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the caller abort without calling it a timeout', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', (_: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const pending = api.get('/api/v1/x', controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(await pending).not.toBeInstanceOf(RequestTimeoutError);
  });
});
