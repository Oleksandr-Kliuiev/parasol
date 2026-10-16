import { AtlasError } from '../core/contracts.ts';

/**
 * Exact mapping of known database failures to fixed codes (docs/stage3/02_CONTRACTS.md "Public output and fixed errors").
 * The fence trigger raises SQLSTATE AT001 (ACTION_FENCE_NOT_READY) when the workspace fence row is missing or the fence
 * surface refuses; accepted bind, Stage 1 activation, M365 activation, m365-disable and the owner seed map exactly that
 * failure to ACTION_FENCE_NOT_READY and never pass SQL diagnostics on. Deadlock/serialization aborts (40P01/40001,
 * Prisma P2034) are ACTION_DB_CONFLICT on action paths.
 */
export const FENCE_NOT_READY_SQLSTATE = 'AT001';

/** SQLSTATE of a pg or Prisma (raw P2010, or engine-reported) failure, when one is present. */
export function sqlState(error: unknown): string | undefined {
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown; clientVersion?: unknown } | null;
  if (!e || typeof e !== 'object') return undefined;
  // A Prisma error's own code (P2010, P2034…) is not a SQLSTATE; a pg driver error's code is.
  if (e.clientVersion === undefined && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  if (typeof e.meta?.code === 'string') return e.meta.code;
  const message = String(e.message ?? '');
  return /\bcode: "([0-9A-Z]{5})"/.exec(message)?.[1] ?? /Code: `([0-9A-Z]{5})`/.exec(message)?.[1];
}
export const isFenceNotReady = (error: unknown): boolean => sqlState(error) === FENCE_NOT_READY_SQLSTATE;
export const isDbConflict = (error: unknown): boolean => {
  const state = sqlState(error);
  return state === '40P01' || state === '40001' || (error as { code?: unknown } | null)?.code === 'P2034';
};
/** The fixed ACTION_FENCE_NOT_READY error for the exact fence failure; any other error unchanged. */
export function mapFenceError(error: unknown): unknown {
  return isFenceNotReady(error) ? new AtlasError('ACTION_FENCE_NOT_READY', 'PERMANENT') : error;
}
