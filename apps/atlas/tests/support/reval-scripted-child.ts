// TEST-ONLY misbehaving child for the controller side of §2e (Sol RC1 R2 / Opus F3.1): argv[2] selects the behaviour toward
// C on fd 3. Every frame it RECEIVES is printed as `RECV <contractVersion>` so a test can prove nothing was sent to it.
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { encodeFrame, FrameDecoder, parseFrameBody, PRIVATE_FRAME_CAP } from '../../packages/reval/frame.ts';

const mode = process.argv[2]!; const kind = process.argv[3] === 'E' ? 'EXECUTOR' : 'SERVER';
const sock = new Socket({ fd: 3, readable: true, writable: true }); sock.on('error', () => undefined);
const dec = new FrameDecoder(PRIVATE_FRAME_CAP);
const hello = () => encodeFrame({ contractVersion: 'RevalChildHelloV1', kind, helloNonce: randomUUID() }, PRIVATE_FRAME_CAP);
sock.on('data', b => {
  for (const body of dec.push(b)) {
    const f = parseFrameBody(body) as { contractVersion: string; challenge?: string };
    process.stdout.write(`RECV ${f.contractVersion}\n`);
    if ((mode === 'double-result' || mode === 'confirmed') && f.contractVersion === 'RevalOwnerExecRequestV1') {
      const r = encodeFrame({ contractVersion: 'RevalOwnerExecResultV1', challenge: f.challenge, outcome: 'CONFIRMED_COMMIT', revisionApplied: true,
        policyVersion: '2', fenceEpoch: '2', code: null }, PRIVATE_FRAME_CAP);
      sock.write(mode === 'confirmed' ? r : Buffer.concat([r, r]));
    }
  }
});
if (mode === 'hello-twice') sock.write(Buffer.concat([hello(), hello()]));
else if (mode === 'other-first') sock.write(Buffer.concat([encodeFrame({ contractVersion: 'RevalServerBoundV1', launchChallenge: randomUUID() }, PRIVATE_FRAME_CAP), hello()]));
else if (mode === 'double-result' || mode === 'confirmed') sock.write(hello());
// 'silent': never writes HELLO.
setInterval(() => undefined, 1000);
