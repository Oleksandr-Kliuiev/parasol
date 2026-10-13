import { ACTION_MODE, ACTION_POLICY_VERSION, ACTION_PORT_VERSION, ACTION_TYPE, ACTION_VERSION, actionError } from './contracts.ts';

/**
 * Deployed action policy (01_SPEC "Product and policy limits"). Engineering commands default to DISABLED; only an explicit
 * MOCK composition is accepted. LIVE, configurable origins, custom ports/scripts and provider callbacks are refused. The
 * customer identity comes only from the scoped Connection binding, which must be an existing atera FIXTURE connection.
 */
export type ActionModeSetting = 'DISABLED' | 'MOCK';
export interface ActionComposition { readonly mode: typeof ACTION_MODE; readonly policyVersion: string; readonly portVersion: string }
export const ACTION_MODE_VARIABLE = 'ATLAS_ACTIONS_MODE';
/** Variables that would configure a transport, origin or callback; their mere presence refuses composition. */
const REFUSED_VARIABLES = ['ATLAS_ACTIONS_ORIGIN', 'ATLAS_ACTIONS_PORT', 'ATLAS_ACTIONS_SCRIPT', 'ATLAS_ACTIONS_CALLBACK', 'ATLAS_ACTIONS_LIVE'];

/** Trusted composition from the process environment: DISABLED unless exactly MOCK; anything else refused. */
export function actionComposition(env: Readonly<Record<string, string | undefined>>): ActionComposition {
  if (REFUSED_VARIABLES.some(v => env[v] !== undefined && env[v] !== '')) throw actionError('ACTION_MODE_REFUSED');
  const mode = env[ACTION_MODE_VARIABLE];
  if (mode === undefined || mode === '' || mode === 'DISABLED') throw actionError('ACTION_MODE_DISABLED');
  if (mode !== ACTION_MODE) throw actionError('ACTION_MODE_REFUSED');
  return Object.freeze({ mode: ACTION_MODE, policyVersion: ACTION_POLICY_VERSION, portVersion: ACTION_PORT_VERSION });
}

export interface BoundConnection { system: string; status: string; externalTenantId: string; secretRef: string; lifecycleVersion: number }
/** The action may target only an existing atera FIXTURE connection of the request's client (production is refused). */
export function assertActionConnection(connection: BoundConnection | null): asserts connection is BoundConnection {
  if (!connection || connection.system !== 'atera' || connection.status !== 'FIXTURE') throw actionError('ACTION_CONNECTION_REFUSED');
}
export const ACTION_CONTRACT = Object.freeze({ actionType: ACTION_TYPE, actionVersion: ACTION_VERSION });
