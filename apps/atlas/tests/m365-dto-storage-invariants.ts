import assert from 'node:assert/strict';
import { parseM365Device, parseM365User } from '../connectors/microsoft365/directory-dto.ts';
import { parseM365SignIn } from '../connectors/microsoft365/signin-dto.ts';
import { rejects } from './sql-invariants.ts';
import type { SqlRunner } from './sql-invariants.ts';
import { guid, seedM365 } from './m365-sql-invariants.ts';

/**
 * Parser → storage at the approved field limits (review S2-A-rc4), shared by PGlite and real PostgreSQL. The DTOs are
 * produced by the real parsers from synthetic Graph rows, then persisted; the SQL aggregate byte caps (directory 4096,
 * sign-in 2048, arithmetic in the migrations) must admit every parser output, while the per-field contract limits, the
 * exact key sets and the caps on otherwise unbounded fields keep rejecting what lies outside. Owner session after seedGraph.
 */
const ASTRAL = '\u{1F600}'; // one code point, four UTF-8 bytes: the largest per-code-point size of a cleaned text field
export const maxUser = () => parseM365User({ id: guid('a').toUpperCase(), displayName: ASTRAL.repeat(300), userPrincipalName: ASTRAL.repeat(400),
  userType: 'Contractor', accountEnabled: false }).dto; // truncated to 256 / 320 code points; unknown type → UNKNOWN
export const maxDevice = () => parseM365Device({ id: guid('b'), deviceId: guid('c'), displayName: ASTRAL.repeat(300), accountEnabled: false,
  operatingSystem: ASTRAL.repeat(200) }).dto;
const signIn = (id: string) => parseM365SignIn({ id, createdDateTime: '2026-10-08T09:30:00.1234567Z', userId: guid('a'), appId: guid('d'),
  deviceDetail: { deviceId: guid('c') }, status: { errorCode: Number.MAX_SAFE_INTEGER }, isInteractive: false });
export const maxSignIn = () => signIn('€'.repeat(256)); // 256 UTF-16 units of a three-byte BMP character
const escapedSignIn = () => signIn('"\\'.repeat(128)); // 256 units that jsonb text escapes

const bytes = async (o: SqlRunner, dto: unknown) => Number((await o.query<{ n: number }>(`SELECT octet_length($1::jsonb::text) AS n`, [JSON.stringify(dto)]))[0]?.n);
const object = (type: string, gen: string, dto: object) => {
  const { id, deviceId } = dto as { id: string; deviceId?: string | null };
  return [`INSERT INTO "M365DirectoryObject" VALUES ('w','c1','m1',$1,$2,$3,NULL,$4,$5::jsonb)`, [type, gen, id, deviceId ?? null, JSON.stringify(dto)]] as const;
};
const evidence = (id: string, dto: { id: string; userId: string | null; deviceId: string | null }) =>
  [`INSERT INTO "M365SignInEvidence" ("workspaceId","clientId","connectionId","id","sourceId","contentHash","dto","occurredAt","userId","deviceId","expiresAt")
    VALUES ('w','c1','m1',$1,$2,$3,$4::jsonb,now(),$5,$6,now() + interval '1 day')`, [id, dto.id, id.length.toString(16).padStart(64, 'e'), JSON.stringify(dto), dto.userId, dto.deviceId]] as const;
const run = (o: SqlRunner, [sql, params]: readonly [string, readonly unknown[]]) => o.query(sql, [...params]);

export async function checkM365DtoStorage(owner: SqlRunner): Promise<void> {
  await seedM365(owner);
  // The derived worst cases, measured by the database exactly as the CHECK measures them
  assert.deepEqual([await bytes(owner, maxUser()), await bytes(owner, maxDevice()), await bytes(owner, maxSignIn()), await bytes(owner, escapedSignIn())],
    [2442, 1701, 1035, 779], 'jsonb text sizes of the largest parser outputs (migration arithmetic)');
  for (const type of ['m365_user', 'm365_device']) {
    await owner.exec(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq") VALUES ('w','c1','m1','${type}',1);
      INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken","leaseExpiresAt","expiresAt")
      VALUES ('w','c1','m1','${type}','max-${type}',1,1,gen_random_uuid(),now() + interval '10 minutes',now() + interval '23 hours')`);
  }
  // Every maximum parser output is persisted and read back unchanged
  const user = maxUser(); const device = maxDevice();
  await run(owner, object('m365_user', 'max-m365_user', user));
  await run(owner, object('m365_device', 'max-m365_device', device));
  const stored = await owner.query<{ dto: unknown }>(`SELECT dto FROM "M365DirectoryObject" ORDER BY "resourceType" DESC`);
  assert.deepEqual(stored.map(r => r.dto), [user, device]);
  for (const [id, dto] of [['ev-max', maxSignIn()], ['ev-escaped', escapedSignIn()]] as const) await run(owner, evidence(id, dto));
  assert.deepEqual((await owner.query<{ dto: unknown }>(`SELECT dto FROM "M365SignInEvidence" ORDER BY id DESC`)).map(r => r.dto), [maxSignIn(), escapedSignIn()]);
  // All-null optionals from the parser stay valid (no null-handling regression)
  const sparse = parseM365User({ id: guid('e') }).dto;
  assert.deepEqual(sparse, { id: guid('e'), displayName: null, userPrincipalName: null, userType: null, accountEnabled: null });
  await run(owner, object('m365_user', 'max-m365_user', sparse));

  // Outside the field contract (not producible by the parsers) stays rejected
  const over = (dto: object, field: string, value: unknown) => ({ ...dto, [field]: value, id: guid('f') });
  await rejects(run(owner, object('m365_user', 'max-m365_user', over(user, 'displayName', ASTRAL.repeat(257)))), /dto_check/, 'displayName 257');
  await rejects(run(owner, object('m365_user', 'max-m365_user', over(user, 'userPrincipalName', ASTRAL.repeat(321)))), /dto_check/, 'UPN 321');
  await rejects(run(owner, object('m365_device', 'max-m365_device', { ...over(device, 'operatingSystem', ASTRAL.repeat(129)), deviceId: guid('c') })),
    /dto_check/, 'operatingSystem 129');
  await rejects(run(owner, object('m365_user', 'max-m365_user', { ...over(user, 'displayName', 'x'), mail: 'kari@example.invalid' })), /dto_check/, 'extra field');
  const longId = { ...maxSignIn(), id: '€'.repeat(257) };
  await rejects(run(owner, evidence('ev-257', longId)), /dto_check/, 'opaque ID 257');
  // The aggregate cap still bounds the fields without their own length check in SQL
  await rejects(run(owner, evidence('ev-time', { ...maxSignIn(), id: 'signin-long-time', createdDateTime: 'x'.repeat(2100) } as never)), /dto_check/,
    'oversized createdDateTime string');
  await rejects(owner.query(`INSERT INTO "M365SignInEvidence" ("workspaceId","clientId","connectionId","id","sourceId","contentHash","dto","occurredAt","expiresAt")
    VALUES ('w','c1','m1','ev-num','signin-num','${'9'.repeat(64)}','{"id":"signin-num","createdDateTime":"2026-10-08T09:30:00.000Z","userId":null,"deviceId":null,
    "appId":null,"errorCode":${'1'.repeat(2100)},"isInteractive":null}',now(),now() + interval '1 day')`), /dto_check/, 'oversized numeric errorCode');
}
