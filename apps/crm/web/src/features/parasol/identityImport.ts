import { z } from 'zod';

export const IDENTITY_REQUEST_LIMIT = 1_048_576;
const atlasId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.literal('atlas'),
  workspaceId: atlasId,
  clients: z.array(z.strictObject({ clientId: atlasId, name: z.string().max(256).refine(s => s.trim().length > 0) })).max(1000),
}).refine(s => new Set(s.clients.map(c => c.clientId)).size === s.clients.length);

export type AtlasIdentitySnapshot = z.infer<typeof snapshotSchema>;
export interface SelectedCustomer { id: string; name: string }
export interface IdentityImport {
  snapshot: AtlasIdentitySnapshot;
  mappings: { atlasClientId: string; customerId: string }[];
}
export interface IdentityPlan {
  sha256: string; dryRun: boolean; canApply: boolean; unmappedClients: number;
  rows: { atlasClientId: string; customerId: string; outcome: string }[];
}
export interface CustomerIdentity {
  customerId: string;
  atlas: { workspaceId: string; clientId: string } | null;
  linkId: string | null;
}
export class IdentityInputError extends Error {
  constructor(readonly code: 'invalidFile' | 'tooLarge' | 'noSelection' | 'duplicateCustomer') { super(code); }
}

/** Only the identity export is accepted. Unknown fields never reach the server or browser storage. */
export function parseIdentitySnapshot(text: string): AtlasIdentitySnapshot {
  if (new TextEncoder().encode(text).byteLength > IDENTITY_REQUEST_LIMIT) throw new IdentityInputError('tooLarge');
  try { return snapshotSchema.parse(JSON.parse(text)); }
  catch { throw new IdentityInputError('invalidFile'); }
}

export function readIdentityFile(file: File): Promise<AtlasIdentitySnapshot> {
  if (file.size > IDENTITY_REQUEST_LIMIT) return Promise.reject(new IdentityInputError('tooLarge'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new IdentityInputError('invalidFile'));
    reader.onload = () => {
      try { resolve(parseIdentitySnapshot(String(reader.result))); }
      catch (error) { reject(error); }
    };
    reader.readAsText(file);
  });
}

export function buildIdentityImport(snapshot: AtlasIdentitySnapshot, selected: ReadonlyMap<string, SelectedCustomer>): IdentityImport {
  const mappings = snapshot.clients.flatMap(c => {
    const customer = selected.get(c.clientId);
    return customer ? [{ atlasClientId: c.clientId, customerId: customer.id }] : [];
  });
  if (!mappings.length) throw new IdentityInputError('noSelection');
  if (new Set(mappings.map(m => m.customerId.toLowerCase())).size !== mappings.length) throw new IdentityInputError('duplicateCustomer');
  const body = { snapshot, mappings };
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > IDENTITY_REQUEST_LIMIT) throw new IdentityInputError('tooLarge');
  return body;
}

export function canConfirmIdentityPlan(plan: IdentityPlan): boolean {
  return plan.dryRun && plan.canApply && /^[a-f0-9]{64}$/.test(plan.sha256) && plan.rows.length > 0
    && plan.rows.every(r => r.outcome === 'READY' || r.outcome === 'ALREADY_LINKED');
}
