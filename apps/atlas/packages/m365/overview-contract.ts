/** Parasol stored-data summary; separate from the frozen Stage 1 and Stage 2 DTO contracts.
 * Counts are directory records, not physical machines, licensed seats or a security verdict.
 * No directory DTO, tenant/vendor ID, credential, sign-in row or free-text error crosses this boundary.
 */
export const M365_OVERVIEW_VERSION = 'atlas.m365-overview.v1';
export const M365_OVERVIEW_CONNECTION_LIMIT = 8;
export type OverviewResourceStatus = 'OK' | 'STALE' | 'MISSING' | 'ERROR';
export interface M365OverviewDirectory {
  resourceType: 'm365_user' | 'm365_device'; status: OverviewResourceStatus;
  count: number | null; asOf: string | null; lastSuccessAt: string | null;
}
export interface M365OverviewSignIns {
  status: OverviewResourceStatus; coverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  freshness: 'FRESH' | 'STALE' | 'MIXED' | 'UNKNOWN';
  asOf: string | null; lastSuccessAt: string | null;
  gaps: { fromInclusive: string; toExclusive: string }[];
}
export interface M365OverviewConnection {
  connectionId: string; directory: M365OverviewDirectory[]; signIns: M365OverviewSignIns;
}
export interface M365OverviewV1 {
  contractVersion: typeof M365_OVERVIEW_VERSION; mode: 'db'; workspaceId: string; clientId: string;
  assessedAt: string;
  /** Exactly the preceding 24 complete UTC hours. Current incomplete hour is excluded. */
  window: { fromInclusive: string; toExclusive: string };
  totalConnections: number; truncated: boolean; connections: M365OverviewConnection[];
}
