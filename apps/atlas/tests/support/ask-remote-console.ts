import { join } from 'node:path';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { PrismaClient } from '@prisma/client';
import { projectRoot } from './pg-harness.ts';
import { freePort } from './api-process.ts';
import type { RemoteSeams } from '../../packages/ask/remote/secret.ts';

/**
 * ASK-REMOTE R-C TEST-ONLY browser server: the COMPILED production composition (dist AtlasDbModule in ATLAS_ASK_MODE=remote,
 * the opt-in operator console middleware with its Host gate/CSP, installApiParsers) over a real disposable PostgreSQL runtime
 * connection, in this process, with the accepted R-B offline provider seam passed by explicit construction (ScriptedProvider
 * of ask-remote-api.ts). Production never imports this module; no env flag or HTTP path selects a seam. A network trap counts
 * and refuses any https/http2 request or non-loopback TCP/TLS connection made while the server runs (none is expected).
 */
export interface RemoteConsole { base: string; console: string; port: number; blocked(): number; close(): Promise<void> }

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/;
/** The target host of a net/tls connect call, or null for a local socket path / implicit localhost. */
function hostOf(args: unknown[]): string | null {
  const [first, second] = args;
  if (typeof first === 'string') return null;
  if (typeof first === 'number') return typeof second === 'string' ? second : null;
  if (Array.isArray(first)) return hostOf(first);
  if (first && typeof first === 'object') {
    const o = first as { path?: unknown; host?: unknown };
    if (typeof o.path === 'string') return null;
    return typeof o.host === 'string' ? o.host : null;
  }
  return null;
}
function trapNetwork(): { blocked(): number; restore(): void } {
  let blocked = 0;
  const original = { request: https.request, get: https.get, connect: http2.connect, tls: tls.connect, socket: net.Socket.prototype.connect };
  const refuse = (): never => { blocked += 1; throw new Error('ATLAS_TEST_NETWORK_TRAP'); };
  const mutable = (m: object) => m as Record<string, unknown>;
  mutable(https).request = refuse; mutable(https).get = refuse; mutable(http2).connect = refuse;
  mutable(tls).connect = function guarded(this: unknown, ...args: unknown[]) {
    const host = hostOf(args);
    return host !== null && !LOOPBACK.test(host) ? refuse() : (original.tls as (...a: unknown[]) => unknown).apply(this, args);
  };
  net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
    const host = hostOf(args);
    return host !== null && !LOOPBACK.test(host) ? refuse() : (original.socket as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  return { blocked: () => blocked, restore: () => {
    mutable(https).request = original.request; mutable(https).get = original.get; mutable(http2).connect = original.connect;
    mutable(tls).connect = original.tls; net.Socket.prototype.connect = original.socket;
  } };
}

export async function startRemoteConsole(runtimeUrl: string, seams: RemoteSeams): Promise<RemoteConsole> {
  await import('reflect-metadata');
  const dist = (path: string) => import(join(projectRoot, 'dist', path));
  const [{ NestFactory }, { AtlasDbModule }, { installApiParsers }, { prepareOperatorConsole }] = await Promise.all([
    import('@nestjs/core'), dist('apps/api/src/db/app.module.js'), dist('apps/api/src/ask-http.js'), dist('apps/api/src/operator/console.js')]);
  const port = await freePort();
  const trap = trapNetwork();
  const prisma = new PrismaClient({ datasourceUrl: runtimeUrl });
  const app = await NestFactory.create(AtlasDbModule.forDatabase(prisma, 'remote', undefined, seams), { logger: false, bodyParser: false });
  app.use(await prepareOperatorConsole('1', port, join(projectRoot, 'dist', 'operator')));
  installApiParsers(app, 'remote');
  await app.listen(port, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  return { base, console: `${base}/operator/`, port, blocked: trap.blocked,
    close: async () => { try { await app.close(); await prisma.$disconnect(); } finally { trap.restore(); } } };
}
