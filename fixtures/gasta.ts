import type { Scope, Actor, Person, Device, ExternalLink } from '../packages/core/contracts.ts';
// Synthetic fixtures. No ID here may be assumed to exist in any real Atera, Huntress or Microsoft account.
export const scope: Scope = { workspaceId: 'demo-vardahei', clientId: 'demo-gasta' };
export const actor: Actor = {
  id: 'demo-technician', workspaceId: scope.workspaceId,
  memberships: [{ clientId: scope.clientId, permissions: ['context:read', 'events:ingest'] }],
  workspacePermissions: ['security_audit:read']
};
export const people: Person[] = [{ ...scope, id: 'demo-kari', displayName: 'Kari (synthetic)', email: 'kari@example.invalid' }];
export const devices: Device[] = [{ ...scope, id: 'demo-device-07', hostname: 'GASTA-LT-07', personId: 'demo-kari' }];
export const links: ExternalLink[] = [
  { ...scope, connectionId: 'demo-atera-connection', system: 'atera', resourceType: 'agent', externalId: 'demo-atera-agent-107', entityId: 'demo-device-07', entityKind: 'DEVICE', status: 'CONFIRMED' },
  { ...scope, connectionId: 'demo-huntress-connection', system: 'huntress', resourceType: 'agent', externalId: 'demo-huntress-agent-207', entityId: 'demo-device-07', entityKind: 'DEVICE', status: 'CONFIRMED' }
];
