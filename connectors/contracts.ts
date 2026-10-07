import type { Scope, System, ResourceType, NormalizedEvent } from '../packages/core/contracts.ts';
export interface ConnectionHealth { status: 'OK' | 'DEGRADED' | 'ERROR'; checkedAt: string; safeErrorCode?: string }
/**
 * A connection already resolved and verified by ConnectionsModule: the mapped external customer/organization is passed in
 * explicitly so the adapter filters the upstream request by it. Passing it does not replace the ownership check that
 * produced it; an adapter must never accept a tenant ID from a request body or from AI output.
 */
export interface ResolvedConnection extends Scope { connectionId: string; system: System; externalTenantId: string }
export interface SyncContext extends ResolvedConnection { resourceType: ResourceType; cursor: string | null }
export interface SyncResult { nextCursor: string | null; complete: boolean; events: NormalizedEvent[]; fetchedAt: string }
export interface ExternalEntityRef extends ResolvedConnection { externalId: string; resourceType: ResourceType }
export interface AtlasConnector {
  readonly system: System;
  healthCheck(connection: ResolvedConnection): Promise<ConnectionHealth>;
  sync(context: SyncContext): Promise<SyncResult>;
  resolveExternalEntity(ref: ExternalEntityRef): Promise<{ externalId: string; resourceType: ResourceType; safeAttributes: Record<string, string> }>;
}
// Credentials belong to a vault, scoped to workspace/client/connection; never to entities or AI input.
// secretRef is a stable name; rotating the value in the vault needs no Connection update.
export interface SecretResolver { resolve(secretRef: string, connection: ResolvedConnection): Promise<string> }
