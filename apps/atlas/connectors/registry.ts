import type { System } from '../packages/core/contracts.ts';
import { AtlasError } from '../packages/core/contracts.ts';
import type { AtlasConnector, ConnectorDeps } from './contracts.ts';
import { createAteraConnector } from './atera/connector.ts';
import { createHuntressConnector } from './huntress/connector.ts';

/** Stage 1 read connectors by system. Microsoft 365 and PowerOffice come with their own slices. */
export function createConnector(system: System, deps: ConnectorDeps): AtlasConnector {
  if (system === 'atera') return createAteraConnector(deps);
  if (system === 'huntress') return createHuntressConnector(deps);
  throw new AtlasError('CONNECTOR_NOT_AVAILABLE', 'PERMANENT');
}
