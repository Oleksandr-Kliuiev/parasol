import { AtlasError } from '../packages/core/contracts.ts';
import { assertResolvedConnection } from '../packages/connections/connections.ts';
import type { ResolvedConnection, SecretResolver } from './contracts.ts';

/**
 * Secret resolution for Stage 1 (sync order step 2). The value exists only in memory for one call; it is never logged,
 * stored or put into an error. env://NAME reads an environment variable (local development, a live read smoke test);
 * vault:// needs a vault integration that Stage 1 does not configure; a fixture:// connection never calls a vendor.
 */
export class EnvSecretResolver implements SecretResolver {
  readonly #env: Readonly<Record<string, string | undefined>>;
  constructor(env: Readonly<Record<string, string | undefined>> = process.env) { this.#env = env; }
  async resolve(secretRef: string, connection: ResolvedConnection): Promise<string> {
    assertResolvedConnection(connection);
    const name = /^env:\/\/([A-Z][A-Z0-9_]{0,99})$/.exec(secretRef)?.[1];
    if (name) {
      const value = this.#env[name];
      if (!value) throw new AtlasError('SECRET_NOT_FOUND', 'PERMANENT');
      return value;
    }
    if (secretRef.startsWith('vault://')) throw new AtlasError('SECRET_BACKEND_NOT_CONFIGURED', 'PERMANENT');
    throw new AtlasError('SECRET_REF_UNSUPPORTED', 'PERMANENT');
  }
}
