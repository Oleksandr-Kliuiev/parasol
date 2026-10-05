/**
 * Guards the automatic sign-in redirect against a loop (the sign-in succeeds, the session is refused straight away, the
 * app asks to sign in again…). Attempts are counted in the tab's session storage for a minute; a fourth attempt is not made.
 */
const KEY = 'crm.loginAttempts';
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 3;

function recentAttempts(now: number): number[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return (raw ? (JSON.parse(raw) as number[]) : []).filter((at) => now - at < WINDOW_MS);
  } catch {
    return []; // Storage may be blocked; then the redirect goes ahead as before.
  }
}

/** True when the tab has already been sent to sign in too often in the last minute. */
export function loginAttemptsExhausted(now = Date.now()): boolean {
  return recentAttempts(now).length >= MAX_ATTEMPTS;
}

/** Registers one sign-in redirect; returns false (and registers nothing) when the attempts are exhausted. */
export function registerLoginAttempt(now = Date.now()): boolean {
  const previous = recentAttempts(now);
  if (previous.length >= MAX_ATTEMPTS) return false;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify([...previous, now]));
  } catch {
    // Not counted when storage is blocked.
  }
  return true;
}

export function resetLoginAttempts(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // nothing to reset
  }
}
