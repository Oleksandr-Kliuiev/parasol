import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FrameError, parseFrameBody } from './frame.ts';
import { decodeEndpoint, decodePhysical } from './private-frames.ts';
import type { Endpoint, PhysicalTuple } from './private-frames.ts';
import { exact, isAbsPath, isDigest, isPort, isPriceRevision, isRoleName, isScopeId, isUuid, req, RevalShapeError, shapeFail } from './scalars.ts';
import { readPrivateFile, SecretFileError } from './secret-file.ts';

/**
 * The closed owner config RevalOwnerConfigV1 (brief §2b): a 0600 file of this user in a 0700 directory of this user, both
 * reached by their own realpath. It holds identities, the UNIX_SOCKET endpoint (no host, no TCP alternative), the physical
 * tuple, secret FILE paths (never values), the pinned helper and the server mode. No field relaxes TTY/peer/physical checks.
 */
export interface OwnerConfig {
  readonly contractVersion: 'RevalOwnerConfigV1'; readonly registrationId: string; readonly databaseInstanceId: string;
  readonly workspaceId: string; readonly clientId: string; readonly actorId: string; readonly admissionId: string;
  readonly approvedPriceRevision: string; readonly nativePeerHelper: string; readonly nativePeerHelperSha256: string;
  readonly endpoint: Endpoint; readonly roles: { readonly reader: string; readonly runtime: string; readonly owner: string };
  readonly physical: PhysicalTuple; readonly secretFiles: { readonly reader: string; readonly runtime: string; readonly owner: string };
  readonly server: { readonly mode: 'LAUNCH' | 'NONE'; readonly apiEntry: string; readonly port: number };
}
export class OwnerConfigError extends Error { constructor() { super('OWNER_CONFIG_INVALID'); this.name = 'OwnerConfigError'; } }
const CONFIG_KEYS = ['contractVersion', 'registrationId', 'databaseInstanceId', 'workspaceId', 'clientId', 'actorId', 'admissionId',
  'approvedPriceRevision', 'nativePeerHelper', 'nativePeerHelperSha256', 'endpoint', 'roles', 'physical', 'secretFiles', 'server'];

export function decodeOwnerConfig(v: unknown): OwnerConfig {
  const o = exact(v, CONFIG_KEYS);
  if (o.contractVersion !== 'RevalOwnerConfigV1') shapeFail();
  for (const k of ['registrationId', 'databaseInstanceId', 'admissionId']) req(isUuid, o[k]);
  for (const k of ['workspaceId', 'clientId', 'actorId']) req(isScopeId, o[k]);
  req(isPriceRevision, o.approvedPriceRevision); req(isAbsPath, o.nativePeerHelper); req(isDigest, o.nativePeerHelperSha256);
  const roles = exact(o.roles, ['reader', 'runtime', 'owner']);
  for (const k of ['reader', 'runtime', 'owner']) req(isRoleName, roles[k]);
  if (new Set([roles.reader, roles.runtime, roles.owner]).size !== 3) shapeFail();
  const secrets = exact(o.secretFiles, ['reader', 'runtime', 'owner']);
  for (const k of ['reader', 'runtime', 'owner']) req(isAbsPath, secrets[k]);
  if (new Set([secrets.reader, secrets.runtime, secrets.owner]).size !== 3) shapeFail();
  const server = exact(o.server, ['mode', 'apiEntry', 'port']);
  if (server.mode !== 'LAUNCH' && server.mode !== 'NONE') shapeFail();
  req(isAbsPath, server.apiEntry); req(isPort, server.port);
  return { ...(o as unknown as OwnerConfig), endpoint: decodeEndpoint(o.endpoint), physical: decodePhysical(o.physical) };
}
/** Loads and validates the owner config file (realpath identity, 0600 in 0700, owner uid). */
export async function loadOwnerConfig(path: string): Promise<OwnerConfig> {
  try {
    const dir = dirname(path);
    if (await realpath(dir).catch(() => '') !== dir) throw new OwnerConfigError();
    const st = await lstat(dir);
    if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) throw new OwnerConfigError();
    const bytes = await readPrivateFile(path, 16 * 1024);
    return decodeOwnerConfig(parseFrameBody(bytes));
  } catch (error) {
    if (error instanceof OwnerConfigError || error instanceof SecretFileError || error instanceof FrameError || error instanceof RevalShapeError
      || (error as NodeJS.ErrnoException).code !== undefined) throw new OwnerConfigError();
    throw error;
  }
}
