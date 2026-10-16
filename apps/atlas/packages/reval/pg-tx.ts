import pg from 'pg';
import type { Prisma } from '@prisma/client';
import type { QueryClient } from './physical.ts';

/**
 * The verifier's view of ONE physically bound pg connection as the minimal Prisma TransactionClient surface the accepted
 * source reader uses (`$queryRaw(Prisma.sql…)`, and `$executeRawUnsafe` for the phase runner's transaction-local
 * statement_timeout). The SQL text and values are exactly Prisma's own rendering (`Sql.text` / `Sql.values`), so
 * `packages/ask/read.ts` runs unchanged. Values are decoded like Prisma's raw queries: `timestamp without time zone` is
 * UTC (UTC_TYPES — node-postgres would read it as local time), everything else keeps the driver's decoding. No other
 * method exists: a model delegate or `$transaction` call fails loudly instead of opening another connection.
 */
const TIMESTAMP_OID = 1114;
const parseUtc = (v: string): Date => new Date(`${v.replace(' ', 'T')}Z`);
export const UTC_TYPES = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => (oid === TIMESTAMP_OID && format !== 'binary' ? parseUtc
    : pg.types.getTypeParser(oid, format ?? 'text'))) as pg.CustomTypesConfig['getTypeParser'],
} as pg.CustomTypesConfig;

export function rawTransaction(c: QueryClient): Prisma.TransactionClient {
  const tx = {
    $queryRaw: async (sql: Prisma.Sql): Promise<unknown[]> => (await c.query(sql.text, sql.values as unknown[])).rows,
    $executeRawUnsafe: async (text: string, ...values: unknown[]): Promise<number> =>
      ((await c.query(text, values)) as unknown as { rowCount?: number | null }).rowCount ?? 0,
  };
  return tx as unknown as Prisma.TransactionClient;
}
