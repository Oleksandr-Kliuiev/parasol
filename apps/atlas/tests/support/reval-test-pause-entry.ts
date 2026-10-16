// TEST-ONLY controller-side PAUSE_EXPORT process (R-EVAL RS-A parent-death case): argv[2] = 0600 JSON
// {config, testJson, request, pidFile}. Spawns the test executor exactly like the controller and records its pid; the
// test SIGKILLs THIS process mid-transaction and checks that E exits on parent EOF and its transaction is gone.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { productionDeps } from '../../packages/reval/deps.ts';
import { pauseExport } from '../../packages/reval/pause.ts';
import type { PauseContext, PauseRequest } from '../../packages/reval/pause.ts';
import type { OwnerConfig } from '../../packages/reval/config.ts';

const a = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { config: OwnerConfig; testJson: string; request: PauseRequest; pidFile: string };
const entry = fileURLToPath(new URL('./reval-test-exec-entry.ts', import.meta.url));
const deps = { ...productionDeps(), spawnExecutor: () => {
  const child = spawn(process.execPath, [entry, a.testJson], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: {} });
  writeFileSync(a.pidFile, String(child.pid)); return child;
} };
const ctx: PauseContext = { deps, config: a.config, latched: false, spawns: 0, lastChild: null, requestSent: false, reread: async () => null };
await pauseExport(ctx, a.request, performance.now());
