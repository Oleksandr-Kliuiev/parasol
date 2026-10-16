import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../../packages/auth/prisma-auth.ts';
import { bindConnection, resolveConnection, resolveConnectionForActivation } from '../../packages/connections/connections.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { atlasTools } from '../../packages/tools/composed-registry.ts';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, KEY_A, WS, addPowerOfficeFixtures, connect, inTx, scopeOf, tokens } from '../support/poweroffice-fixtures.ts';
import { claimAttempt, publishAttempt } from '../support/poweroffice-history.ts';

// S4-A item 7 on PostgreSQL 17: PowerOffice stays out of every generic Stage 1 path. resolveConnection and the activation
// resolution refuse a PowerOffice connection before any secret resolver could see it; the bindable-system allowlist is
// unchanged (no bind/onboard); ClientContextV1 and the Gateway tool registry expose no PowerOffice data or tool.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtime = await connect(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const managerToken = generateToken();
await pgdb.owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, 'manager', 'Synthetic')`, [WS]);
await pgdb.owner.query(`INSERT INTO "ClientMembership" ("workspaceId", "clientId", "actorId", permissions) VALUES ($1, $2, 'manager', $3)`,
  [WS, CA, ['context:read', 'events:ingest', 'connections:manage', 'poweroffice:read']]);
await pgdb.owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-manager', 'manager', $2)`, [WS, hashToken(managerToken)]);
// Canary aggregate published through the runtime: none of these values may surface through generic paths.
const CANARY = { totalCount: 1, currencies: [{ currency: 'SEK', count: 1, openInvoiceCount: 1, overdueInvoiceCount: 1, creditNoteCount: 0,
  outstandingInvoiceAmount: '73519.47', outstandingCreditAmount: '0.00' }] };
const claim = await inTx(runtime, scopeOf(KEY_A), c => claimAttempt(c, KEY_A, 'syncer'));
await inTx(runtime, scopeOf(KEY_A), c => publishAttempt(c, KEY_A, claim, CANARY));

test('generic connection resolution refuses PowerOffice (sync, read and activation purposes) before any resolver; binding PowerOffice is invalid', async () => {
  const manager = (await authenticateToken(prisma, managerToken))!;
  const scope = { workspaceId: WS, clientId: CA };
  for (const purpose of ['read', 'sync'] as const) {
    await assert.rejects(resolveConnection(prisma, manager, scope, 'po-a', purpose), /POWEROFFICE_DEDICATED_AUTHORITY_REQUIRED/, purpose);
  }
  await assert.rejects(resolveConnectionForActivation(prisma, manager, scope, 'po-disabled'), /POWEROFFICE_DEDICATED_AUTHORITY_REQUIRED/);
  const atera = await resolveConnection(prisma, manager, scope, 'atera-a', 'read');
  assert.equal(atera.system, 'atera', 'other systems resolve as before');
  await assert.rejects(bindConnection(prisma, manager, scope, { connectionId: 'po-new', system: 'poweroffice',
    externalTenantId: 'synthetic-po-00000000-0000-4000-8000-000000000009', secretRef: 'fixture://poweroffice/00000000-0000-4000-8000-000000000009' }), /INVALID_BINDING/);
  assert.equal((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "Connection" WHERE id = 'po-new'`)).rows[0].n, 0);
});

test('ClientContextV1 and the Gateway registry expose no PowerOffice summary, state or tool', async () => {
  const reader = (await authenticateToken(prisma, tokens.reader!))!;
  const context = JSON.stringify(await getClientContext(prisma, reader, { workspaceId: WS, clientId: CA }));
  for (const canary of ['73519.47', claim.allocatedSnapshotId, claim.id, 'PowerOffice', 'totalCount', 'synthetic-po-', 'fixture://poweroffice']) {
    assert.ok(!context.includes(canary), `context leaks ${canary}`);
  }
  assert.deepEqual(atlasTools.filter(t => /power|office|invoice|financ/i.test(`${t.name} ${JSON.stringify(t)}`)).map(t => t.name), []);
});
