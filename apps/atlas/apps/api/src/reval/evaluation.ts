import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HttpException } from '@nestjs/common';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { RemoteSeams } from '../../../../packages/ask/remote/secret.ts';
import { askTarget } from '../../../../packages/ask/input.ts';
import { SESSION_HEADER } from '../../../../packages/reval/eval-gate.ts';
import { readRegistration } from '../../../../packages/reval/eval-db.ts';
import { HandoffSocketServer } from '../../../../packages/reval/eval-handoff-socket.ts';
import type { HandoffSocketDeps } from '../../../../packages/reval/eval-handoff-socket.ts';
import { evaluationHandoffRoute } from '../../../../packages/reval/eval-handoff-route.ts';
import { EvaluationRuntime } from '../../../../packages/reval/eval-runtime.ts';
import type { GuardCensus } from '../../../../packages/reval/eval-census.ts';
import { runPeerHelper, verifyHelperBinary } from '../../../../packages/reval/peer.ts';
import { BRIDGE_EXIT } from './bridge.ts';
import type { RevalBridge } from './bridge.ts';
import { loadOperatorAssets } from '../operator/assets.ts';
import type { OperatorAssets } from '../operator/assets.ts';
import { OPERATOR_HEADERS, operatorMiddleware } from '../operator/http.ts';

/** RS-C-C: the sealed measured console build (scripts/operator-measured-build.ts), next to dist/apps — never the ordinary one. */
export const MEASURED_CONSOLE_DIR = fileURLToPath(new URL('../../../../operator-measured/', import.meta.url));
const consolePath = (path: string) => path === '/operator' || path.startsWith('/operator/');
/** The fixed 400 for the evaluation header where it is forbidden (04 "never silently ignored"). */
function headerRefusal(): { body: string; correlationId: string } {
  const correlationId = randomUUID();
  return { correlationId, body: JSON.stringify({ contractVersion: 'AskErrorV1', code: 'ASK_REQUEST_INVALID', correlationId }) };
}
const refusalHeaders = (res: ServerResponse, correlationId: string) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Atlas-Correlation-Id', correlationId); res.setHeader('Connection', 'close');
};
/** Marks a request that carries the evaluation header on a path that is neither an Ask shape nor the handoff route. */
const HEADER_ELSEWHERE = Symbol('reval-evaluation-header-elsewhere');
/**
 * RS-C-C (RS-A-C review N1): a RECOGNIZED Nest route answers the marked request with the fixed 400; guards run only for matched
 * routes, so an unrecognized path keeps the ordinary 404 exactly as without the header.
 */
class EvaluationHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    if ((http.getRequest() as Record<symbol, unknown>)[HEADER_ELSEWHERE] !== true) return true;
    const { body, correlationId } = headerRefusal();
    refusalHeaders(http.getResponse() as ServerResponse, correlationId);
    throw new HttpException(JSON.parse(body) as Record<string, unknown>, 400);
  }
}

/**
 * RS-C-A review F1: the provider key pass-through into the bridge server is a PENDING owner decision. Until it is decided and
 * reviewed, the bridge server's provider seams can NEVER resolve a key — whatever Prisma's dotenv loading or anything else puts
 * into process.env — and the transport refuses if it were ever reached. Every evaluation question stays NO_DISPATCH.
 */
export function bridgeRemoteSeams(): RemoteSeams {
  return Object.freeze({ resolveSecret: () => null, transport: () => { throw new Error('REVAL_BRIDGE_TRANSPORT_DISABLED'); } });
}

/**
 * R-EVAL RS-C-A bridge-mode composition (rs-c/IMPLEMENTATION_BRIEF.md §2–§4), shared by main.ts and test entries so they cannot
 * diverge: the registration from the measured launch (runtime column SELECT; exact equality or exit), the evaluation hub, the
 * pinned-helper-verified measured S<->I socket at the owner's path, the handoff route BEFORE any generic body parser, and the
 * hub attached to the bridge. The caller passes `runtime.gate` to installApiParsers. Registration failure exits the process.
 */
export async function composeEvaluation(o: { app: INestApplication; db: PrismaClient; bridge: RevalBridge; port: number;
  peer?: HandoffSocketDeps['peer']; consoleDir?: string; census?: GuardCensus }): Promise<EvaluationRuntime> {
  const l = o.bridge.launch;
  let runtime: EvaluationRuntime;
  // RS-C-C: the measured console is part of the bridge server; missing/inconsistent assets exit before anything listens.
  let assets: OperatorAssets;
  try { assets = await loadOperatorAssets(o.consoleDir ?? MEASURED_CONSOLE_DIR); } catch { process.exit(BRIDGE_EXIT.CONSOLE); }
  try {
    const reg = await readRegistration(o.db, l.workspaceId, l.registrationId, l.databaseInstanceId);
    runtime = new EvaluationRuntime({ reg, serverBootId: l.serverBootId, port: o.port, db: o.db,
      clock: { mono: () => performance.now(), wall: () => Date.now() }, ...(o.census ? { census: o.census } : {}) });
    await verifyHelperBinary(l.nativePeerHelper, l.nativePeerHelperSha256);
  } catch { process.exit(BRIDGE_EXIT.REGISTRATION); }
  const node = realpathSync(process.execPath);
  const peer = o.peer ?? (socket => runPeerHelper(l.nativePeerHelper, socket, node));
  const sockets = new HandoffSocketServer(l.handoffSocketPath, runtime, { peer }, [process.pid, process.ppid]);
  await sockets.listen();
  process.once('exit', () => sockets.close());
  o.app.getHttpServer().once('close', () => sockets.close());
  // RS-C-C (review rc1 F1): the measured console is served, so the ACCEPTED console boundary applies to EVERY request as on the
  // console-enabled ordinary server (03_SECURITY_AND_STATE): exact Host before any static/API dispatch (DNS-rebinding defence, 421)
  // and the security headers (no-store, CSP, …) on every response. Console paths get the same gate in the asset step below, after
  // the evaluation-header rule, so the header still answers its fixed 400 there.
  const serveConsole = operatorMiddleware(o.port, assets);
  o.app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => consolePath((req.url ?? '').split('?')[0]!) ? next() : serveConsole(req, res, next));
  // rc2 F11 (04 "forbidden on capability/other methods/routes … never silently ignored"), refined in RS-C-C (RS-C-A review N1):
  // the Ask gate (question/capability shapes, and their ordinary HEAD/OPTIONS rejection) and the handoff route decide for
  // themselves; the measured console paths and every recognized Nest route answer a fixed 400; an unrecognized route stays 404.
  o.app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.headers[SESSION_HEADER] === undefined) return next();
    const path = (req.url ?? '').split('?')[0]!;
    if (askTarget(req.method, req.url) !== null || path.endsWith('/ask/evaluation-handoff')) return next();
    if (consolePath(path)) {
      // RS-D-C (RS-C-C review N2): the console boundary applies to this refusal too — its security headers, and the exact Host
      // (DNS-rebinding defence, 421) before the fixed 400.
      for (const [name, value] of Object.entries(OPERATOR_HEADERS)) res.setHeader(name, value);
      let hosts = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === 'host') hosts += 1;
      if (hosts !== 1 || req.headers.host !== `127.0.0.1:${o.port}`) {
        res.statusCode = 421; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return void res.end('Misdirected Request');
      }
      const { body, correlationId } = headerRefusal();
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json; charset=utf-8'); refusalHeaders(res, correlationId); return void res.end(body);
    }
    (req as unknown as Record<symbol, unknown>)[HEADER_ELSEWHERE] = true;
    return next();
  });
  o.app.useGlobalGuards(new EvaluationHeaderGuard());
  // The sealed measured console at /operator/: the accepted gate, headers and exact assets (from memory) for those paths.
  o.app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => consolePath((req.url ?? '').split('?')[0]!) ? serveConsole(req, res, next) : next());
  o.app.use(evaluationHandoffRoute(runtime, o.port, o.db));
  o.bridge.attach(runtime);
  return runtime;
}
