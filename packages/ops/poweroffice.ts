import { AtlasError } from '../core/contracts.ts';
import { assertRuntimeRole } from '../graph/scoped-db.ts';
import { isPowerOfficeErrorCode } from '../poweroffice/contracts.ts';
import type { PowerOfficeErrorCode } from '../poweroffice/contracts.ts';
import { powerOfficeCredential, powerOfficeFailure } from '../poweroffice/authority.ts';
import type { PowerOfficeCredential } from '../poweroffice/authority.ts';
import { powerOfficeComposition } from '../poweroffice/composition.ts';
import type { PowerOfficeComposition } from '../poweroffice/composition.ts';
import { readPowerOfficeStatus, readPowerOfficeSummary } from '../poweroffice/read.ts';
import { syncPowerOffice } from '../poweroffice/sync.ts';
import { recoverPowerOffice } from '../poweroffice/recovery.ts';
import { admitPowerOfficeCleanup, openPowerOfficeRuntime, runPowerOfficeCleanup } from '../poweroffice/maintenance.ts';
import type { PowerOfficeRuntime } from '../poweroffice/maintenance.ts';

/**
 * Stage 4 PowerOffice operator commands (docs/stage4/02_CONTRACTS.md "Public interface", RUNBOOK §10). Routed by
 * scripts/ops.ts BEFORE the legacy Stage 1/2 parser and its Actor authentication, which stay unchanged. Each command takes
 * exactly `--client C --connection N` (both required, each once, bounded printable values; no other flag: no source,
 * file, URL, tenant, currency, clock, raw or body option). The bearer comes only from the protected ATLAS_OPERATOR_TOKEN
 * environment variable — never argv — and becomes an opaque PowerOffice credential; each service re-reads the current
 * token/actor/membership inside its own fenced transaction (one workspace denial, never a CLI-level duplicate).
 * Composition: DISABLED unless ATLAS_POWEROFFICE_MODE=MOCK (built-in synthetic export only). The cleanup's runner URL is
 * derived from this process's paired runtime URL (packages/poweroffice/maintenance.ts); no URL is ever printed.
 * Output: one JSON object (DTO or receipt fields, fixed codes), synthetic:true on every path, never a token, URL, password,
 * company key or raw exception. Exit: 0 successful read/sync/recover/cleanup (an UNAVAILABLE read is 1), 1 operation
 * failure, 2 usage/configuration (arguments, mode, credential, runtime/runner readiness).
 */
type Command = 'poweroffice-status' | 'poweroffice-summary' | 'poweroffice-sync' | 'poweroffice-recover' | 'poweroffice-cleanup';
export const POWEROFFICE_COMMANDS: readonly Command[] = ['poweroffice-status', 'poweroffice-summary', 'poweroffice-sync', 'poweroffice-recover', 'poweroffice-cleanup'];
export const isPowerOfficeCommand = (command: string | undefined): boolean => command !== undefined && (POWEROFFICE_COMMANDS as readonly string[]).includes(command);
type Env = Readonly<Record<string, string | undefined>>;
export interface CliOutcome { code: 0 | 1 | 2; output: Record<string, unknown> }

const VALUE = /^[\x21-\x7e]{1,128}$/;
const FLAGS = ['client', 'connection'] as const;
/** `<command> --client C --connection N` in either order; anything else (unknown/repeated/missing flag, value form) refuses. */
export function parsePowerOfficeInvocation(argv: readonly string[]): { command: Command; clientId: string; connectionId: string } {
  const [command, ...rest] = argv;
  if (!isPowerOfficeCommand(command) || rest.length !== 4) throw new AtlasError('INVALID_ARGUMENTS', 'VALIDATION');
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = /^--([a-z]+)$/.exec(rest[i]!)?.[1]; const value = rest[i + 1]!;
    if (!name || !(FLAGS as readonly string[]).includes(name) || Object.hasOwn(flags, name) || !VALUE.test(value) || value.startsWith('-')) {
      throw new AtlasError('INVALID_ARGUMENTS', 'VALIDATION');
    }
    flags[name] = value;
  }
  return { command: command as Command, clientId: flags.client!, connectionId: flags.connection! };
}

/** Configuration and usage codes exit 2; every other fixed code is an operation failure (exit 1). */
const CONFIG: ReadonlySet<PowerOfficeErrorCode> = new Set(['INVALID_ARGUMENTS', 'POWEROFFICE_DISABLED', 'POWEROFFICE_MODE_UNSUPPORTED',
  'POWEROFFICE_RUNTIME_NOT_READY', 'POWEROFFICE_AUTHENTICATION_FAILED']);
function failure(command: string, error: unknown): CliOutcome {
  // An unreachable/refused runtime database is readiness/configuration, never a raw message.
  const unready = (error as { name?: unknown } | null)?.name === 'PrismaClientInitializationError';
  const fixed = unready ? 'POWEROFFICE_RUNTIME_NOT_READY' : powerOfficeFailure(error).code;
  const code: PowerOfficeErrorCode = isPowerOfficeErrorCode(fixed) ? fixed : 'UNEXPECTED_ERROR';
  return { code: CONFIG.has(code) ? 2 : 1, output: { command, safeErrorCode: code, synthetic: true } };
}

interface Context { runtime: PowerOfficeRuntime; composition: PowerOfficeComposition; credential: PowerOfficeCredential; clientId: string; connectionId: string; env: Env }
const RUN: Readonly<Record<Command, (c: Context) => Promise<object>>> = {
  'poweroffice-status': c => readPowerOfficeStatus(c.runtime.db, c.composition, c.credential, c.clientId, c.connectionId),
  'poweroffice-summary': c => readPowerOfficeSummary(c.runtime.db, c.composition, c.credential, c.clientId, c.connectionId),
  'poweroffice-sync': c => syncPowerOffice(c.runtime.db, c.composition, c.credential, c.clientId, c.connectionId),
  'poweroffice-recover': c => recoverPowerOffice(c.runtime.db, c.composition, c.credential, c.clientId, c.connectionId),
  'poweroffice-cleanup': async c => runPowerOfficeCleanup(await admitPowerOfficeCleanup(c.runtime, c.composition, c.credential, c.clientId, c.connectionId), c.env),
};

/** One PowerOffice command in this process: arguments, composition, credential, confined runtime check, one service. */
export async function runPowerOfficeCli(argv: readonly string[], env: Env): Promise<CliOutcome> {
  let invocation: ReturnType<typeof parsePowerOfficeInvocation>;
  try { invocation = parsePowerOfficeInvocation(argv); } catch {
    return { code: 2, output: { command: isPowerOfficeCommand(argv[0]) ? argv[0] : null, safeErrorCode: 'INVALID_ARGUMENTS', commands: POWEROFFICE_COMMANDS, synthetic: true } };
  }
  const { command } = invocation;
  let composition: PowerOfficeComposition; let credential: PowerOfficeCredential;
  try { composition = powerOfficeComposition(env); credential = powerOfficeCredential(env.ATLAS_OPERATOR_TOKEN ?? ''); } catch (error) { return failure(command, error); }
  if (!env.ATLAS_RUNTIME_DATABASE_URL) return failure(command, new AtlasError('POWEROFFICE_RUNTIME_NOT_READY', 'PERMANENT'));
  const runtime = openPowerOfficeRuntime(env.ATLAS_RUNTIME_DATABASE_URL);
  try {
    // Any failure of the accepted runtime self-check (owner, BYPASSRLS, unconfined role, missing RLS…) is one fixed code.
    await assertRuntimeRole(runtime.db).catch((error: unknown) => {
      throw (error as { name?: unknown } | null)?.name === 'PrismaClientInitializationError' ? error : new AtlasError('POWEROFFICE_RUNTIME_NOT_READY', 'PERMANENT');
    });
    const result = await RUN[command]({ runtime, composition, credential, clientId: invocation.clientId, connectionId: invocation.connectionId, env });
    const unavailable = (result as { status?: unknown }).status === 'UNAVAILABLE';
    return { code: unavailable ? 1 : 0, output: { command, ...result, synthetic: true } };
  } catch (error) {
    return failure(command, error);
  } finally { await runtime.db.$disconnect().catch(() => undefined); }
}
