// TEST-ONLY instrument process I for the R-EVAL RS-C-A process E2E (part A drives I with a test client that speaks the exact
// protocol; the real instrument is part B). It runs under a REAL PTY (C and S prove hasTty on each accepted socket) and is a
// dumb frame relay: the test sends JSON-line commands over a private side socket (argv[2]) to open C's/S's unix sockets, send
// exact frames, take the next frame, close. Every frame is built and checked by the test. No credential, no DB, no network.
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { Channel } from '../../packages/reval/channel.ts';
import { TRANSFER_FRAME_CAP } from '../../packages/reval/eval-transient.ts';

const side = createConnection(process.argv[2]!);
await new Promise<void>((resolve, reject) => { side.once('connect', resolve); side.once('error', reject); });
const channels = new Map<string, Channel>();
const reply = (o: Record<string, unknown>) => side.write(`${JSON.stringify(o)}\n`);
side.on('close', () => process.exit(0));
reply({ hello: true, pid: process.pid });
for await (const line of createInterface({ input: side })) {
  const c = JSON.parse(line) as { id: number; cmd: string; name?: string; path?: string; frame?: unknown; ms?: number };
  try {
    if (c.cmd === 'open') {
      const socket = createConnection(c.path!);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      channels.set(c.name!, new Channel(socket, TRANSFER_FRAME_CAP));
      reply({ id: c.id, ok: true });
    } else if (c.cmd === 'send') { channels.get(c.name!)!.send(c.frame); reply({ id: c.id, ok: true }); }
    else if (c.cmd === 'next') {
      const ch = channels.get(c.name!)!;
      ch.next(c.ms).then(frame => reply({ id: c.id, frame }), (e: { reason?: string }) => reply({ id: c.id, error: e.reason ?? 'ERROR' }));
    } else if (c.cmd === 'close') { channels.get(c.name!)?.close(); reply({ id: c.id, ok: true }); }
    else reply({ id: c.id, error: 'COMMAND' });
  } catch (e) { reply({ id: c.id, error: (e as Error).message }); }
}
