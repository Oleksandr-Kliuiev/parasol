import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ASK_HTTP_STATUS, ASK_LIMITS, AskFailure, askErrorBody } from '../../../packages/ask/contracts.ts';
import type { AskErrorCode } from '../../../packages/ask/contracts.ts';
import type { AskMode } from '../../../packages/ask/config.ts';
import { AskBudget } from '../../../packages/ask/budget.ts';
import { askTarget, jsonContentType } from '../../../packages/ask/input.ts';
import type { AskShape } from '../../../packages/ask/input.ts';
import { AskRun, AskStopped } from '../../../packages/ask/service.ts';
import type { AskReply } from '../../../packages/ask/service.ts';
import type { EvaluationTask } from '../../../packages/ask/remote/evaluation.ts';

/**
 * R-EVAL RS-C-A (docs/stage5/ask/remote/reval-server/04 "Registration lifetime and exact Ask ingress pipeline"): the optional
 * registration-lifetime gate of the controller-launched bridge server. Consulted synchronously after route classification and
 * BEFORE the budget owner, body read, bearer or DB work. Absent (undefined) in every ordinary process: behavior unchanged.
 */
export interface EvaluationExchange {
  readonly ask: EvaluationTask;
  /** Extra response headers decided at HTTP write time (a bound publication's receipt nonce); called once, before write. */
  publishing(status: number, json: string, correlationId: string): Readonly<Record<string, string>>;
  /** The server HTTP writer completed this reply (`finish`). */
  finished(): void;
  /** The response closed without a completed write. */
  aborted(): void;
  /** The request owner was actually released (every held DB/transport work settled). */
  released(): void;
}
export type EvaluationAdmission = { readonly kind: 'pass' } | { readonly kind: 'reject'; readonly code: string; readonly status: number }
  | { readonly kind: 'claimed'; readonly exchange: EvaluationExchange };
/** RS-D-A: `res` lets the gate count a passed question's completed write (guard census publication); observation only. */
export interface EvaluationIngress { admit(req: IncomingMessage, shape: AskShape, clientId: string | null, hasQuery: boolean, res: ServerResponse): EvaluationAdmission }

/**
 * Route-local Ask HTTP boundary and the API's request parsers (docs/stage5/ask/02 "Fixed HTTP surface", 03 budgets).
 * main.ts creates BOTH bootstrap branches with bodyParser:false, keeps the operator Host gate first and then calls
 * installApiParsers, which registers, in order:
 *   1. MOCK and REMOTE (the same raw boundary; REMOTE serves V2 DTOs) — the Ask ingress: HEAD/OPTIONS on an Ask path → synchronous ordinary 404 (no implicit GET/controller/auth);
 *      the exact enabled shapes reserve ONE provisional global owner synchronously (429 before any body/auth work), start
 *      the original 8 s deadline, reject query/type/encoding/oversize (413 by Content-Length or actual
 *      counted bytes, chunked too, buffering stops at 16 KiB), decode UTF-8 fatally and parse JSON once into a private
 *      request property consumed explicitly by the Ask controller (never @Body(), never a second read);
 *   2. express.json() and express.urlencoded({ extended: true }) — Nest's own unchanged defaults, from the express instance
 *      of @nestjs/platform-express — for every request that is NOT an intercepted Ask shape (in OFF: every request).
 * Every enabled Ask reply is application/json, Cache-Control: no-store, X-Atlas-Correlation-Id = the server correlation
 * UUID; errors are exactly AskErrorV1 and never echo a body, question, header or exception. Nothing is logged except a fixed
 * code with the correlation UUID for an unexpected failure.
 */
const logger = new Logger('AtlasAsk');
const ASK_STATE = Symbol('atlas.ask.ingress');
type Handler = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
interface Ingress { readonly exchange: AskExchange; readonly shape: AskShape; readonly clientId: string | null; body: unknown; claimed: boolean;
  readonly evaluation: EvaluationExchange | null }
type AskRequest = IncomingMessage & { [ASK_STATE]?: Ingress };

function write(res: ServerResponse, status: number, json: string, correlationId: string, close: boolean,
  extra: Readonly<Record<string, string>> = {}): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Atlas-Correlation-Id', correlationId);
  for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
  res.setHeader('Content-Length', String(Buffer.byteLength(json, 'utf8')));
  if (close) res.setHeader('Connection', 'close');
  res.end(json);
}
const errorJson = (code: AskErrorCode, correlationId: string) => JSON.stringify(askErrorBody(code, correlationId));
/** A fixed error before any exchange exists (no owner, or no ingress state): its own correlation UUID in body and header. */
function refuse(res: ServerResponse, code: AskErrorCode): void {
  const correlationId = randomUUID();
  write(res, ASK_HTTP_STATUS[code], errorJson(code, correlationId), correlationId, true);
}

/** One enabled Ask exchange: exactly one publication, the public deadline timer and disconnect → terminal run. */
class AskExchange {
  readonly run: AskRun;
  readonly #res: ServerResponse;
  readonly #timer: NodeJS.Timeout;
  readonly #evaluation: EvaluationExchange | null;
  #published = false;
  constructor(run: AskRun, res: ServerResponse, evaluation: EvaluationExchange | null = null) {
    this.run = run;
    this.#res = res;
    this.#evaluation = evaluation;
    this.#timer = setTimeout(() => this.fail('ASK_DEADLINE', true), run.deadline.remaining());
    if (evaluation) {
      // RS-C-A rc2 (review F10): evaluation bookkeeping can never break the accepted publication/release path.
      const observe = (fn: () => void) => { try { fn(); } catch { /* bookkeeping only */ } };
      res.once('finish', () => observe(() => evaluation.finished()));
      res.once('close', () => { if (!res.writableFinished) observe(() => evaluation.aborted()); });
      run.owner.onRelease(() => observe(() => evaluation.released()));
    }
    res.once('close', () => {
      clearTimeout(this.#timer);
      if (!this.#published) { this.#published = true; run.end(); }
    });
  }
  get published(): boolean { return this.#published; }
  publish(reply: AskReply, close = false): void {
    if (this.#published) return;
    this.#published = true;
    clearTimeout(this.#timer);
    this.run.end();
    if (reply.unexpected) logger.error(`ASK_RUNTIME_NOT_READY ${this.run.correlationId}`);
    let extra: Readonly<Record<string, string>> = {};
    try { if (this.#evaluation) extra = this.#evaluation.publishing(reply.status, reply.json, this.run.correlationId); } catch { extra = {}; }
    write(this.#res, reply.status, reply.json, this.run.correlationId, close, extra);
  }
  fail(code: AskErrorCode, close = false): void {
    this.publish({ status: ASK_HTTP_STATUS[code], json: errorJson(code, this.run.correlationId) }, close);
  }
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ message: 'Not Found', statusCode: 404 }));
}

/** Counts actual incoming bytes (chunked included) and stops buffering past `limit`; zero-limit means "no body at all". */
function readBody(req: IncomingMessage, limit: number, overflow: AskErrorCode): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const settle = (fn: () => void) => {
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onAbort); req.off('close', onClose);
      fn();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { settle(() => reject(new AskFailure(overflow))); req.resume(); return; }
      chunks.push(chunk);
    };
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks, size)));
    const onAbort = () => settle(() => reject(new AskStopped()));
    const onClose = () => { if (!req.complete) onAbort(); };
    req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', onAbort); req.on('close', onClose);
  });
}

/** Raw syntax of one intercepted shape; throws the fixed 400/413 codes. Returns the parsed JSON (POST) or undefined. */
async function rawInput(req: IncomingMessage, shape: AskShape): Promise<unknown> {
  const length = req.headers['content-length'];
  if (shape === 'capability') {
    if ((length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined) throw new AskFailure('ASK_REQUEST_INVALID');
    await readBody(req, 0, 'ASK_REQUEST_INVALID');
    return undefined;
  }
  if (!jsonContentType(req.headers['content-type']) || req.headers['content-encoding'] !== undefined) throw new AskFailure('ASK_REQUEST_INVALID');
  if (length !== undefined && !(/^[0-9]{1,15}$/.test(length) && Number(length) <= ASK_LIMITS.rawBodyBytes)) {
    throw new AskFailure(/^[0-9]+$/.test(length) ? 'ASK_TOO_LARGE' : 'ASK_REQUEST_INVALID');
  }
  const bytes = await readBody(req, ASK_LIMITS.rawBodyBytes, 'ASK_TOO_LARGE');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new AskFailure('ASK_REQUEST_INVALID'); }
  try { return JSON.parse(text) as unknown; } catch { throw new AskFailure('ASK_REQUEST_INVALID'); }
}

function askIngress(budget: AskBudget, gate?: EvaluationIngress): Handler {
  return (req, res, next) => {
    const target = askTarget(req.method, req.url);
    if (target === null) return next();
    if (target.action === 'reject') return notFound(res);
    // R-EVAL RS-C-A: the registration-lifetime gate decides synchronously BEFORE the owner, body, bearer or DB work.
    const gated: EvaluationAdmission = gate ? gate.admit(req, target.shape, target.clientId, target.hasQuery, res) : { kind: 'pass' };
    if (gated.kind === 'reject') {
      const correlationId = randomUUID();
      return write(res, gated.status, JSON.stringify({ contractVersion: 'AskErrorV1', code: gated.code, correlationId }), correlationId, true);
    }
    const evaluation = gated.kind === 'claimed' ? gated.exchange : null;
    const owner = budget.reserve();
    // A claimed task that never gets an owner is aborted AND finished: its arm never stays CLAIMED (no re-arm, no stuck arm).
    if (owner === null) { try { evaluation?.aborted(); evaluation?.released(); } catch { /* bookkeeping only */ } return refuse(res, 'ASK_BUSY'); }
    const exchange = new AskExchange(new AskRun(owner), res, evaluation);
    const ingress: Ingress = { exchange, shape: target.shape, clientId: target.clientId, body: undefined, claimed: false, evaluation };
    // A classified request that never reaches its controller (an unrouted alias) still releases its owner exactly once.
    res.once('close', () => { if (!ingress.claimed) owner.finish(); });
    const parse = (async () => {
      if (target.hasQuery) throw new AskFailure('ASK_REQUEST_INVALID');
      return rawInput(req, target.shape);
    })();
    parse.then(body => {
      if (exchange.published) return owner.finish();
      ingress.body = body;
      (req as AskRequest)[ASK_STATE] = ingress;
      // rc2 (R4): an undecodable client segment would end in Express's parameter error. Only for that spelling the target is
      // re-encoded so the router delivers it to the Ask controller; the controller takes the Ask-owned clientId from this
      // private state (the raw text, never a pattern-valid ID), so the rewritten path never grants or changes authority.
      if (target.routePath !== null) req.url = target.routePath;
      next();
    }, (error: unknown) => {
      if (error instanceof AskFailure) exchange.fail(error.code, true);
      else if (!(error instanceof AskStopped)) exchange.fail('ASK_RUNTIME_NOT_READY', true);
      owner.finish();
    });
  };
}

export interface GenericParsers { readonly json: Handler; readonly urlencoded: Handler }
/** Nest's own unchanged defaults (what bodyParser:true registers), from the express instance of @nestjs/platform-express. */
export function nestDefaultParsers(): GenericParsers {
  const nestExpress = createRequire(import.meta.resolve('@nestjs/platform-express'))('express') as {
    json(): Handler; urlencoded(options: { extended: boolean }): Handler;
  };
  return { json: nestExpress.json(), urlencoded: nestExpress.urlencoded({ extended: true }) };
}

/**
 * Generic parsers excluded ONLY for the intercepted Ask shapes in MOCK/REMOTE by explicit classification — never by a
 * stream-finished or req._body heuristic (body-parser's own isFinished skip is not relied on). `parsers` defaults to Nest's
 * defaults; a test passes wrapped defaults to observe invocations.
 */
export function installApiParsers(app: INestApplication, mode: AskMode, budget: AskBudget = new AskBudget(), parsers: GenericParsers = nestDefaultParsers(),
  gate?: EvaluationIngress): void {
  const generic = (parser: Handler): Handler => mode === 'off' ? parser
    : (req, res, next) => askTarget(req.method, req.url)?.action === 'intercept' ? next() : parser(req, res, next);
  if (mode !== 'off') app.use(askIngress(budget, gate));
  app.use(generic(parsers.json));
  app.use(generic(parsers.urlencoded));
}

/**
 * Controller side: claims the private parsed body exactly once and runs the flow under the request's owner. The flow is
 * held by the owner (with every transaction/planner promise it holds itself), so a public timeout or disconnect never
 * releases capacity early. A request that did not pass the Ask ingress is refused without any work.
 */
export function serveAsk(req: IncomingMessage, res: ServerResponse, shape: AskShape,
  flow: (run: AskRun, body: unknown, clientId: string, evaluation: EvaluationTask | undefined) => Promise<AskReply>): void {
  const ingress = (req as AskRequest)[ASK_STATE];
  if (!ingress || ingress.claimed || ingress.shape !== shape) return refuse(res, 'ASK_REQUEST_INVALID');
  ingress.claimed = true;
  const { exchange } = ingress;
  const body = ingress.body;
  ingress.body = undefined;
  delete (req as AskRequest)[ASK_STATE];
  const clientId = ingress.clientId ?? '';
  const evaluation = ingress.evaluation?.ask;
  const work = Promise.resolve().then(() => flow(exchange.run, body, clientId, evaluation)).then(reply => exchange.publish(reply), (error: unknown) => {
    if (!(error instanceof AskStopped)) exchange.fail('ASK_RUNTIME_NOT_READY');
  });
  exchange.run.owner.hold(work);
  exchange.run.owner.finish();
}
