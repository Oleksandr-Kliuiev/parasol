import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stateFile, jsonFile } from './runtime.mjs';
import { verifyContainer } from './database.mjs';

// This short-lived owned subprocess contains the existing harness's synchronous Prisma command. The launcher bounds
// the entire process group, including Prisma descendants, and never gives it a connection to an existing cluster.
try {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const path = process.env.PARASOL_COMPOSITION_STATE;
  const state = await stateFile(path);
  const admin = new URL(state.pgAdminUrl);
  if (state.root !== root || resolve(path) !== join(state.directory, 'private/state.json') || state.phase !== 'initializing'
    || !/^[a-f0-9]{12}$/.test(state.runId) || state.sqlDatabase !== `crm_e2e_composition_${state.runId}`
    || state.sqlContainer !== `parasol-composition-${state.runId}-sql` || state.pgContainer !== `parasol-composition-${state.runId}-pg`
    || admin.protocol !== 'postgresql:' || admin.hostname !== '127.0.0.1' || admin.username !== 'postgres'
    || admin.pathname !== '/postgres' || admin.port !== String(state.ports.pg) || admin.search || admin.hash) throw new Error('Invalid owned migration state.');
  await verifyContainer(state, state.pgContainer); await verifyContainer(state, state.sqlContainer);
  const { createTestDatabase } = await import(pathToFileURL(join(root, 'apps/atlas/tests/support/pg-harness.ts')));
  const db = await createTestDatabase({ adminUrl: state.pgAdminUrl });
  await jsonFile(join(state.directory, 'private/atlas-database.json'), { ownerUrl: db.ownerUrl, runtimeUrl: db.runtimeUrl, roles: db.roles });
  await db.owner.end();
  // The helper retains an administrative cleanup connection; process exit closes it. Teardown removes the owned cluster.
  process.exit(0);
} catch { console.error('COMPOSITION_ATLAS_MIGRATION_FAILED'); process.exit(1); }
