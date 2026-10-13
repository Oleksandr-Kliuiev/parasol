// TEST-ONLY owner entry (R-EVAL RS-A launch test): the production owner CLI library, spawning the TEST controller entry. Run
// under a real PTY via /usr/bin/script. Before spawning it opens sentinel handles that C must never inherit (leak test).
import { openSync, fstatSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwner } from '../../packages/reval/owner-cli.ts';

const config = process.argv[3]!;
const sentinels: { kind: string; dev: number; ino: number }[] = [];
const hold = (kind: string, fd: number) => { const st = fstatSync(fd); sentinels.push({ kind, dev: st.dev, ino: st.ino }); };
hold('config-file', openSync(config, 'r'));
hold('secret-file', openSync(join(dirname(config), 'secrets', 'owner'), 'r'));
const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
hold('listening-socket', (listener as unknown as { _handle: { fd: number } })._handle.fd);
listener.unref();
writeFileSync(join(dirname(config), 'owner-sentinels.json'), JSON.stringify(sentinels));
await runOwner({ argv: process.argv.slice(2), controllerEntry: fileURLToPath(new URL('./reval-test-controller-entry.ts', import.meta.url)) });
