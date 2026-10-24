import type { Prisma } from '@prisma/client';

/** Caller must already be in a scoped transaction. Keep queue eligibility, leases and backoff on one clock domain. */
export const queueClock = async (tx: Prisma.TransactionClient, explicit?: Date): Promise<Date> =>
  explicit ?? (await tx.$queryRaw<{ instant: Date }[]>`SELECT clock_timestamp()::timestamptz(3) AS instant`)[0]!.instant;
