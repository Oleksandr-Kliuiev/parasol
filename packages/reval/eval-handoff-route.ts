import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { bearerCredential, credentialDigest } from '../ask/credential.ts';
import { parseStrictJson } from '../ask/remote/json.ts';
import type { FailureCode } from './codes.ts';
import { handoffAuthority } from './eval-db.ts';
import { SESSION_HEADER } from './eval-gate.ts';
import { decodeHandoffRequest, HANDOFF_V1, handoffErrorBody, handoffStatus, PAIR_BODY_CAP, RESPONSE_BODY_CAP } from './eval-handoff-dto.ts';
import type { EvaluationRuntime } from './eval-runtime.ts';
import { isToken } from './eval-wire.ts';

/**
 * `POST /clients/:id/ask/evaluation-handoff` of the measured registered server (04 "Pairing and arm", "The server must bind the
 * actual values", "Ingress and threat coverage"; 06 "Closed codes"). Only the registered client's exact path and POST exist;
 * everything else is the ordinary 404. Header checks (exact same-origin Host/Origin, Fetch Metadata same-origin, JSON media,
 * no encoding/query, declared length) precede any body read; the body is read ≤288 KiB with fatal UTF-8 and strict JSON
 * (duplicate keys rejected); bearer authority is current and exactly the registered workspace/actor/client with
 * context:read+ask:remote; RESPONSE also needs the pair's own credential and the bounded policy/fixture recheck (a denial or
 * change revokes the pair); ONE independent 2 s deadline from receipt bounds the body read, every DB read and the transfer. Replies: PAIR200, 204, or RevalBrowserHandoffErrorV1 —
 * always no-store, never a body/secret echo, no redirect, no CORS.
 */
const SUFFIX = '/ask/evaluation-handoff';
type Handler = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
const HANDOFF_MS = 2000;

function reply(res: ServerResponse, status: number, body: string | null): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (body !== null) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Length', String(Buffer.byteLength(body))); }
  res.setHeader('Connection', 'close');
  res.end(body ?? undefined);
}
const fail = (res: ServerResponse, code: FailureCode) => reply(res, handoffStatus(code), handoffErrorBody(code));
function notFound(res: ServerResponse): void {
  res.statusCode = 404; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ message: 'Not Found', statusCode: 404 }));
}
const one = (req: IncomingMessage, name: string): string | null => {
  const all = (req as IncomingMessage & { headersDistinct?: Record<string, string[] | undefined> }).headersDistinct?.[name];
  return all && all.length === 1 ? all[0]! : null;
};
/** Reads ≤`cap` bytes, ending at `deadlineMono` (rc2 F4: the body read is part of the one 2 s handoff deadline). */
function readCapped(req: IncomingMessage, cap: number, deadlineMono: number): Promise<Buffer | 'TOO_LARGE' | 'ABORTED' | 'TIMEOUT'> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    const timer = setTimeout(() => end('TIMEOUT'), Math.max(0, deadlineMono - performance.now()));
    const end = (v: Buffer | 'TOO_LARGE' | 'ABORTED' | 'TIMEOUT') => { if (done) return; done = true; clearTimeout(timer); if (typeof v === 'string') req.resume(); resolve(v); };
    req.on('data', (c: Buffer) => { if (done) return; size += c.length; if (size > cap) end('TOO_LARGE'); else chunks.push(c); });
    req.on('end', () => end(Buffer.concat(chunks, size)));
    req.on('aborted', () => end('ABORTED')); req.on('error', () => end('ABORTED'));
  });
}

export function evaluationHandoffRoute(runtime: EvaluationRuntime, port: number, db: PrismaClient): Handler {
  const registeredPath = `/clients/${encodeURIComponent(runtime.reg.clientId)}${SUFFIX}`;
  return (req, res, next) => {
    const url = req.url ?? '';
    const path = url.split('?')[0]!;
    if (!(path.startsWith('/clients/') && path.endsWith(SUFFIX))) return next();
    runtime.census.handoffIngress(); // RS-D-A: every handoff-shaped entry, before any check
    if (path !== registeredPath || req.method !== 'POST') return notFound(res);
    void handle(req, res).catch(() => fail(res, 'INTERNAL_FAILURE'));
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deadline = performance.now() + HANDOFF_MS;
    const left = () => deadline - performance.now();
    const origin = `http://127.0.0.1:${port}`;
    if ((req.url ?? '').includes('?') || one(req, 'host') !== `127.0.0.1:${port}` || one(req, 'origin') !== origin
      || one(req, 'sec-fetch-site') !== 'same-origin') return fail(res, 'PROTOCOL_INVALID');
    const type = one(req, 'content-type');
    if (type === null || !/^application\/json(\s*;\s*charset=utf-8)?$/i.test(type) || req.headers['content-encoding'] !== undefined) return fail(res, 'PROTOCOL_INVALID');
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^[0-9]{1,15}$/.test(length) || Number(length) > RESPONSE_BODY_CAP)) return fail(res, /^[0-9]+$/.test(length) ? 'FRAME_TOO_LARGE' : 'PROTOCOL_INVALID');
    const bytes = await readCapped(req, RESPONSE_BODY_CAP, deadline);
    if (bytes === 'TOO_LARGE') return fail(res, 'FRAME_TOO_LARGE');
    if (bytes === 'TIMEOUT') return fail(res, 'DEADLINE');
    if (bytes === 'ABORTED') return;
    let body: ReturnType<typeof decodeHandoffRequest>;
    try { body = decodeHandoffRequest(parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))); }
    catch { return fail(res, 'PROTOCOL_INVALID'); }
    const credential = bearerCredential(req.headers.authorization);
    const hash = credential ? credentialDigest(credential) : null;
    if (hash === null) return fail(res, 'UNAUTHORIZED');
    if (body.operation === 'PAIR') {
      if (bytes.length > PAIR_BODY_CAP) return fail(res, 'FRAME_TOO_LARGE');
      if (one(req, SESSION_HEADER) !== null) return fail(res, 'PROTOCOL_INVALID');
      if (left() <= 0) return fail(res, 'DEADLINE');
      const authority = await handoffAuthority(db, runtime.reg, hash, left());
      if (authority.code !== null) return fail(res, authority.code);
      if (left() <= 0) return fail(res, 'DEADLINE');
      const focus = await runtime.focus(left());
      if (typeof focus === 'string') return fail(res, focus);
      if (left() <= 0) return fail(res, 'DEADLINE');
      const paired = runtime.state.browserPair(body.pairingNonce, { credential: hash, admissionId: focus.admissionId, policyVersion: focus.policyVersion,
        fixtureGeneration: focus.focus.fixtureGeneration, admissionExpiresMs: focus.admissionExpiresMs, credentialExpiresMs: authority.credentialExpiresMs });
      if (typeof paired === 'string') return fail(res, paired);
      return reply(res, 200, JSON.stringify({ contractVersion: HANDOFF_V1, pairId: paired.pairId, sessionToken: paired.sessionToken,
        serverBootId: runtime.serverBootId, expiresAt: paired.expiresAt, evaluationFocus: focus.focus }));
    }
    const session = one(req, SESSION_HEADER);
    if (session === null || !isToken(session) || !runtime.state.isSessionToken(session)) return fail(res, 'UNAUTHORIZED');
    if (left() <= 0) return fail(res, 'DEADLINE');
    // rc2 F6: current authority of THIS caller, then the pair's own credential; a denial or a credential change revokes the pair.
    const authority = await handoffAuthority(db, runtime.reg, hash, left());
    if (authority.code !== null) { runtime.state.revoke(authority.code); return fail(res, authority.code); }
    if (!runtime.state.pairCredential(hash)) { runtime.state.revoke('PAIR_REVOKED'); return fail(res, 'PAIR_REVOKED'); }
    if (left() <= 0) return fail(res, 'DEADLINE');
    const changed = await runtime.handoffCurrent(left());
    if (changed) return fail(res, changed);
    const code = await runtime.respond(body.pairId, body.receiptNonce, body.request, body.response, deadline);
    if (code !== null) return fail(res, code);
    return reply(res, 204, null);
  }
}
