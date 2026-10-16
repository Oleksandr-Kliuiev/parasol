import { createDirectTransport } from './transport.ts';
import type { Transport } from './transport.ts';

/**
 * Dedicated Ask secret resolution and the production provider seams (docs/stage5/ask/remote/03 "Projection and lifetime").
 * The admitted policy names a secretRef; production resolves ONLY `env://ATLAS_ASK_REMOTE_<NAME>` from the process
 * environment at dispatch time — never OPENAI_API_KEY, Decisions configuration, a subscription/CLI login, the browser or a
 * fixture. `vault://` has no backend here and `fixture://` never resolves in production (no fixture remote success): both
 * leave the call undispatched. The value must be one header-safe token; it is returned only into the private dispatch
 * closure, never stored, logged, echoed or put into an error.
 */
export type SecretResolver = (secretRef: string) => string | null;
export interface RemoteSeams { readonly resolveSecret: SecretResolver; readonly transport: Transport }

const DEDICATED_ENV = /^env:\/\/(ATLAS_ASK_REMOTE_[A-Z0-9_]{1,64})$/;
const HEADER_SAFE = /^[A-Za-z0-9._~+/=-]{20,512}$/;

export function envSecretResolver(env: Readonly<Record<string, string | undefined>> = process.env): SecretResolver {
  return secretRef => {
    const name = DEDICATED_ENV.exec(secretRef)?.[1];
    if (name === undefined) return null;
    const value = env[name];
    return typeof value === 'string' && HEADER_SAFE.test(value) ? value : null;
  };
}

/** Production seams: the dedicated env resolver and the fixed direct HTTPS transport. Creating them reads and sends nothing. */
export function productionSeams(): RemoteSeams {
  return Object.freeze({ resolveSecret: envSecretResolver(), transport: createDirectTransport() });
}
