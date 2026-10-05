import { describe, expect, it } from 'vitest';
import { ApiError, RequestTimeoutError } from '../../api/client';
import { errorMessage } from './errors';

const t = (key: string, options?: Record<string, unknown>) => (options?.seconds !== undefined ? `${key}:${String(options.seconds)}` : key);

describe('errorMessage', () => {
  it('tells how long to wait after a 429', () => {
    expect(errorMessage(new ApiError(429, {}, 12), t)).toBe('errors.rateLimited:12');
    expect(errorMessage(new ApiError(429, {}), t)).toBe('errors.rateLimitedNoWait');
  });
  it('says a timed out change may have been saved', () => {
    expect(errorMessage(new RequestTimeoutError(), t)).toBe('errors.timeout');
  });
  it('tells offline from an unreachable server', () => {
    const online = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    expect(errorMessage(new TypeError('Failed to fetch'), t)).toBe('errors.offline');
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    expect(errorMessage(new TypeError('Failed to fetch'), t)).toBe('errors.network');
    if (online) Object.defineProperty(Navigator.prototype, 'onLine', online);
  });
  it('treats 412 as a conflict', () => {
    expect(errorMessage(new ApiError(412, {}), t)).toBe('errors.concurrency');
  });
});
