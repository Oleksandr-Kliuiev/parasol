import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Actor } from '../../core/contracts.ts';
import { AtlasError } from '../../core/contracts.ts';
import { SCOPE_ID_PATTERN } from '../../graph/scope-context.ts';
import { parseInvocation } from '../commands.ts';
import type { Invocation } from '../commands.ts';
import { links as seedLinks, scope as seedScope } from '../../../fixtures/gasta.ts';

/**
 * Admission of one S2-LIVE pilot invocation, all BEFORE any database or upstream I/O (operational brief RC5): a clean
 * process (no NODE_OPTIONS, no --import/--require/--loader or other preload, no test-harness variables), one private local
 * configuration file with exactly the allowlisted command, its flags (parsed by the accepted parseInvocation), the approved
 * client/connection scope and the metadata output paths. The configuration names scope; it never supplies an Actor or a
 * permission — authority comes from the runtime database token at run time. Secrets stay environment references.
 */
export const PILOT_COMMANDS = ['m365-probe', 'm365-sync', 'm365-status', 'm365-directory', 'correlation', 'live-read', 'mapping', 'confirm-link'] as const;
export type PilotCommand = (typeof PILOT_COMMANDS)[number];
/** RC5 grants per operation on ONE same-client membership (the accepted command boundary checks and audits its own set). */
export const PILOT_GRANTS: Readonly<Record<PilotCommand, readonly string[]>> = Object.freeze({
  'm365-probe': ['connections:manage'], 'm365-sync': ['connections:manage', 'events:ingest'], 'm365-status': ['connections:manage'],
  'm365-directory': ['context:read', 'm365:read'], correlation: ['context:read', 'm365:read'], 'live-read': ['connections:manage', 'events:ingest'],
  mapping: ['mapping:review', 'm365:read'], 'confirm-link': ['mapping:review', 'm365:read'],
});
export const isPilotCommand = (command: unknown): command is PilotCommand => (PILOT_COMMANDS as readonly unknown[]).includes(command);

export interface PilotConfig {
  command: PilotCommand; invocation: Invocation;
  scope: { clientId: string; connectionIds: readonly string[] };
  output: { receipts: string; private: string | null };
}
const refused = (code: string) => new AtlasError(code, 'VALIDATION');
const CONFIG_MAX_BYTES = 16_384;
const ALLOWED_EXEC_ARGV = new Set(['--experimental-strip-types', '--no-warnings', '--disable-warning=ExperimentalWarning']);

/** No injected preload or loader and no test-harness variables in this process. */
export function assertCleanProcess(env: Readonly<Record<string, string | undefined>>, execArgv: readonly string[]): void {
  if ((env.NODE_OPTIONS ?? '').trim() !== '' || execArgv.some(arg => !ALLOWED_EXEC_ARGV.has(arg))) throw refused('PILOT_PRELOAD_REFUSED');
  if (Object.keys(env).some(name => name.startsWith('ATLAS_TEST_') && env[name] !== undefined)) throw refused('PILOT_TEST_ENVIRONMENT_REFUSED');
}

/** `--config <absolute path>` and nothing else. */
export function configPathOf(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config' || !isAbsolute(argv[1]!) || argv[1]!.length > 1024) throw refused('PILOT_USAGE');
  return argv[1]!;
}
export function readConfigFile(path: string): unknown {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { throw refused('PILOT_CONFIG_UNREADABLE'); }
  try {
    const size = fstatSync(fd).size;
    if (size === 0 || size > CONFIG_MAX_BYTES) throw refused('PILOT_CONFIG_INVALID');
    const buffer = Buffer.alloc(size);
    if (readSync(fd, buffer, 0, size, 0) !== size) throw refused('PILOT_CONFIG_UNREADABLE');
    try { return JSON.parse(buffer.toString('utf8')) as unknown; } catch { throw refused('PILOT_CONFIG_INVALID'); }
  } finally { closeSync(fd); }
}

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
const absolutePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && isAbsolute(value) && !/[\u0000-\u001f]/.test(value);

/**
 * { version: 1, command, flags: { name: value }, scope: { client, connections: [...] }, output: { receipts, private? } }.
 * Refusal codes: PILOT_CONFIG_INVALID (shape), PILOT_COMMAND_REFUSED (not allowlisted — checked before the flags are
 * parsed), INVALID_ARGUMENTS (the accepted flag rules), PILOT_SCOPE_MISMATCH, PILOT_FIXTURE_SCOPE_REFUSED.
 */
export function validatePilotConfig(raw: unknown): PilotConfig {
  if (!plain(raw) || !exactKeys(raw, ['version', 'command', 'flags', 'scope', 'output']) || raw.version !== 1) throw refused('PILOT_CONFIG_INVALID');
  if (!isPilotCommand(raw.command)) throw refused('PILOT_COMMAND_REFUSED');
  const { flags, scope, output } = raw;
  if (!plain(flags) || Object.keys(flags).length > 12 || Object.values(flags).some(v => typeof v !== 'string')) throw refused('PILOT_CONFIG_INVALID');
  if (!plain(scope) || !exactKeys(scope, ['client', 'connections']) || typeof scope.client !== 'string' || !Array.isArray(scope.connections)
    || scope.connections.length > 8 || scope.connections.some(c => typeof c !== 'string' || !SCOPE_ID_PATTERN.test(c))) throw refused('PILOT_CONFIG_INVALID');
  if (!plain(output) || !exactKeys(output, ['receipts'], ['private']) || !absolutePath(output.receipts)
    || (output.private !== undefined && (!absolutePath(output.private) || output.private === output.receipts))) throw refused('PILOT_CONFIG_INVALID');
  const argv = [raw.command, ...Object.entries(flags as Record<string, string>).flatMap(([name, value]) => [`--${name}`, value])];
  const invocation = parseInvocation(argv);
  const connections = scope.connections as string[];
  const connection = invocation.flags.connection;
  if (invocation.flags.client !== scope.client || !SCOPE_ID_PATTERN.test(scope.client) || new Set(connections).size !== connections.length
    || (connection !== undefined && !connections.includes(connection))) throw refused('PILOT_SCOPE_MISMATCH');
  if (scope.client === seedScope.clientId || connections.some(c => seedLinks.some(l => l.connectionId === c))) throw refused('PILOT_FIXTURE_SCOPE_REFUSED');
  return { command: raw.command, invocation, scope: { clientId: scope.client, connectionIds: Object.freeze([...connections]) },
    output: { receipts: output.receipts as string, private: (output.private as string | undefined) ?? null } };
}

/**
 * Pilot authority admission on the freshly authenticated Actor: never the stock demo workspace (synthetic seed namespace).
 * The accepted command boundary (runOperatorCommand) checks its own permission set on the one client membership and audits
 * a denial in the workspace security audit; the pilot adds only what RC5 adds beyond it — mapping review/confirmation also
 * needs m365:read on that SAME membership (never combined across clients). A membership that already lacks the accepted
 * permission is left to the accepted boundary, so its audited refusal is preserved. This check stays pure; the driver
 * (admitAudited) appends the safe workspace security audit of its PILOT_AUTHORITY_REFUSED once before rethrowing.
 */
const PILOT_EXTRA: Partial<Record<PilotCommand, { accepted: string; extra: string }>> = {
  mapping: { accepted: 'mapping:review', extra: 'm365:read' }, 'confirm-link': { accepted: 'mapping:review', extra: 'm365:read' },
};
export function admitPilotAuthority(actor: Actor, config: PilotConfig): void {
  if (actor.workspaceId === seedScope.workspaceId) throw new AtlasError('PILOT_FIXTURE_SCOPE_REFUSED', 'SCOPE');
  const rule = PILOT_EXTRA[config.command];
  const membership = actor.memberships.find(m => m.clientId === config.scope.clientId);
  if (rule && membership && membership.permissions.includes(rule.accepted) && !membership.permissions.includes(rule.extra)) {
    throw new AtlasError('PILOT_AUTHORITY_REFUSED', 'SCOPE');
  }
}
