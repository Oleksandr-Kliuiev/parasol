import type { M365DeviceV1, M365UserV1 } from '../../connectors/microsoft365/directory-dto.ts';
import type { M365SignInV1 } from '../../connectors/microsoft365/signin-dto.ts';
import type { CorrelationCoverage, CorrelationEvidenceRef, CorrelationEvidenceState, CorrelationResource } from '../correlation/contracts.ts';

/**
 * Frozen S2-C list read contracts (brief RC3). They reuse the correlation resource/coverage contracts unchanged and make no
 * claim of correlation: a sign-in list selects ALL eligible published sign-ins of the interval (no canonicalPersonId,
 * relation or proof); a directory list returns the approved DTOs of the usable active generation only.
 *   items === null iff the data is unavailable (no usable coverage / no usable unexpired generation); [] is an available
 *   empty result, never an all-clear.
 */
export const SIGNIN_LIST_CONTRACT_VERSION = 'atlas.m365-signins.v1';
export const DIRECTORY_LIST_CONTRACT_VERSION = 'atlas.m365-directory.v1';

export interface SignInListItem { evidenceRef: CorrelationEvidenceRef; occurredAt: string; dto: M365SignInV1; evidenceState: CorrelationEvidenceState }
export interface SignInListV1 {
  contractVersion: typeof SIGNIN_LIST_CONTRACT_VERSION; mode: 'fixture' | 'db';
  workspaceId: string; clientId: string; m365ConnectionId: string;
  window: { fromInclusive: string; toExclusive: string };
  resources: CorrelationResource[]; coverage: CorrelationCoverage;
  items: SignInListItem[] | null;
  total: number; truncated: boolean; nextCursor: string | null;
}
export interface DirectoryListV1 {
  contractVersion: typeof DIRECTORY_LIST_CONTRACT_VERSION; mode: 'fixture' | 'db';
  workspaceId: string; clientId: string; m365ConnectionId: string;
  resourceType: 'm365_user' | 'm365_device'; resource: CorrelationResource;
  /** Ordered by sourceObjectId ascending (C collation). STALE retained generations remain usable. */
  items: M365UserV1[] | M365DeviceV1[] | null;
  total: number; truncated: boolean; nextCursor: string | null;
}
