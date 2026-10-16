// R-EVAL RS-B fixture verifier V (rs-b brief B8): spawned by the controller once per FIXTURE_CHECK with an empty environment.
// HELLO first; the runtime credential is read only after the verified request; one read-only transaction; one result; exit.
import pg from 'pg';
import { nodePhysicalDeps } from '../../packages/reval/physical.ts';
import type { QueryClient } from '../../packages/reval/physical.ts';
import { UTC_TYPES } from '../../packages/reval/pg-tx.ts';
import { readSecretFile } from '../../packages/reval/secret-file.ts';
import { productionVerifierConnect, runVerifierProcess } from '../../packages/reval/verifier-exec.ts';

const physical = nodePhysicalDeps(async o => { const c = new pg.Client({ ...o, types: UTC_TYPES }); await c.connect(); return c as unknown as QueryClient; });
await runVerifierProcess({ readSecret: readSecretFile, connect: productionVerifierConnect(physical) });
