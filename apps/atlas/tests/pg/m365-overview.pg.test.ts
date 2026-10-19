import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readM365Overview } from '../../packages/m365/overview.ts';
import { setupM365Database, addActiveM365Connection } from '../support/m365-pg.ts';
import { addReader, reader, publishScenarioDirectory, publishGeneration, publishSignIns } from '../support/correlation-fixtures.ts';
import { M365_CONNECTION, M365_TENANT } from '../support/m365-fixtures.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { addOperator } from '../support/m365-cli.ts';
import { hourStart } from '../support/m365-signin-mock.ts';
import { startApi } from '../support/api-process.ts';
import type { Actor } from '../../packages/core/contracts.ts';

const { pgdb, db } = await setupM365Database();
await addReader(pgdb.owner);
await publishScenarioDirectory(pgdb.owner, 'overview');
const token = await addOperator(pgdb.owner, reader.id, ['context:read','m365:read']);
const singleToken = await addOperator(pgdb.owner, 'overview-single', ['context:read']);
const api = await startApi({ ATLAS_MODE:'db', ATLAS_RUNTIME_DATABASE_URL:pgdb.runtimeUrl, ATLAS_ASK_MODE:'off' });
after(async () => { await api.stop(); await db.$disconnect(); await pgdb.drop(); });
const q = async (sql: string, params: unknown[] = []) => (await pgdb.owner.query(sql,params)).rows;
const get = (suffix='', bearer=token, client='demo-gasta') => fetch(`${api.base}/clients/${client}/m365/overview${suffix}`,
  { headers: { authorization:`Bearer ${bearer}` } });

async function directoryConnection(id:string,age:number){
  await addActiveM365Connection(pgdb,id,randomUUID());
  for(const type of ['m365_user','m365_device'] as const){
    const source=randomUUID(); const mirror=`${id}-${type}`;
    await pgdb.owner.query(`INSERT INTO "ExternalEntity" ("workspaceId","clientId",id,"connectionId","resourceType","externalId",attributes,"observedAt")
      VALUES ($1,'demo-gasta',$2,$3,$4,$5,'{}',now())`,[WS,mirror,id,type,source]);
    await publishGeneration(pgdb.owner,type,`gen-${mirror}`,[{source,mirror}],age,24*3600,id);
  }
}

const disable=(id:string)=>pgdb.owner.query(`UPDATE "Connection" SET status='DISABLED',"lifecycleVersion"="lifecycleVersion"+1 WHERE id=$1`,[id]);

test('stored overview: real confined snapshot, current directory counts, exact 24 complete UTC hours, no source DTOs', async () => {
  const res = await get(); assert.equal(res.status,200); assert.equal(res.headers.get('cache-control'),'no-store');
  const view = await res.json();
  assert.deepEqual(Object.keys(view).sort(),['assessedAt','clientId','connections','contractVersion','mode','totalConnections','truncated','window','workspaceId']);
  assert.equal(view.contractVersion,'atlas.m365-overview.v1'); assert.equal(view.mode,'db');
  assert.equal(view.workspaceId,WS); assert.equal(view.clientId,gasta.clientId);
  assert.equal(view.totalConnections,1); assert.equal(view.truncated,false);
  assert.equal(Date.parse(view.window.toExclusive)-Date.parse(view.window.fromInclusive),24*3600000);
  assert.equal(Date.parse(view.window.toExclusive)%3600000,0);
  assert.ok(Date.parse(view.window.toExclusive)<=Date.parse(view.assessedAt));
  const connection=view.connections[0]; assert.equal(connection.connectionId,M365_CONNECTION);
  assert.deepEqual(connection.directory.map((d: {status:string;count:number})=>[d.status,d.count]),[['OK',1],['OK',1]]);
  assert.equal(connection.signIns.coverage,'UNAVAILABLE'); assert.equal(connection.signIns.status,'MISSING');
  assert.deepEqual(connection.signIns.gaps,[view.window]);
  for(const canary of [M365_TENANT,'env://M365_GASTA','Synthetic User','synthetic@example.invalid','operatingSystem','userPrincipalName','dto','safeErrorCode'])
    assert.ok(!JSON.stringify(view).includes(canary),canary);
  const audit=await q(`SELECT "eventType",metadata FROM "AuditEvent" WHERE "correlationId"=$1`,[res.headers.get('x-atlas-correlation-id')]);
  assert.deepEqual(audit,[{eventType:'m365.overview_read',metadata:{itemCount:'1',total:'1'}}]);
});

test('ordinary overview cannot resolve credentials or invoke fetch, sync or a provider',async()=>{
  const before=await q(`SELECT count(*)::int n FROM "M365DirectoryGeneration"`);
  const saved=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('Unexpected upstream I/O');};
  try { assert.equal((await readM365Overview(db,reader,gasta)).connections[0]!.directory[0]!.count,1); }
  finally { globalThis.fetch=saved; }
  assert.deepEqual(await q(`SELECT count(*)::int n FROM "M365DirectoryGeneration"`),before);
  assert.equal((await q(`SELECT count(*)::int n FROM "M365SyncRequest"`))[0].n,0);
});

test('HTTP rejects query overrides, absent auth, single permission, another client and malformed client',async()=>{
  assert.equal((await fetch(`${api.base}/clients/demo-gasta/m365/overview`)).status,401);
  for(const query of ['?tenantId=other','?connectionId=other','?clientId=x&clientId=y','?from=2026-10-17','?cursor=old'])
    assert.equal((await get(query)).status,400,query);
  const before=(await q(`SELECT count(*)::int n FROM "SecurityAuditEvent" WHERE "actorId"='overview-single'`))[0].n;
  assert.equal((await get('',singleToken)).status,403);
  const denied=await q(`SELECT "eventType",metadata FROM "SecurityAuditEvent" WHERE "actorId"='overview-single'`);
  assert.equal(denied.length,before+1); assert.deepEqual(denied.at(-1),{eventType:'m365.overview_read_denied',metadata:{}});
  assert.equal((await get('',token,'demo-other')).status,403);
  assert.equal((await get('',token,'bad%20client')).status,403);
});

test('both permissions must be on the same current membership, not actor flags or another client',async()=>{
  const actors:Actor[]=[{id:'overview-m365-only',workspaceId:WS,workspacePermissions:[],memberships:[{clientId:gasta.clientId,permissions:['m365:read']}]},
    {id:'overview-split',workspaceId:WS,workspacePermissions:[],memberships:[{clientId:gasta.clientId,permissions:['context:read']},{clientId:'demo-other',permissions:['context:read','m365:read']}]}];
  for(const actor of actors){
    await addReader(pgdb.owner,actor);
    await assert.rejects(readM365Overview(db,actor,gasta),{code:'PERMISSION_DENIED'});
    assert.equal((await q(`SELECT count(*)::int n FROM "SecurityAuditEvent" WHERE "actorId"=$1 AND "eventType"='m365.overview_read_denied'`,[actor.id]))[0].n,1);
  }
  await pgdb.owner.query(`UPDATE "ClientMembership" SET permissions=ARRAY['context:read'] WHERE "workspaceId"=$1 AND "actorId"=$2`,[WS,reader.id]);
  try { await assert.rejects(readM365Overview(db,reader,gasta),{code:'PERMISSION_DENIED'}); }
  finally { await addReader(pgdb.owner,reader); }
});

test('retained stale directory counts survive; at expiry the same counts are hidden, not converted to zero',async()=>{
  await directoryConnection('overview-stale',3600);
  await directoryConnection('overview-expired',25*3600);
  try{
    const view=await readM365Overview(db,reader,gasta);
    const stale=view.connections.find(c=>c.connectionId==='overview-stale')!;
    assert.deepEqual(stale.directory.map(d=>[d.status,d.count]),[['STALE',1],['STALE',1]]);
    const expired=view.connections.find(c=>c.connectionId==='overview-expired')!;
    assert.deepEqual(expired.directory.map(d=>[d.status,d.count,d.asOf]),[['MISSING',null,null],['MISSING',null,null]]);
  }finally{await disable('overview-stale');await disable('overview-expired');}
  await publishGeneration(pgdb.owner,'m365_user','overview-empty',[]);
  assert.deepEqual((await readM365Overview(db,reader,gasta)).connections[0]!.directory.map(d=>[d.status,d.count]),[['OK',0],['OK',1]]);
});

test('published sign-in traversal contributes only to its actual hour; missing hours remain explicit even with zero events',async()=>{
  const from=hourStart(3); const to=new Date(from.getTime()+3600000);
  await publishSignIns(db,()=>[],from,to);
  const view=await readM365Overview(db,reader,gasta); const signIns=view.connections[0]!.signIns;
  assert.equal(signIns.coverage,'PARTIAL'); assert.ok(['OK','STALE'].includes(signIns.status));
  assert.equal(signIns.gaps.reduce((n,g)=>n+Date.parse(g.toExclusive)-Date.parse(g.fromInclusive),0),23*3600000);
  assert.ok(!JSON.stringify(signIns).includes('publishedAttemptId'));
});

test('disabled and FIXTURE connections cannot expose ordinary evidence; no active connection is not an all-clear',async()=>{
  await pgdb.owner.query(`UPDATE "Connection" SET status='DISABLED',"lifecycleVersion"="lifecycleVersion"+1 WHERE id=$1`,[M365_CONNECTION]);
  try { const view=await readM365Overview(db,reader,gasta); assert.equal(view.totalConnections,0); assert.deepEqual(view.connections,[]); }
  finally { await pgdb.owner.query(`UPDATE "Connection" SET status='ACTIVE',"lifecycleVersion"="lifecycleVersion"+1 WHERE id=$1`,[M365_CONNECTION]); }
});

test('many active bindings are bounded and labelled partial, without selecting another client or exposing secrets',async()=>{
  for(let i=0;i<9;i++) await addActiveM365Connection(pgdb,`overview-extra-${i}`,randomUUID());
  const view=await readM365Overview(db,reader,gasta);
  assert.equal(view.totalConnections,10); assert.equal(view.connections.length,8); assert.equal(view.truncated,true);
  assert.equal(new Set(view.connections.map(c=>c.connectionId)).size,8);
  assert.ok(view.connections.every(c=>c.connectionId===M365_CONNECTION||c.directory.every(d=>d.count===null)));
});
