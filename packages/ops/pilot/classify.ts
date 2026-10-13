import { AtlasError } from '../../core/contracts.ts';
import { ATERA_BASE_URL } from '../../../connectors/atera/contract.ts';
import { HUNTRESS_BASE_URL } from '../../../connectors/huntress/contract.ts';
import { AUTHORITY_ORIGIN, TENANT_GUID, tokenEndpoint } from '../../../connectors/microsoft365/contract.ts';
import type { M365Endpoint } from '../../../connectors/microsoft365/contract.ts';
import { assertGraphUrl } from '../../../connectors/microsoft365/http.ts';

/**
 * In-memory destination classification of the S2-LIVE pilot recorder (operational brief RC5 §L4), decided BEFORE any
 * dispatch. Only the fixed production origins of the accepted connectors are admitted, each through one transport kind and
 * one method: the Microsoft identity authority (POST token only), Graph v1.0 (GET, the accepted Graph URL rule itself) and
 * the Stage 1 Atera/Huntress read paths (GET). The class name is fixed vocabulary — never text taken from the URL. Userinfo,
 * a port, a fragment, any other scheme/origin/path/method or an unexpected query parameter refuses the request.
 */
export const ENDPOINT_CLASSES = ['m365.token', 'graph.organization', 'graph.users', 'graph.devices', 'graph.signIns',
  'atera.customer', 'atera.tickets', 'atera.agents', 'huntress.organization', 'huntress.incidents', 'huntress.agents'] as const;
export type EndpointClass = (typeof ENDPOINT_CLASSES)[number];
export type TransportKind = 'stage1' | 'graph' | 'auth';
export type DispatchMethod = 'GET' | 'POST';

export const destinationRefused = () => new AtlasError('PILOT_DESTINATION_REFUSED', 'PERMANENT');
export const methodRefused = () => new AtlasError('PILOT_METHOD_REFUSED', 'PERMANENT');

const GRAPH_CLASSES: readonly [M365Endpoint, EndpointClass][] = [['organization', 'graph.organization'], ['users', 'graph.users'],
  ['devices', 'graph.devices'], ['signIns', 'graph.signIns']];
interface Stage1Rule { cls: EndpointClass; origin: string; path: RegExp; query: readonly string[]; requiredQuery: readonly string[] }
const ID = '[1-9][0-9]{0,15}';
const STAGE1_RULES: readonly Stage1Rule[] = [
  { cls: 'atera.customer', origin: ATERA_BASE_URL, path: new RegExp(`^/api/v3/customers/${ID}$`), query: [], requiredQuery: [] },
  { cls: 'atera.tickets', origin: ATERA_BASE_URL, path: /^\/api\/v3\/tickets$/, query: ['customerId', 'ticketStatus', 'page', 'itemsInPage'], requiredQuery: ['customerId'] },
  { cls: 'atera.agents', origin: ATERA_BASE_URL, path: new RegExp(`^/api/v3/agents/customer/${ID}$`), query: ['page', 'itemsInPage'], requiredQuery: [] },
  { cls: 'huntress.organization', origin: HUNTRESS_BASE_URL, path: new RegExp(`^/v1/organizations/${ID}$`), query: [], requiredQuery: [] },
  { cls: 'huntress.incidents', origin: HUNTRESS_BASE_URL, path: /^\/v1\/incident_reports$/, query: ['organization_id', 'limit', 'status', 'page_token'],
    requiredQuery: ['organization_id'] },
  { cls: 'huntress.agents', origin: HUNTRESS_BASE_URL, path: /^\/v1\/agents$/, query: ['organization_id', 'limit', 'page_token'], requiredQuery: ['organization_id'] },
];

/** https, no userinfo/port/fragment, and the raw text literally starts with origin + path (what is checked is what is sent). */
function parseStrict(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192 || /[\s\u0000-\u001f\u007f\\#]/.test(raw)) throw destinationRefused();
  let url: URL;
  try { url = new URL(raw); } catch { throw destinationRefused(); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') throw destinationRefused();
  const prefix = `${url.origin}${url.pathname}`;
  if (!raw.startsWith(prefix) || (raw.length > prefix.length && raw[prefix.length] !== '?')) throw destinationRefused();
  return url;
}

function stage1Class(raw: string): EndpointClass {
  const url = parseStrict(raw);
  const rule = STAGE1_RULES.find(r => url.origin === r.origin && r.path.test(url.pathname));
  if (!rule) throw destinationRefused();
  const names = [...url.searchParams.keys()];
  if (new Set(names).size !== names.length || names.some(n => !rule.query.includes(n)) || rule.requiredQuery.some(n => !names.includes(n))) throw destinationRefused();
  return rule.cls;
}

function graphClass(raw: string): EndpointClass {
  parseStrict(raw);
  for (const [endpoint, cls] of GRAPH_CLASSES) {
    try { assertGraphUrl(raw, endpoint, 'M365_URL_REFUSED'); return cls; } catch { /* next endpoint */ }
  }
  throw destinationRefused();
}

function authClass(raw: string): EndpointClass {
  const url = parseStrict(raw);
  const tenant = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url.pathname)?.[1];
  if (url.origin !== AUTHORITY_ORIGIN || tenant === undefined || !TENANT_GUID.test(tenant) || raw !== tokenEndpoint(tenant)) throw destinationRefused();
  return 'm365.token';
}

const KIND_METHOD: Readonly<Record<TransportKind, DispatchMethod>> = Object.freeze({ stage1: 'GET', graph: 'GET', auth: 'POST' });
/** The fixed class of one request of this transport kind; throws PILOT_METHOD_REFUSED / PILOT_DESTINATION_REFUSED. */
export function classifyDispatch(kind: TransportKind, url: unknown, method: unknown): { endpointClass: EndpointClass; method: DispatchMethod } {
  if (method !== KIND_METHOD[kind]) throw methodRefused();
  if (typeof url !== 'string') throw destinationRefused();
  const endpointClass = kind === 'stage1' ? stage1Class(url) : kind === 'graph' ? graphClass(url) : authClass(url);
  return { endpointClass, method: KIND_METHOD[kind] };
}
