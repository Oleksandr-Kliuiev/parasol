import { z } from 'zod';
import { api } from '../../api/client';
import { parseIdentitySnapshot } from './identityImport';

const responseSchema = z.strictObject({
  status: z.enum(['READY', 'NOT_CONFIGURED', 'ACCESS_DENIED', 'SOURCE_NOT_FOUND', 'UNAVAILABLE', 'INVALID_RESPONSE']),
  snapshot: z.unknown(),
  retrievedAt: z.string().nullable(),
});

/** An explicit fetch, with no query cache or automatic retries. Employee credentials stay in the BFF. */
export async function loadAtlasIdentity(signal: AbortSignal) {
  const { data } = await api.get<unknown>('/api/v1/parasol/customer-identities/atlas-export', signal);
  const result = responseSchema.safeParse(data);
  if (!result.success) return { status: 'INVALID_RESPONSE' as const };
  const view = result.data;
  if (view.status !== 'READY') return { status: view.status };
  if (!view.retrievedAt || !Number.isFinite(Date.parse(view.retrievedAt))) return { status: 'INVALID_RESPONSE' as const };
  try {
    return { status: 'READY' as const, snapshot: parseIdentitySnapshot(JSON.stringify(view.snapshot)), retrievedAt: view.retrievedAt };
  } catch { return { status: 'INVALID_RESPONSE' as const }; }
}
