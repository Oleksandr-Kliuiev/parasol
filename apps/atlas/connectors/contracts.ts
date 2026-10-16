import type { Scope, System, ResourceType, NormalizedEvent, SnapshotItem } from '../packages/core/contracts.ts';
import type { HttpTransport } from './http.ts';
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
/**
 * A COMPLETE read of one live resource: every page fetched and validated. A partial read never produces this. `events`
 * are the same records as normalized events for the durable inbox (task 1.6); empty for resources that are not event
 * sources in Stage 1 (tickets).
 */
export interface SnapshotRead { resourceType: ResourceType; items: SnapshotItem[]; itemCount: number; contractVersion: string; events: NormalizedEvent[] }
/** An identity object (agent in Stage 1) as a bounded, safe attribute projection, for registerExternalEntity. */
export interface IdentityRead { resourceType: 'agent' | 'contact'; externalId: string; attributes: Record<string, string>; observedAt: string }
export interface AtlasConnector {
  readonly system: System;
  /** Live resources this connector reads WITH an upstream tenant filter (docs/01, condition 5). */
  readonly snapshotResources: readonly ResourceType[];
  /** Resources Atlas deliberately does not read from this source, with the reason code shown in the context. */
  readonly unavailableResources: Readonly<Partial<Record<ResourceType, string>>>;
  healthCheck(connection: ResolvedConnection): Promise<ConnectionHealth>;
  readSnapshot(connection: ResolvedConnection, resourceType: ResourceType): Promise<SnapshotRead>;
  readIdentities(connection: ResolvedConnection): Promise<IdentityRead[]>;
  /** Durable event sync (task 1.6) and single-record reads by source ID (task 1.9) are added with those tasks. */
  sync?(context: SyncContext): Promise<SyncResult>;
  resolveExternalEntity?(ref: ExternalEntityRef): Promise<{ externalId: string; resourceType: ResourceType; safeAttributes: Record<string, string> }>;
}
/** What a connector gets from its composition: the transport and, in memory only, the credential of an issued connection. */
export interface ConnectorDeps { transport: HttpTransport; credential(connection: ResolvedConnection): Promise<string> }
// Credentials belong to a vault, scoped to workspace/client/connection; never to entities or AI input.
// secretRef is a stable name; rotating the value in the vault needs no Connection update.
export interface SecretResolver { resolve(secretRef: string, connection: ResolvedConnection): Promise<string> }
