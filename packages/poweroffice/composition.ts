import { builtInExportPort } from '../../connectors/poweroffice/builtin.ts';
import type { ExportSession, PageControl, PowerOfficeExportPort, SessionPins } from '../../connectors/poweroffice/contract.ts';
import { powerOfficeError } from './contracts.ts';

/**
 * Trusted PowerOffice composition (docs/stage4/01_SPEC.md "First slice boundaries", 04 "Built in port"). The mode defaults
 * to DISABLED; the only opt-in is the exact value MOCK, which composes the built-in synthetic export
 * (connectors/poweroffice/builtin.ts). Anything else — another spelling, LIVE, or any variable that would configure an
 * origin, URL, port, script, callback, fixture file, tenant, credential or clock — refuses. A composition is an opaque frozen
 * object; its port lives in this module's private WeakMap, so a fabricated or serialized composition is unknown
 * (POWEROFFICE_MODE_UNSUPPORTED). Services never accept a port, callback, script, file, URL, tenant or clock from a caller.
 *
 * testFaultComposition is a PRIVATE IN-PROCESS TEST SEAM (tests only; never reachable from the environment, a flag or a
 * file): every page still goes through the real built-in port and its session rules; the fault only observes, delays,
 * transforms or replaces what a call returns, so tests can exercise malformed, inconsistent, slow or failing sources.
 */
export const POWEROFFICE_MODE_VARIABLE = 'ATLAS_POWEROFFICE_MODE';
export const POWEROFFICE_MOCK_MODE = 'MOCK';
/** Variables that would configure a transport, source, credential or clock; their mere presence refuses composition. */
export const POWEROFFICE_REFUSED_VARIABLES: readonly string[] = Object.freeze(['ATLAS_POWEROFFICE_ORIGIN', 'ATLAS_POWEROFFICE_URL',
  'ATLAS_POWEROFFICE_BASE_URL', 'ATLAS_POWEROFFICE_PORT', 'ATLAS_POWEROFFICE_SCRIPT', 'ATLAS_POWEROFFICE_CALLBACK', 'ATLAS_POWEROFFICE_FILE',
  'ATLAS_POWEROFFICE_FIXTURE_FILE', 'ATLAS_POWEROFFICE_LIVE', 'ATLAS_POWEROFFICE_TENANT', 'ATLAS_POWEROFFICE_CLIENT_KEY',
  'ATLAS_POWEROFFICE_APPLICATION_KEY', 'ATLAS_POWEROFFICE_TOKEN', 'ATLAS_POWEROFFICE_SECRET_REF', 'ATLAS_POWEROFFICE_CLOCK']);

export interface PowerOfficeComposition { readonly mode: typeof POWEROFFICE_MOCK_MODE; readonly synthetic: true }
const ports = new WeakMap<PowerOfficeComposition, PowerOfficeExportPort>();
function compose(port: PowerOfficeExportPort): PowerOfficeComposition {
  const composition: PowerOfficeComposition = Object.freeze({ mode: POWEROFFICE_MOCK_MODE, synthetic: true as const });
  ports.set(composition, port);
  return composition;
}

/** From the process environment: DISABLED unless exactly MOCK (POWEROFFICE_DISABLED); anything else MODE_UNSUPPORTED. */
export function powerOfficeComposition(env: Readonly<Record<string, string | undefined>>): PowerOfficeComposition {
  if (POWEROFFICE_REFUSED_VARIABLES.some(v => env[v] !== undefined && env[v] !== '')) throw powerOfficeError('POWEROFFICE_MODE_UNSUPPORTED');
  const mode = env[POWEROFFICE_MODE_VARIABLE];
  if (mode === undefined || mode === '' || mode === 'DISABLED') throw powerOfficeError('POWEROFFICE_DISABLED');
  if (mode !== POWEROFFICE_MOCK_MODE) throw powerOfficeError('POWEROFFICE_MODE_UNSUPPORTED');
  return compose(builtInExportPort());
}

/** The composed port of a genuine composition; anything else refuses before any database or source work. */
export function compositionPort(composition: unknown): PowerOfficeExportPort {
  const port = typeof composition === 'object' && composition !== null ? ports.get(composition as PowerOfficeComposition) : undefined;
  if (port === undefined) throw powerOfficeError('POWEROFFICE_MODE_UNSUPPORTED');
  return port;
}

/** One page call as the test seam sees it: the ordinal, the control and the real built-in call (at most once per ordinal). */
export interface SourceFaultCall { readonly ordinal: number; readonly control: PageControl; builtIn(): Promise<unknown> }
export type SourceFault = (call: SourceFaultCall) => Promise<unknown>;
/** TEST-ONLY (see the module comment): a MOCK composition whose built-in pages pass through `fault`. */
export function testFaultComposition(fault: SourceFault): PowerOfficeComposition {
  const base = builtInExportPort();
  return compose(Object.freeze({
    openSession: (pins: SessionPins) => base.openSession(pins),
    readPage: (session: ExportSession, ordinal: number, control: PageControl) =>
      Promise.resolve().then(() => fault(Object.freeze({ ordinal, control, builtIn: () => base.readPage(session, ordinal, control) }))),
    closeSession: (session: ExportSession) => base.closeSession(session),
  }));
}
