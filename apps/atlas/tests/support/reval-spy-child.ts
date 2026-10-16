// TEST-ONLY child (R-EVAL RS-A handshake, Sol RC1 R2): the PRODUCTION S bridge library or E executor library on an inherited
// fd 3 with SPY credential/connect dependencies (no secret file, no DB). argv[2] = 'S' | 'E', argv[3] = ms the secret read
// takes. Spy calls are printed as one line each; nothing else is written.
const kind = process.argv[2]; const readMs = Number(process.argv[3] ?? 0);
const say = (s: string) => process.stdout.write(`${s}\n`);
const readSecret = async () => { say('READ_SECRET'); await new Promise(r => setTimeout(r, readMs)); return Buffer.from('synthetic-only-password'); };
if (kind === 'S') {
  const { RevalBridge } = await import('../../apps/api/src/reval/bridge.ts');
  await RevalBridge.start({ ATLAS_MODE: 'db', ATLAS_REVAL_BRIDGE_FD: '3' }, { readSecret,
    verify: async () => { say('CONNECT'); return new Promise(() => undefined); }, runtimeUrl: () => '' });
} else {
  const { runExecutorProcess } = await import('../../packages/reval/owner-exec.ts');
  await runExecutorProcess({ readSecret, connect: async () => { say('CONNECT'); return new Promise(() => undefined); } });
}
