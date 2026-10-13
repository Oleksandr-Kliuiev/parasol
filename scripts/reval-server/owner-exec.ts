// R-EVAL RS-A owner executor E (brief §6): spawned by the controller once per PAUSE_EXPORT with an empty environment.
// HELLO first; the owner credential is read only after the verified request; one transaction; one result; exit.
import pg from 'pg';
import { productionExecConnect, runExecutorProcess } from '../../packages/reval/owner-exec.ts';
import { nodePhysicalDeps } from '../../packages/reval/physical.ts';
import type { QueryClient } from '../../packages/reval/physical.ts';
import { readSecretFile } from '../../packages/reval/secret-file.ts';

const physical = nodePhysicalDeps(async o => { const c = new pg.Client(o); await c.connect(); return c as unknown as QueryClient; });
await runExecutorProcess({ readSecret: readSecretFile, connect: productionExecConnect(physical) });
