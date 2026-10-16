import type { Prisma } from '@prisma/client';
import { SYNTHETIC_COMPANY_PATTERN, SYNTHETIC_SECRET_REF_PATTERN } from './contracts.ts';

/**
 * The fixed synthetic PowerOffice binding (docs/stage4/02_CONTRACTS.md): system=poweroffice, externalTenantId
 * synthetic-po-<lower-case UUID> and secretRef fixture://poweroffice/<the same UUID>, recorded boundBy/boundAt and
 * lifecycleVersion > 0. Read with a plain scoped SELECT behind the workspace fence (never a Connection row lock: the
 * installed Connection mutation trigger takes the tuple before the fence). The secret reference is compared, never
 * resolved, returned or audited. Source work needs FIXTURE; recover/cleanup close-out also accepts DISABLED in the same
 * immutable synthetic binding (no reactivation). No auto-binding, activation or onboarding exists.
 */
export type BindingUse = 'source' | 'read' | 'closeout';
export interface Binding { readonly companyKey: string; readonly lifecycleVersion: number; readonly status: 'FIXTURE' | 'DISABLED' }
export interface ConnectionRow {
  system: string; status: string; externalTenantId: string; secretRef: string; boundBy: string | null; boundAt: Date | null; lifecycleVersion: number;
}
export type BindingCheck = { binding: Binding } | { refused: 'POWEROFFICE_NOT_FOUND' | 'POWEROFFICE_CONNECTION_UNAVAILABLE' };

export function checkBinding(row: ConnectionRow | null, use: BindingUse): BindingCheck {
  if (row === null || row.system !== 'poweroffice') return { refused: 'POWEROFFICE_NOT_FOUND' };
  const company = SYNTHETIC_COMPANY_PATTERN.exec(row.externalTenantId);
  const secret = SYNTHETIC_SECRET_REF_PATTERN.exec(row.secretRef);
  const shape = company !== null && secret !== null && company[1] === secret[1] && row.boundBy !== null && row.boundAt !== null
    && Number.isSafeInteger(row.lifecycleVersion) && row.lifecycleVersion > 0;
  const status = row.status === 'FIXTURE' || (use === 'closeout' && row.status === 'DISABLED');
  if (!shape || !status) return { refused: 'POWEROFFICE_CONNECTION_UNAVAILABLE' };
  return { binding: Object.freeze({ companyKey: row.externalTenantId, lifecycleVersion: row.lifecycleVersion, status: row.status as 'FIXTURE' | 'DISABLED' }) };
}

/** Plain scoped Connection read (RLS: the transaction's workspace/client scope); null when invisible or unknown. */
export async function readConnection(tx: Prisma.TransactionClient, workspaceId: string, clientId: string, connectionId: string): Promise<ConnectionRow | null> {
  return tx.connection.findUnique({ where: { workspaceId_clientId_id: { workspaceId, clientId, id: connectionId } },
    select: { system: true, status: true, externalTenantId: true, secretRef: true, boundBy: true, boundAt: true, lifecycleVersion: true } });
}
