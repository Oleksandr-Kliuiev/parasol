import type pg from 'pg';
import type { Actor } from '../../packages/core/contracts.ts';

/**
 * Synthetic fixtures for the mapping/connection service tests (tests/pg). Services receive an already verified Actor —
 * authentication is the API's job and is tested there — so these actors exist in code only.
 */
export const WS = 'demo-vardahei';
export const gasta = { workspaceId: WS, clientId: 'demo-gasta' };
export const other = { workspaceId: WS, clientId: 'demo-other' };

const actor = (id: string, memberships: Actor['memberships']): Actor => ({ id, workspaceId: WS, memberships, workspacePermissions: [] });
export const actors = {
  reviewer: actor('demo-reviewer', [{ clientId: 'demo-gasta', permissions: ['context:read', 'mapping:review'] }]),
  sync: actor('demo-sync', [{ clientId: 'demo-gasta', permissions: ['events:ingest'] }, { clientId: 'demo-other', permissions: ['events:ingest'] }]),
  admin: actor('demo-admin', [{ clientId: 'demo-gasta', permissions: ['connections:manage'] }, { clientId: 'demo-other', permissions: ['connections:manage'] }]),
  reader: actor('demo-reader', [{ clientId: 'demo-gasta', permissions: ['context:read'] }])
};

/**
 * After the seed (owner): Gasta gets GASTA-LT-08, two devices whose hostnames differ only in case (GASTA-LT-09) and a
 * second person; a second client gets its own GASTA-LT-08 and an Atera connection. Hostname matching must stay inside
 * the client and treat case-insensitive duplicates as ambiguous.
 */
export async function addMappingFixtures(owner: pg.Client): Promise<void> {
  await owner.query(`
    INSERT INTO "Entity" VALUES ('${WS}','demo-gasta','dev-08','DEVICE'),('${WS}','demo-gasta','dev-09a','DEVICE'),
      ('${WS}','demo-gasta','dev-09b','DEVICE'),('${WS}','demo-gasta','demo-ola','PERSON');
    INSERT INTO "Device" VALUES ('${WS}','demo-gasta','dev-08','GASTA-LT-08',NULL),('${WS}','demo-gasta','dev-09a','GASTA-LT-09',NULL),
      ('${WS}','demo-gasta','dev-09b','gasta-lt-09',NULL);
    INSERT INTO "Person" VALUES ('${WS}','demo-gasta','demo-ola','Ola (synthetic)',NULL);
    INSERT INTO "Client" VALUES ('${WS}','demo-other','Other client (synthetic)');
    INSERT INTO "Entity" VALUES ('${WS}','demo-other','other-dev','DEVICE');
    INSERT INTO "Device" VALUES ('${WS}','demo-other','other-dev','GASTA-LT-08',NULL);
    INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status")
      VALUES ('${WS}','demo-other','other-atera','atera','atera-synthetic-other','fixture://no-credentials','FIXTURE');`);
}
