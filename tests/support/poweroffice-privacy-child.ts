import { writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import { POWEROFFICE_MODE_VARIABLE, powerOfficeComposition, testFaultComposition } from '../../packages/poweroffice/composition.ts';
import { admitSync } from '../../packages/poweroffice/admission.ts';
import { recoverPowerOffice } from '../../packages/poweroffice/recovery.ts';
import { syncPowerOffice } from '../../packages/poweroffice/sync.ts';

/**
 * TEST-ONLY child process of tests/pg/poweroffice-privacy.pg.test.ts. It runs real S4-B flows in its own process so the
 * parent can capture its ACTUAL stdout/stderr file descriptors (Prisma engine output included), with a network trap on
 * Node sockets and fetch installed first and proven by a positive self-control against a local synthetic endpoint. It
 * prints nothing; its observations go to the result file named by the parent. Inputs come from the environment the parent
 * passes (runtime DB URL, synthetic bearer tokens) and are never echoed.
 */
const env = process.env;
const seen: string[] = [];
const connect = net.Socket.prototype.connect;
const realFetch = globalThis.fetch;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) { seen.push('socket'); return (connect as (...a: unknown[]) => net.Socket).apply(this, args); } as typeof connect;
globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => { seen.push('fetch'); return realFetch(input, init); }) as typeof realFetch;

const server = http.createServer((_req, res) => { res.setHeader('connection', 'close'); res.end('synthetic'); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/synthetic`)).text();
await new Promise(resolve => server.close(resolve));
const control = [...seen, body];
seen.length = 0;

const prisma = new PrismaClient({ datasources: { db: { url: env.PO_PRIVACY_RUNTIME_URL! } } });
const MOCK = powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' });
const syncer = powerOfficeCredential(env.PO_PRIVACY_SYNCER!);
const bad = testFaultComposition(async call => {
  const page = JSON.parse(JSON.stringify(await call.builtIn())) as { items: Record<string, unknown>[] };
  if (call.ordinal === 2) page.items[0]!.extra = 'x';
  return page;
});
const receipts: string[][] = [];
const errors: Record<string, unknown>[] = [];
const cases: (() => Promise<unknown>)[] = [
  () => syncPowerOffice(prisma, MOCK, syncer, env.PO_PRIVACY_CLIENT!, 'pv-ok'),
  () => syncPowerOffice(prisma, MOCK, syncer, env.PO_PRIVACY_CLIENT!, 'pv-ok'),
  () => syncPowerOffice(prisma, bad, syncer, env.PO_PRIVACY_CLIENT!, 'pv-bad'),
  () => syncPowerOffice(prisma, MOCK, powerOfficeCredential(env.PO_PRIVACY_READER!), env.PO_PRIVACY_CLIENT!, 'pv-ok'),
  () => admitSync(prisma, MOCK, syncer, env.PO_PRIVACY_CLIENT!, 'pv-held'),
  () => syncPowerOffice(prisma, MOCK, syncer, env.PO_PRIVACY_CLIENT!, 'pv-held'),
  () => recoverPowerOffice(prisma, MOCK, syncer, env.PO_PRIVACY_CLIENT!, 'pv-held'),
  () => syncPowerOffice(prisma, MOCK, syncer, env.PO_PRIVACY_CLIENT!, 'po-unbound'),
];
for (const run of cases) {
  try {
    const value = await run();
    receipts.push(Object.keys(value as object).sort());
  } catch (error) {
    const e = error as Error & { code?: unknown; details?: unknown; cause?: unknown };
    errors.push({ code: e.code, message: e.message, details: e.details, cause: e.cause === undefined ? null : 'present', keys: Object.keys(e).sort() });
  }
}
await prisma.$disconnect();
writeFileSync(env.PO_PRIVACY_RESULT!, JSON.stringify({ control, seen, receipts, errors }), { mode: 0o600 });
