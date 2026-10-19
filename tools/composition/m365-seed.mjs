import { randomUUID } from 'node:crypto';

/** Only the new, owner-controlled synthetic composition transaction calls this helper.
 * One user and one cloud registration have real scoped published metadata. Neither is a canonical machine/person.
 * The secret reference cannot resolve; opening the overview must never activate or synchronize it.
 */
export async function seedM365Overview(db, workspaceId, clientId) {
  const connectionId = `m365-${clientId}`;
  await db.query(`INSERT INTO "Connection"
    ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status,"boundBy","boundAt","lifecycleVersion")
    VALUES ($1,$2,$3,'microsoft365',$4,'fixture://no-credentials','ACTIVE','composition-actor-1',now(),1)`,
  [workspaceId, clientId, connectionId, randomUUID()]);
  for (const resourceType of ['m365_user', 'm365_device']) {
    const device = resourceType === 'm365_device';
    const age = device ? "interval '2 hours'" : "interval '1 minute'";
    const source = randomUUID(), mirror = `external-${connectionId}-${resourceType}`, generation = `generation-${resourceType}`;
    const dto = device
      ? { id: source, deviceId: randomUUID(), displayName: 'Synthetic hidden M365 device', accountEnabled: true, operatingSystem: 'Synthetic OS' }
      : { id: source, displayName: 'Synthetic hidden M365 user', userPrincipalName: 'synthetic-hidden@example.invalid', userType: 'MEMBER', accountEnabled: true };
    await db.query(`INSERT INTO "ExternalEntity" ("workspaceId","clientId",id,"connectionId","resourceType","externalId",attributes,"observedAt")
      VALUES ($1,$2,$3,$4,$5,$6,'{}',now())`, [workspaceId, clientId, mirror, connectionId, resourceType, source]);
    await db.query(`INSERT INTO "M365ResourceState"
      ("workspaceId","clientId","connectionId","resourceType") VALUES ($1,$2,$3,$4)`,
    [workspaceId, clientId, connectionId, resourceType]);
    await db.query(`UPDATE "M365ResourceState" SET "latestStartedSeq"=1,"attemptsUsed"=1
      WHERE "workspaceId"=$1 AND "clientId"=$2 AND "connectionId"=$3 AND "resourceType"=$4`,
    [workspaceId, clientId, connectionId, resourceType]);
    await db.query(`INSERT INTO "M365DirectoryGeneration"
      ("workspaceId","clientId","connectionId","resourceType",id,"attemptSeq","lifecycleVersion","claimToken","leaseExpiresAt","startedAt","expiresAt")
      VALUES ($1,$2,$3,$4,$5,1,1,gen_random_uuid(),now()+interval '10 minutes',now()-${age}-interval '1 second',now()-${age}-interval '1 second'+interval '24 hours')`,
    [workspaceId, clientId, connectionId, resourceType, generation]);
    await db.query(`INSERT INTO "M365DirectoryObject"
      ("workspaceId","clientId","connectionId","resourceType","generationId","sourceObjectId","externalEntityId","deviceId",dto)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [workspaceId, clientId, connectionId, resourceType, generation, source, mirror, device ? dto.deviceId : null, JSON.stringify(dto)]);
    await db.query(`UPDATE "M365DirectoryGeneration" SET state='PUBLISHED',"completedAt"=now()-${age},"expiresAt"=now()-${age}+interval '24 hours',"rowCount"=1,"claimToken"=NULL,"leaseExpiresAt"=NULL
      WHERE "workspaceId"=$1 AND "clientId"=$2 AND "connectionId"=$3 AND id=$4`, [workspaceId, clientId, connectionId, generation]);
    await db.query(`UPDATE "M365ResourceState" SET "activeGenerationId"=$5,"latestRecordedSeq"=1,"latestPublishedSeq"=1,
      "lastSuccessAt"=now()-${age},"lastAttemptAt"=now()-${age},"attemptsUsed"=0,status='OK'
      WHERE "workspaceId"=$1 AND "clientId"=$2 AND "connectionId"=$3 AND "resourceType"=$4`, [workspaceId, clientId, connectionId, resourceType, generation]);
  }
}
