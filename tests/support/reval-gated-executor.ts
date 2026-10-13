// TEST-ONLY executor stand-in for the PAUSE_EXPORT reread window (Sol RC2-F1): HELLO, then exactly ONE valid
// CONFIRMED_COMMIT result for the received request. argv[2] = 'normal' → flush and exit normally (EOF), like E;
// otherwise wait for "go" on stdin (sent by the test from inside C's pending reread) and then send ONE anomaly on fd 3:
// 'duplicate' (a second full result), 'partial' (a few bytes of another frame), 'oversize' (a declared length over the 4 KiB
// private cap) or 'malformed' (a well-framed non-JSON body). Prints ANOMALY_SENT. Never touches a DB or secret.
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { encodeFrame, FrameDecoder, parseFrameBody, PRIVATE_FRAME_CAP } from '../../packages/reval/frame.ts';

const mode = process.argv[2]!;
const sock = new Socket({ fd: 3, readable: true, writable: true }); sock.on('error', () => undefined);
const dec = new FrameDecoder(PRIVATE_FRAME_CAP);
let result: Buffer | null = null;
const anomaly = (): Buffer => {
  if (mode === 'duplicate') return result!;
  if (mode === 'partial') return result!.subarray(0, 6);
  const header = Buffer.alloc(4);
  if (mode === 'oversize') { header.writeUInt32BE(PRIVATE_FRAME_CAP + 1); return Buffer.concat([header, Buffer.from('{')]); }
  const body = Buffer.from('{not json'); header.writeUInt32BE(body.length); return Buffer.concat([header, body]);
};
sock.on('data', b => {
  for (const body of dec.push(b)) {
    const f = parseFrameBody(body) as { contractVersion: string; challenge: string };
    if (f.contractVersion !== 'RevalOwnerExecRequestV1' || result) continue;
    result = encodeFrame({ contractVersion: 'RevalOwnerExecResultV1', challenge: f.challenge, outcome: 'CONFIRMED_COMMIT', revisionApplied: true,
      policyVersion: '2', fenceEpoch: '2', code: null }, PRIVATE_FRAME_CAP);
    if (mode === 'normal') sock.write(result, () => process.exit(0));
    else sock.write(result);
  }
});
process.stdin.on('data', () => { if (result) sock.write(anomaly(), () => process.stdout.write('ANOMALY_SENT\n')); });
sock.write(encodeFrame({ contractVersion: 'RevalChildHelloV1', kind: 'EXECUTOR', helloNonce: randomUUID() }, PRIVATE_FRAME_CAP));
setInterval(() => undefined, 1000);
