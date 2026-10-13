import net from 'node:net';

/**
 * PostgreSQL protocol CancelRequest for the PowerOffice cleanup runner's own backend (S4C-rc3 F1). A cancel needs no role,
 * privilege or grant: only the backend process ID and secret key that the server sent on THIS connection (BackendKeyData),
 * delivered on a separate short socket to the same paired endpoint. The server interrupts whatever statement the backend
 * is running or waiting in (lock, I/O, sleep, deferred trigger) with SQLSTATE 57014; an idle backend ignores it. Like
 * libpq ≤ 16 and node-pg, the request is sent in clear text (it carries no credential). Never retried; bounded by
 * `timeoutMs`; resolves (never rejects) because the caller's outcome is decided by the cancelled statement itself.
 */
export interface CancelTarget { readonly host: string; readonly port: number; readonly processID: number; readonly secretKey: number }
export const CANCEL_REQUEST_CODE = 80877102;

export function sendCancelRequest(target: CancelTarget, timeoutMs: number): Promise<'sent' | 'failed'> {
  return new Promise(resolve => {
    const packet = Buffer.alloc(16);
    packet.writeInt32BE(16, 0); packet.writeInt32BE(CANCEL_REQUEST_CODE, 4);
    packet.writeInt32BE(target.processID, 8); packet.writeInt32BE(target.secretKey, 12);
    let done = false;
    const finish = (outcome: 'sent' | 'failed') => { if (!done) { done = true; clearTimeout(timer); socket.destroy(); resolve(outcome); } };
    const socket = new net.Socket();
    const timer = setTimeout(() => finish('failed'), timeoutMs);
    socket.on('error', () => finish('failed'));
    socket.on('connect', () => socket.end(packet));
    socket.on('close', () => finish('sent'));
    try {
      if (target.host.startsWith('/')) socket.connect(`${target.host}/.s.PGSQL.${target.port}`); else socket.connect(target.port, target.host);
    } catch { finish('failed'); }
  });
}
