import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, query } from './client';

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

  it('leaves a 403 asking to confirm the permissions again to the page, which explains it', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mockFetch(problem(403, { title: 'Forbidden', status: 403, code: 'AUTH_REVERIFY_REQUIRED' }));

    const error = await api.post('/api/v1/billing/runs/r1/approve', {}).catch((e: unknown) => e);

    expect((error as ApiError).code).toBe('AUTH_REVERIFY_REQUIRED');
    expect(assign).not.toHaveBeenCalled();
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
});
