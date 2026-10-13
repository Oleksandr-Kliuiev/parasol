import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { installApiParsers, nestDefaultParsers } from '../apps/api/src/ask-http.ts';
import { AskBudget } from '../packages/ask/budget.ts';

// ASK-A Q1 parser hand-off over real sockets without Nest: in MOCK the generic JSON/urlencoded parsers never touch an
// intercepted Ask stream (no second read, no req.body) while every other request keeps Nest's defaults; in
// OFF the generic parsers apply to every request, Ask paths included. The final handler stands in for Nest routing.

type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
async function serve(mode: 'off' | 'mock') {
  const chain: Middleware[] = [];
  const budget = new AskBudget();
  const invoked: string[] = [];
  const defaults = nestDefaultParsers();
  const spy = (name: string, parser: Middleware): Middleware => (req, res, next) => { invoked.push(`${name} ${req.url}`); parser(req, res, next); };
  installApiParsers({ use: (fn: Middleware) => { chain.push(fn); } } as never, mode, budget,
    { json: spy('json', defaults.json), urlencoded: spy('urlencoded', defaults.urlencoded) });
  const seen: { url: string; body: unknown; askState: boolean }[] = [];
  const server = createServer((req, res) => {
    let i = 0;
    const next = (error?: unknown) => {
      if (error) { res.statusCode = (error as { status?: number }).status ?? 500; res.end('generic parser error'); return; }
      const fn = chain[i++];
      if (fn) return fn(req, res, next);
      const askState = Object.getOwnPropertySymbols(req).some(symbol => symbol.description === 'atlas.ask.ingress');
      seen.push({ url: req.url ?? '', body: (req as IncomingMessage & { body?: unknown }).body, askState });
      res.end('routed');
    };
    next();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { chain, seen, budget, invoked, base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const post = (base: string, path: string, type: string, body: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body });

test('MOCK: Ask shapes reach routing with only the private parsed body; non-Ask JSON and urlencoded keep the generic parsers', async () => {
  const s = await serve('mock');
  try {
    assert.equal(s.chain.length, 3, 'Ask ingress, then JSON, then urlencoded');
    assert.equal(await (await post(s.base, '/clients/demo-gasta/ask', 'application/json', '{"a":1}')).text(), 'routed');
    assert.equal(await (await post(s.base, '/CLIENTS/x/ASK/', 'application/json', '{"a":1}')).text(), 'routed');
    assert.equal(await (await post(s.base, '/tools/execute', 'application/json', '{"a":1}')).text(), 'routed');
    assert.equal(await (await post(s.base, '/tools/execute', 'application/x-www-form-urlencoded', 'a=1&b[c]=2')).text(), 'routed');
    assert.equal(await (await post(s.base, '/clients/x/ask/extra', 'application/json', '{"a":1}')).text(), 'routed');
    assert.deepEqual(s.seen.map(v => [v.url, v.body, v.askState]), [
      ['/clients/demo-gasta/ask', undefined, true], ['/CLIENTS/x/ASK/', undefined, true],
      ['/tools/execute', { a: 1 }, false], ['/tools/execute', { a: '1', b: { c: '2' } }, false], ['/clients/x/ask/extra', { a: 1 }, false]]);
    const generic = await post(s.base, '/tools/execute', 'application/json', '{"a":');
    assert.equal(generic.status, 400); assert.equal(await generic.text(), 'generic parser error');
    const ask = await post(s.base, '/clients/x/ask', 'application/json', '{"a":');
    assert.equal(ask.status, 400); assert.equal((await ask.json()).code, 'ASK_REQUEST_INVALID');
    assert.equal(s.budget.active, 0, 'routed-but-unclaimed Ask requests release their owner when the response closes');
    assert.deepEqual(s.invoked.filter(i => /\/ask\/?$/i.test(i)), [], 'the generic parsers are never invoked for an intercepted Ask stream');
    assert.ok(s.invoked.includes('json /tools/execute') && s.invoked.includes('urlencoded /tools/execute') && s.invoked.includes('json /clients/x/ask/extra'));
  } finally { await s.close(); }
});

test('OFF: no Ask ingress; the generic parsers handle every request exactly as before, Ask paths included', async () => {
  const s = await serve('off');
  try {
    assert.equal(s.chain.length, 2);
    await post(s.base, '/clients/demo-gasta/ask', 'application/json', '{"a":1}');
    assert.deepEqual(s.seen.map(v => [v.url, v.body, v.askState]), [['/clients/demo-gasta/ask', { a: 1 }, false]]);
    assert.equal((await post(s.base, '/clients/demo-gasta/ask', 'application/json', '{"a":')).status, 400);
    assert.deepEqual(s.invoked.slice(0, 2), ['json /clients/demo-gasta/ask', 'urlencoded /clients/demo-gasta/ask']);
  } finally { await s.close(); }
});
