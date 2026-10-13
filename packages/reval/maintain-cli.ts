import type { OwnerConfig } from './config.ts';
import { loadFrozenDataset } from './dataset.ts';
import type { FrozenDataset } from './dataset.ts';
import { MaintenanceRefusal, setScope } from './inventory.ts';
import type { MaintenanceCode } from './inventory.ts';
import { checkRegistration, installFixture, postCheck } from './materialize.ts';
import type { Registration, SwitchHooks } from './materialize.ts';
import { PhysicalAuthError, PhysicalMismatchError } from './physical.ts';
import type { Observed, QueryClient } from './physical.ts';
import type { PhysicalTuple } from './private-frames.ts';
import { registerSandbox } from './register.ts';
import { isDec64 } from './scalars.ts';
import { loadSeedMapping, seedPlan } from './seed-plan.ts';
import { SecretFileError } from './secret-file.ts';

/**
 * Owner maintenance tool (03 "Transaction and switch procedure", rs-b brief §1.3): an OFFLINE owner operation, never the 06
 * IPC and never reachable from C/S/I. Closed grammar — `probe`, `register`, `install <FXnn> <expectedGeneration>` — and one
 * option `--config <abs path>` (the closed RevalOwnerConfigV1). The owner credential is read from the config's owner secret
 * file into a Buffer, used for the two connections, then zero-filled. TWO independent owner connections, each physically
 * bound to the recorded tuple, confirm the registration; only they are admitted by the backend census. Output: one JSON
 * line with fixed keys; no credential, row content or SQL text is printed.
 */
export interface MaintainDeps {
  loadConfig(path: string): Promise<OwnerConfig>;
  readSecret(path: string): Promise<Buffer>;
  /** Physical binding + connect as the owner role (production: unix socket only). `label` selects the application_name. */
  connectOwner(config: OwnerConfig, password: string, label: 'primary' | 'confirm'): Promise<{ client: QueryClient; observed: Observed }>;
  /** Observes the physical tuple for `probe` (production: socket dev/ino, postmaster.pid at the configured data directory, catalog query). */
  observePhysical(config: OwnerConfig, password: string): Promise<PhysicalTuple>;
  buildManifestSha256(config: OwnerConfig): Promise<string>;
  loadDataset(): FrozenDataset;
  out(line: string): void;
  readonly hooks?: SwitchHooks;
}
export const MAINTAIN_EXIT = Object.freeze({ OK: 0, REFUSED: 1, USAGE: 2 });
const close = async (c: QueryClient | null) => { if (c) await c.end().catch(() => undefined); };

function parseArgs(argv: readonly string[]): { config: string; command: string; args: string[] } | null {
  if (argv.length < 3 || argv[0] !== '--config') return null;
  const [, config, command, ...args] = argv;
  if (command === 'probe' || command === 'register') return args.length === 0 ? { config: config!, command, args } : null;
  if (command === 'install' && args.length === 2 && /^FX(0[1-9]|1[01])$/.test(args[0]!) && isDec64(args[1])) return { config: config!, command, args };
  return null;
}
export async function runMaintain(argv: readonly string[], deps: MaintainDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed) { deps.out(JSON.stringify({ ok: false, code: 'USAGE' })); return MAINTAIN_EXIT.USAGE; }
  const fail = (code: MaintenanceCode): number => { deps.out(JSON.stringify({ ok: false, code })); return MAINTAIN_EXIT.REFUSED; };
  let config: OwnerConfig;
  try { config = await deps.loadConfig(parsed.config); } catch { return fail('REGISTRATION_MISMATCH'); }
  let secret: Buffer;
  try { secret = await deps.readSecret(config.secretFiles.owner); } catch (e) { return fail(e instanceof SecretFileError ? 'UNAUTHORIZED' : 'INTERNAL_FAILURE'); }
  let a: { client: QueryClient; observed: Observed } | null = null; let b: { client: QueryClient; observed: Observed } | null = null;
  try {
    const password = secret.toString('latin1');
    if (parsed.command === 'probe') {
      const physical = await deps.observePhysical(config, password);
      deps.out(JSON.stringify({ ok: true, physical })); return MAINTAIN_EXIT.OK;
    }
    a = await deps.connectOwner(config, password, 'primary');
    b = await deps.connectOwner(config, password, 'confirm');
    secret.fill(0);
    const r: Registration = { registrationId: config.registrationId, databaseInstanceId: config.databaseInstanceId, workspaceId: config.workspaceId,
      clientId: config.clientId, actorId: config.actorId, admissionId: config.admissionId, evidenceReaderRole: config.roles.reader,
      buildManifestSha256: await deps.buildManifestSha256(config) };
    const pids = [a.observed.backendPid, b.observed.backendPid];
    if (parsed.command === 'register') {
      await registerSandbox(a.client, r, pids);
      await confirm(b.client, r);
      deps.out(JSON.stringify({ ok: true, registrationId: r.registrationId, databaseInstanceId: r.databaseInstanceId })); return MAINTAIN_EXIT.OK;
    }
    await confirm(b.client, r);
    const dataset = deps.loadDataset(); const mapping = loadSeedMapping();
    const [fixtureId, expected] = parsed.args as [string, string];
    // RS-D-A (D2): the registered S (runtime role) and C (reader role) may stay up, idle, through the switch.
    const result = await installFixture(a.client, r, dataset, mapping, fixtureId, expected, pids, { runtime: config.roles.runtime, reader: config.roles.reader }, deps.hooks);
    if (!await postCheck(b.client, r, seedPlan(dataset, fixtureId, mapping.mapping, mapping.sha256), result.generation)) return fail('POSTCHECK_FAILED');
    deps.out(JSON.stringify({ ok: true, fixtureId: result.fixtureId, generation: result.generation, seedMappingSha256: result.seedMappingSha256,
      fenceAdvanced: result.fenceAdvanced }));
    return MAINTAIN_EXIT.OK;
  } catch (error) {
    if (error instanceof MaintenanceRefusal) return fail(error.code);
    if (error instanceof PhysicalAuthError) return fail('OWNER_REQUIRED');
    if (error instanceof PhysicalMismatchError) return fail('REGISTRATION_MISMATCH');
    return fail('INTERNAL_FAILURE');
  } finally {
    secret.fill(0);
    await close(a?.client ?? null); await close(b?.client ?? null);
  }
}
/** The second, independent connection reads the registration back (read-only) and requires exact equality. */
async function confirm(c: QueryClient, r: Registration): Promise<void> {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { await setScope(c, r); await checkRegistration(c, r); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
}
export const DATASET_LOADER = loadFrozenDataset;
