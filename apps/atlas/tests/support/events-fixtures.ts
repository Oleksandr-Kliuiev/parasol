import type { PrismaClient } from '@prisma/client';
import type { Classification, DecisionMode, NormalizedEvent, Provider, Severity } from '../../packages/core/contracts.ts';
import type { DecisionProvider } from '../../packages/decisions/provider.ts';
import { rulesBaseline } from '../../packages/decisions/provider.ts';
import type { ResolvedConnection } from '../../connectors/contracts.ts';
import { EnvSecretResolver } from '../../connectors/secrets.ts';
import { bindConnection, resolveConnection } from '../../packages/connections/connections.ts';
import { activateConnection } from '../../packages/sync/activation.ts';
import { registerExternalEntity, proposeLink, confirmLink } from '../../packages/graph/mapping.ts';
import { actors, gasta } from './graph-fixtures.ts';
import { gastaVendor, testSecrets } from './vendor-routes.ts';

/**
 * Event-pipeline fixtures (tests/pg): a live (mock-vendor) Huntress connection for Gasta whose agent 207001 is CONFIRMED
 * as demo-device-07, synthetic incident events, and a provider that counts its calls.
 */
export async function liveHuntressWithConfirmedAgent(db: PrismaClient): Promise<{ connection: ResolvedConnection; vendor: ReturnType<typeof gastaVendor>; io: { transport: ReturnType<typeof gastaVendor>['transport']; secrets: EnvSecretResolver } }> {
  const vendor = gastaVendor();
  const io = { transport: vendor.transport, secrets: new EnvSecretResolver(testSecrets) };
  await bindConnection(db, actors.admin, gasta, { connectionId: 'gasta-huntress', system: 'huntress', externalTenantId: '7001', secretRef: 'env://HUNTRESS_GASTA' });
  await activateConnection(db, actors.admin, gasta, 'gasta-huntress', io);
  const connection = await resolveConnection(db, actors.sync, gasta, 'gasta-huntress', 'sync');
  const agent = await registerExternalEntity(db, actors.sync, connection, { resourceType: 'agent', externalId: '207001', attributes: { hostname: 'GASTA-LT-07' }, observedAt: new Date() });
  const link = await proposeLink(db, actors.reviewer, gasta, { externalEntityId: agent.id, entityId: 'demo-device-07' });
  await confirmLink(db, actors.reviewer, gasta, link.linkId);
  return { connection, vendor, io };
}

/** A synthetic Huntress-incident event on the connection (Atlas-normalized shape; not a vendor payload). */
export function incident(connection: ResolvedConnection, id: string, severity: Severity, options: { revision?: string; agent?: string | null; summary?: string } = {}): NormalizedEvent {
  const revision = options.revision ?? '2026-10-07T06:45:00.000Z';
  const summary = options.summary ?? `Synthetic incident ${id}`;
  return { workspaceId: connection.workspaceId, clientId: connection.clientId, source: 'huntress', connectionId: connection.connectionId, resourceType: 'incident',
    externalEventId: id, revision, externalDevice: options.agent === null ? null : { resourceType: 'agent', externalId: options.agent ?? '207001' },
    occurredAt: '2026-10-07T06:40:00.000Z', receivedAt: new Date().toISOString(), kind: 'SECURITY_INCIDENT', sourceSeverity: severity, summary, facts: { signal: summary } };
}

/** A provider that counts calls; `answer` decides per call (a thrown error is a provider failure). Defaults to the rules baseline. */
export class CountingProvider implements DecisionProvider {
  calls = 0;
  readonly provider: Provider; readonly mode: DecisionMode;
  readonly #answer: (event: NormalizedEvent) => Classification;
  constructor(mode: DecisionMode = 'rules', provider: Provider = 'rules', answer: (event: NormalizedEvent) => Classification = e => rulesBaseline(e)) {
    this.mode = mode; this.provider = provider; this.#answer = answer;
  }
  async classify(event: NormalizedEvent): Promise<Classification> { this.calls++; return this.#answer(event); }
}
