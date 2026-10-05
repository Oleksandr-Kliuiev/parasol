import { beforeEach, describe, expect, it } from 'vitest';
import { registerLoginAttempt, resetLoginAttempts } from './loginAttempts';

describe('registerLoginAttempt', () => {
  beforeEach(() => resetLoginAttempts());

  it('allows three sign-in redirects within a minute and refuses the fourth', () => {
    const t0 = 1_000_000;
    expect(registerLoginAttempt(t0)).toBe(true);
    expect(registerLoginAttempt(t0 + 1_000)).toBe(true);
    expect(registerLoginAttempt(t0 + 2_000)).toBe(true);
    expect(registerLoginAttempt(t0 + 3_000)).toBe(false);
  });

  it('forgets attempts older than a minute and after a reset', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) registerLoginAttempt(t0 + i);
    expect(registerLoginAttempt(t0 + 61_000)).toBe(true);
    resetLoginAttempts();
    for (let i = 0; i < 3; i++) expect(registerLoginAttempt(t0 + 70_000 + i)).toBe(true);
  });
});
