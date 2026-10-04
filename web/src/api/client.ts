// Thin fetch wrapper for the BFF: cookie session, CSRF header, ETags and RFC 9457 problem responses.

export interface Problem {
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  errors?: Record<string, string[]>;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(problem.detail ?? problem.title ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem.code ?? problem.title;
    this.problem = problem;
  }

  /** Field errors from a validation problem, keyed by lower-camel-case path (e.g. `visitAddress.city`). */
  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, messages] of Object.entries(this.problem.errors ?? {})) {
      const path = key
        .split('.')
        .map((part) => part.charAt(0).toLowerCase() + part.slice(1))
        .join('.');
      if (messages[0]) result[path] = messages[0];
    }
    return result;
  }
}

export interface ApiResponse<T> {
  data: T;
  etag: string | null;
}

interface RequestOptions {
  body?: unknown;
  ifMatch?: string | null;
  signal?: AbortSignal;
}

export const CSRF_HEADER = 'X-CSRF';

/** Fired when the server refused a change because the CRM is read-only for maintenance (DEV-13): the banner asks again. */
export const MAINTENANCE_EVENT = 'crm:maintenance';

export function loginUrl(returnUrl = window.location.pathname + window.location.search): string {
  return `/bff/login?returnUrl=${encodeURIComponent(returnUrl)}`;
}

async function request<T>(method: string, url: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.ifMatch) headers['If-Match'] = options.ifMatch;

  const response = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    let problem: Problem = { status: response.status };
    try {
      problem = { ...problem, ...((await response.json()) as Problem) };
    } catch {
      // Non-JSON error body.
    }
    // DEV-10: the session ended on the server (signed out elsewhere, account deactivated, roles not confirmed for too long):
    // the user signs in again and comes back to this page.
    if (response.status === 401 && url.startsWith('/api/')) window.location.assign(loginUrl());
    if (problem.code === 'MAINTENANCE_READ_ONLY') window.dispatchEvent(new Event(MAINTENANCE_EVENT));
    throw new ApiError(response.status, problem);
  }

  const etag = response.headers.get('ETag');
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return { data: undefined as T, etag };
  }
  const text = await response.text();
  return { data: (text ? JSON.parse(text) : undefined) as T, etag };
}

/** Downloads a file response (e.g. an Excel export) with the session cookie, keeping the server's file name. */
export async function download(url: string): Promise<void> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    let problem: Problem = { status: response.status };
    try {
      problem = { ...problem, ...((await response.json()) as Problem) };
    } catch {
      // Non-JSON error body.
    }
    // DEV-10: the session ended on the server (signed out elsewhere, account deactivated, roles not confirmed for too long):
    // the user signs in again and comes back to this page.
    if (response.status === 401 && url.startsWith('/api/')) window.location.assign(loginUrl());
    throw new ApiError(response.status, problem);
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const fileName = encoded ? decodeURIComponent(encoded) : (plain ?? 'download');

  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export const api = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>('GET', url, { signal }),
  post: <T>(url: string, body?: unknown, ifMatch?: string | null) => request<T>('POST', url, { body, ifMatch }),
  put: <T>(url: string, body: unknown, ifMatch?: string | null) => request<T>('PUT', url, { body, ifMatch }),
  delete: <T = void>(url: string, ifMatch?: string | null) => request<T>('DELETE', url, { ifMatch }),
};

export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
