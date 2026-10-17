import { randomUUID } from 'node:crypto';
import { sql } from './database.mjs';
import { sourceKey } from './plan.mjs';

const literal = value => `N'${String(value).replaceAll("'", "''")}'`;
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function assertTicketWork(f) {
  if (!f || !guid.test(f.customerId) || !guid.test(f.ticketId) || f.externalId !== 910002
    || f.title !== 'Synthetic saved service ticket' || typeof f.importedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(f.importedAt)
    || !Number.isFinite(Date.parse(f.importedAt))) throw new Error('Invalid confined saved-ticket fixture.');
}

/** Synthetic saved Service data belongs only to this newly migrated, owned SQL fixture. */
export async function seedTicketWork(state) {
  const customerId = state.plan.clients[0].crmCustomerId;
  const ticketId = randomUUID(); const linkId = randomUUID();
  const importedAt = new Date().toISOString();
  const externalId = 910002; const ownerCustomerId = 900002;
  const title = 'Synthetic saved service ticket';
  assertTicketWork({ customerId, ticketId, externalId, title, importedAt });
  await sql(state, `SET QUOTED_IDENTIFIER ON;
    INSERT INTO integration.ExternalLinks
    (Id,EntityType,EntityId,System,ExternalType,ExternalId,Method,LinkedAt,LinkedBy)
    VALUES (${literal(linkId)},N'Organization',${literal(customerId)},N'atera',N'Customer',N'${ownerCustomerId}',N'Manual',${literal(importedAt)},NULL);
    INSERT INTO service.Tickets
    (Id,System,ExternalId,OrganizationId,Title,Status,IsOpen,CreatedAtSource,SyncedAt,OwnerCustomerId,OwnerLinkId,ImportedAt)
    VALUES (${literal(ticketId)},N'atera',${externalId},${literal(customerId)},${literal(title)},N'Open',1,
      ${literal(importedAt)},${literal(importedAt)},${ownerCustomerId},${literal(linkId)},${literal(importedAt)});`);
  state.ticketWork = { customerId, ticketId, externalId, title, importedAt };
}

/** Fixed durable facts for the ninth UI scenario; no arbitrary browser SQL is accepted. */
export async function ticketWorkEvidence(state) {
  const f = state.ticketWork;
  assertTicketWork(f);
  const technician = state.employees.find(employee => employee.role === 'Crm.Technician').id;
  const admin = state.employees.find(employee => employee.role === 'Crm.Admin').id;
  const key = sourceKey(state.plan.target.atlasClientId, state.plan.target.observationIdOutsideFirst100);
  const text = await sql(state, `DECLARE @task uniqueidentifier=(SELECT ActivityId FROM activities.SourceTaskLinks
    WHERE SourceKey=${literal(key)});
    SELECT
      (SELECT COUNT(*) FROM time.TimeEntries WHERE SourceActivityId=@task) timeCount,
      (SELECT COUNT(*) FROM time.TimeEntries WHERE SourceActivityId=@task AND TicketId=${literal(f.ticketId)}
        AND OrganizationId=${literal(f.customerId)} AND ExternalTicketId=${f.externalId}
        AND TicketTitle=${literal(f.title)} AND TechnicianId=${literal(admin)} AND Hours=0.75 AND Source=N'Crm') matchingTimeCount,
      (SELECT COUNT(*) FROM audit.AuditEntries a JOIN time.TimeEntries t ON t.Id=a.EntityId
        WHERE t.SourceActivityId=@task AND a.Module=N'time' AND a.Action=N'Create') timeCreateAuditCount,
      (SELECT COUNT(*) FROM time.TimeEntryCreateReceipts r JOIN time.TimeEntries t ON t.Id=r.TimeEntryId
        WHERE t.SourceActivityId=@task AND r.RequestedBy=${literal(admin)}) receiptCount,
      CAST(CASE WHEN EXISTS(SELECT 1 FROM activities.Activities WHERE Id=@task AND LinkedTicketId=${literal(f.ticketId)}
        AND AssigneeId=${literal(technician)} AND Status=N'Done' AND Body IS NULL) THEN 1 ELSE 0 END AS bit) taskPreserved
      FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
  return JSON.parse(text.trim());
}
