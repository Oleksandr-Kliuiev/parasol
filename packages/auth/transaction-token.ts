import type { Prisma } from '@prisma/client';

/**
 * Shared transaction-local bearer lookup (docs/stage4/02_CONTRACTS.md "Authentication and permissions"), extracted verbatim
 * from the accepted Stage 3 admission (packages/actions/authority.ts) so that Stage 3 actions and the Stage 4 PowerOffice
 * authority read the CURRENT token through exactly the same accepted path: only the ApiToken_lookup policy
 * (app.token_hash = the SHA-256 digest) makes the row visible, revocation and the exact nullable expiry are compared with
 * the DB clock (clock_timestamp in UTC), and the digest is cleared again before anything else runs. No new credential
 * visibility, view or definer; the caller never supplies an Actor, a token row or a clock.
 */

/** Transaction-local settings (set_config(…, true)); every GUC of an admission stays local to its transaction. */
export const setLocal = (tx: Prisma.TransactionClient, settings: Record<string, string>) =>
  tx.$executeRawUnsafe(`SELECT ${Object.keys(settings).map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(', ')}`,
    ...Object.entries(settings).flat());

/** Timestamps without time zone hold UTC (codebase convention); the DB clock is compared in UTC, read after the locks. */
export async function currentToken(tx: Prisma.TransactionClient, hash: string) {
  await setLocal(tx, { 'app.token_hash': hash });
  const rows = await tx.$queryRaw<{ id: string; workspaceId: string; actorId: string; expiresAt: Date | null; now: Date }[]>`
    SELECT id, "workspaceId", "actorId", "expiresAt", clock_timestamp() AS now FROM public."ApiToken"
     WHERE "tokenHash" = ${hash} AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC'))`;
  await setLocal(tx, { 'app.token_hash': '' });
  return rows.length === 1 ? rows[0]! : null;
}
