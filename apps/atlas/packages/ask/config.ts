/**
 * ATLAS_ASK_MODE (docs/stage5/ask/01_SPEC.md "OFF/MOCK boundary", remote amendment docs/stage5/ask/remote/01_SCOPE.md):
 * unset or `off` — no Ask route, parser or browser behavior; `mock` — the local deterministic MOCK journey; `remote` — the
 * ASK-REMOTE V2 routes, DB mode only (fixture startup refuses) and policy-gated: the value is never a spend or data
 * admission, activates no policy and makes no provider call at startup. Any other value, including an empty string, refuses
 * to start.
 */
export type AskMode = 'off' | 'mock' | 'remote';

export function askMode(value: string | undefined): AskMode {
  if (value === undefined || value === 'off') return 'off';
  if (value === 'mock') return 'mock';
  if (value === 'remote') return 'remote';
  throw new Error('ATLAS_ASK_MODE must be unset, off, mock or remote');
}
