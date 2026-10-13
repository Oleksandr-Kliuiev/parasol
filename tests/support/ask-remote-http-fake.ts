import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestFn } from '../../packages/ask/remote/transport.ts';

/**
 * ASK-REMOTE R-B RC2 TEST-ONLY in-process stand-in for https.request, driven through the ACTUAL direct transport
 * (createDirectTransport(requestFn)): response headers (status) first, then a scripted body — small, oversized (64 KiB+1 and
 * more), stalled, error, aborted, a valid/fatal-UTF-8/duplicate-key 200 body or a late body. destroy() closes like Node
 * (response, then request) unless `ignoreDestroy`, in which case only closeRequest()/closeResponse() close them. No socket,
 * TLS, DNS or network is involved; production never imports this module.
 */
export const VALID = JSON.stringify({ object: 'chat.completion', model: 'gpt-6-luna', service_tier: 'default', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"version":"AskRemoteIntentV1","intent":"SUMMARY"}' } }] });

export type BodyMode = 'small' | 'oversized' | 'stalled' | 'error' | 'aborted' | 'valid' | 'utf8' | 'dup' | 'late';
export interface Script { status: number; body: BodyMode; headerDelay?: number; ignoreDestroy?: boolean; type?: string }
/** In-process https.request stand-in: response headers (status) first, then the scripted body. destroy() closes like Node. */
export function fakeHttp(script: Script) {
  const h = { calls: 0, requestClosed: false, responseClosed: false, closeRequest: () => {}, closeResponse: () => {}, bodyWritten: 0 };
  const fn: RequestFn = (_options, callback) => {
    h.calls += 1;
    const req = new EventEmitter() as EventEmitter & { end(b: Buffer): void; destroy(): void };
    let res: (PassThrough & { statusCode: number; headers: Record<string, string> }) | null = null;
    h.closeRequest = () => { if (!h.requestClosed) { h.requestClosed = true; req.emit('close'); } };
    req.destroy = () => {
      if (script.ignoreDestroy || h.requestClosed) return;
      if (res && !res.destroyed) res.destroy();
      setImmediate(() => { req.emit('error', new Error('destroyed')); h.closeRequest(); });
    };
    const write = (b: Buffer) => { if (res && !res.destroyed && !res.writableEnded) { h.bodyWritten += b.length; res.write(b); } };
    const end = () => { if (res && !res.destroyed && !res.writableEnded) res.end(); };
    req.end = () => {
      const respond = () => {
        res = Object.assign(new PassThrough(), { statusCode: script.status, headers: { 'content-type': script.type ?? 'application/json' } });
        const realDestroy = res.destroy.bind(res);
        if (script.ignoreDestroy) { res.destroy = (() => res) as never; h.closeResponse = () => { realDestroy(); }; }
        res.on('close', () => { h.responseClosed = true; if (!script.ignoreDestroy) setImmediate(h.closeRequest); });
        callback(res as never);
        if (script.body === 'small') { write(Buffer.from('{"error":{"message":"synthetic"}}')); end(); }
        else if (script.body === 'oversized') { write(Buffer.alloc(65537, 0x20)); write(Buffer.alloc(1 << 20, 0x20)); end(); }
        else if (script.body === 'error') { write(Buffer.from('{"err')); setImmediate(() => { if (res && !res.destroyed) realDestroy(new Error('socket reset')); }); }
        else if (script.body === 'aborted') { write(Buffer.from('{"err')); setImmediate(() => { res?.emit('aborted'); if (res && !res.destroyed) realDestroy(); }); }
        else if (script.body === 'valid') { write(Buffer.from(VALID)); end(); }
        else if (script.body === 'utf8') { write(Buffer.from([0x7b, 0xff, 0x7d])); end(); }
        else if (script.body === 'dup') { write(Buffer.from(VALID.replace('"model":"gpt-6-luna"', '"model":"gpt-6-luna","model":"gpt-6-luna"'))); end(); }
        else if (script.body === 'late') setTimeout(() => { write(Buffer.from(VALID)); end(); }, 2300);
        // 'stalled': headers only, the body never arrives.
      };
      if (script.headerDelay) setTimeout(respond, script.headerDelay); else setImmediate(respond);
    };
    return req as never;
  };
  return { fn, h };
}

