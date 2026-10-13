import { loadOperatorAssets } from './assets.ts';
import { operatorMiddleware } from './http.ts';

/**
 * ATLAS_OPERATOR_UI (docs/stage5/03_SECURITY_AND_STATE.md): unset or `0` — disabled, the API is unchanged and needs no
 * console files; `1` — enabled; any other value, including an empty string, refuses to start.
 */
export function operatorUiEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error('ATLAS_OPERATOR_UI must be unset, 0 or 1');
}

/**
 * The console middleware for this process, or null when disabled. Enabled with missing or inconsistent assets fails
 * closed (OPERATOR_UI_ASSETS_UNAVAILABLE) before the server listens. `assetDirectory` is derived by main.ts from its own
 * module location (dist/operator next to dist/apps), so it does not depend on the working directory.
 */
export async function prepareOperatorConsole(flag: string | undefined, port: number, assetDirectory: string, extraHosts: readonly string[] = []) {
  if (!operatorUiEnabled(flag)) return null;
  return operatorMiddleware(port, await loadOperatorAssets(assetDirectory), extraHosts);
}
