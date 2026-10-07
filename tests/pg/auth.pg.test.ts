import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../../packages/auth/prisma-auth.ts';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { actor } from '../../fixtures/gasta.ts';
import { createTestDatabase, runSeed, singleConnection } from '../support/pg-harness.ts';

// Task 1.3 authentication on a real PostgreSQL 17 server: the seeded synthetic actor resolves from a bearer token through
// the runtime role and the lookup policies; only a digest is stored; revoked, expired, unknown and disabled all fail.
const pgdb = await createTestDatabase();
const runtime = new PrismaClient({ datasourceUrl: singleConnection(pgdb.runtimeUrl) });
after(async () => { await runtime.$disconnect(); await pgdb.drop(); });
const token = generateToken();
runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: token });

test('a seeded bearer token resolves to the verified actor with per-client memberships and workspace permissions', async () => {
  assert.deepEqual(await authenticateToken(runtime, token), actor);
  assert.equal(await runtime.actor.count(), 0, 'no lookup context survives the authentication transaction');
  assert.equal(await runtime.apiToken.count(), 0);
});

test('only the SHA-256 digest of the token is stored; the token itself appears nowhere in the identity tables', async () => {
  const rows = (await pgdb.owner.query(`SELECT "tokenHash" FROM "ApiToken"`)).rows;
  assert.deepEqual(rows.map(r => r.tokenHash), [hashToken(token)]);
  const dump = (await pgdb.owner.query(`SELECT (SELECT jsonb_agg(t) FROM "ApiToken" t)::text || (SELECT jsonb_agg(a) FROM "Actor" a)::text AS s`)).rows[0].s as string;
  assert.ok(!dump.includes(token));
});

test('unknown, revoked and expired tokens and disabled actors do not authenticate', async () => {
  assert.equal(await authenticateToken(runtime, generateToken()), null);
  assert.equal(await authenticateToken(runtime, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null);
  const extra = generateToken();
  await pgdb.owner.query(`INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash","expiresAt") VALUES ('demo-vardahei','short-lived',$1,$2, now() + interval '1 hour')`, [actor.id, hashToken(extra)]);
  assert.equal((await authenticateToken(runtime, extra))?.id, actor.id);
  assert.equal(await authenticateToken(runtime, extra, new Date(Date.now() + 2 * 3600_000)), null, 'expired');
  await pgdb.owner.query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'short-lived'`);
  assert.equal(await authenticateToken(runtime, extra), null, 'revoked');
  await pgdb.owner.query(`UPDATE "Actor" SET status = 'DISABLED' WHERE id = $1`, [actor.id]);
  assert.equal(await authenticateToken(runtime, token), null, 'disabled actor');
  await pgdb.owner.query(`UPDATE "Actor" SET status = 'ACTIVE' WHERE id = $1`, [actor.id]);
  assert.equal((await authenticateToken(runtime, token))?.id, actor.id);
});

test('re-seeding keeps the graph and rotates the local demo token: the old token stops working, the new one works', async () => {
  const rotated = generateToken();
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: rotated });
  assert.equal(await authenticateToken(runtime, token), null);
  assert.deepEqual(await authenticateToken(runtime, rotated), actor);
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "ClientMembership"`)).rows[0].n), actor.memberships.length);
});
