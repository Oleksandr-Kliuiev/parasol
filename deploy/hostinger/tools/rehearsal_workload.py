"""Synthetic persistence exercise only; never authenticate or call a working provider.

Owner-seeded rows exercise native backup/restore, not HTTP admission or replay. The
scoped API workflows are covered separately by the CRM browser suites (apps/crm/web/e2e).
"""
from dataclasses import dataclass, field
import hashlib
import json
import re
import uuid

AT = '2026-10-17T12:00:00+00:00'
DESCRIPTION = 'Reviewed synthetic recovery work'
SQL_TABLES = ('identity.Users', 'customers.Organizations', 'integration.ExternalLinks',
              'service.Tickets', 'activities.Activities', 'activities.SourceTaskLinks',
              'time.TimeEntries', 'time.TimeEntryCreateReceipts')
PG_TABLES = ('Workspace', 'Client', 'Connection', 'RawEvent', 'Observation')


def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def sql_table(value):
    # identity is a reserved T-SQL word. All table names come from SQL_TABLES.
    return '.'.join('[' + part + ']' for part in value.split('.'))


@dataclass(frozen=True)
class Workload:
    technician: str = field(default_factory=lambda: str(uuid.uuid4()))
    organization: str = field(default_factory=lambda: str(uuid.uuid4()))
    external_link: str = field(default_factory=lambda: str(uuid.uuid4()))
    ticket: str = field(default_factory=lambda: str(uuid.uuid4()))
    task: str = field(default_factory=lambda: str(uuid.uuid4()))
    time_entry: str = field(default_factory=lambda: str(uuid.uuid4()))
    request: str = field(default_factory=lambda: str(uuid.uuid4()))
    workspace: str = field(default_factory=lambda: 'recovery-' + uuid.uuid4().hex)
    client: str = 'synthetic-client'
    observation: str = 'synthetic-observation'

    @property
    def source_key(self):
        return digest(compact(['SourceTaskV1', 'Atlas', self.workspace, self.client,
                               self.observation, 'Task']))

    @property
    def intent_hash(self):
        # This one ASCII case follows TimeEntryCreateIntent's normalization/order.
        # It makes the stored receipt realistic; it is not an API replay test.
        return digest(compact(dict(OrganizationId=self.organization, TechnicianId=self.technician,
            WorkDate='2026-10-17', Hours='0.25', WorkType='Remote', Billable=True,
            Onsite=False, AfterHours=False, Description=DESCRIPTION, ProjectId=None,
            TicketId=self.ticket, SourceActivityId=self.task,
            ExternalTicketId=None, TicketTitle=None))).upper()


def require_stack(stack, *, writable=False):
    allowed = ('rehearsal',) if writable else ('rehearsal', 'restore')
    cfg = stack.meta.get('compose', {})
    if (stack.meta.get('kind') not in allowed or cfg.get('ISOLATED') != 'true'
            or cfg.get('BIND_ADDRESS') != '127.0.0.1' or cfg.get('READ_ONLY') != 'true'):
        raise ValueError('Workload requires a quarantined synthetic rehearsal stack')


def seed(stack):
    require_stack(stack, writable=True)
    f = Workload()
    empty = '\n'.join(f"IF EXISTS (SELECT 1 FROM {sql_table(table)}) THROW 51041, 'Rehearsal business tables must be empty', 1;"
                      for table in SQL_TABLES)
    stack.sql(f"""SET NOCOUNT ON; SET XACT_ABORT ON; SET QUOTED_IDENTIFIER ON;
BEGIN TRANSACTION;
{empty}
INSERT [identity].[Users]
 (Id,TenantId,ObjectId,UserPrincipalName,DisplayName,IsActive,Roles,RolesVersion,PreferredLanguage,CreatedAt,IsDeleted)
 VALUES ('{f.technician}','synthetic-recovery','{f.technician}','synthetic-recovery@example.invalid',
 'Synthetic recovery technician',1,'Crm.Technician',1,'en','{AT}',0);
INSERT [customers].[Organizations] (Id,Name,Status,EhfEnabled,Domains,RegistryStatus,BilledThroughParent,CreatedAt,IsDeleted)
 VALUES ('{f.organization}','Synthetic recovery customer','Customer',0,'[]','Unknown',0,'{AT}',0);
INSERT [integration].[ExternalLinks] (Id,EntityType,EntityId,System,ExternalType,ExternalId,Method,LinkedAt,LinkedBy)
 VALUES ('{f.external_link}','Organization','{f.organization}','atera','Customer','900029','Manual','{AT}','{f.technician}');
INSERT [service].[Tickets]
 (Id,System,ExternalId,OrganizationId,Title,Status,IsOpen,CreatedAtSource,SyncedAt,OwnerCustomerId,OwnerLinkId,ImportedAt)
 VALUES ('{f.ticket}','atera',910029,'{f.organization}','Synthetic recovery ticket','Open',1,
 '{AT}','{AT}',900029,'{f.external_link}','{AT}');
INSERT [activities].[Activities]
 (Id,Type,OrganizationId,Subject,Priority,Status,AssigneeId,DueAt,LinkedTicketId,CreatedAt,CreatedBy,IsDeleted)
 VALUES ('{f.task}','Task','{f.organization}','Review technical observation','High','Open',
 '{f.technician}','2030-01-01T12:00:00+00:00','{f.ticket}','{AT}','{f.technician}',0);
INSERT [activities].[SourceTaskLinks]
 (SourceKey,ActivityId,System,WorkspaceId,ClientId,ObservationId,TargetKind,CreatedAt,CreatedBy)
 VALUES ('{f.source_key}','{f.task}','Atlas','{f.workspace}','{f.client}','{f.observation}','Task','{AT}','{f.technician}');
INSERT [time].[TimeEntries]
 (Id,Source,OrganizationId,TechnicianId,TicketId,SourceActivityId,ExternalTicketId,TicketTitle,
 WorkDate,Hours,WorkType,Billable,Onsite,AfterHours,Description,Status,ApprovalCount,CreatedAt,CreatedBy,IsDeleted)
 VALUES ('{f.time_entry}','Crm','{f.organization}','{f.technician}','{f.ticket}','{f.task}',910029,
 'Synthetic recovery ticket','2026-10-17',0.25,'Remote',1,0,0,'{DESCRIPTION}','New',0,'{AT}','{f.technician}',0);
INSERT [time].[TimeEntryCreateReceipts] (ClientRequestId,RequestedBy,IntentHash,TimeEntryId,AcceptedAt)
 VALUES ('{f.request}','{f.technician}','{f.intent_hash}','{f.time_entry}','{AT}');
COMMIT;""", 'Crm')
    # Empty whole workspace directory, not just an identifier chosen to avoid collisions.
    stack.pg(f"""BEGIN;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM "Workspace") THEN
 RAISE EXCEPTION 'Rehearsal workspaces must be empty'; END IF; END $$;
INSERT INTO "Workspace" (id,name) VALUES ('{f.workspace}','Synthetic recovery workspace');
INSERT INTO "Client" ("workspaceId",id,name) VALUES ('{f.workspace}','{f.client}','Synthetic recovery client');
INSERT INTO "Connection"
 ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status,"boundBy","boundAt")
 VALUES ('{f.workspace}','{f.client}','synthetic-connection','atera','synthetic-tenant',
 'fixture://no-credentials','FIXTURE','recovery-seeder','{AT}');
INSERT INTO "RawEvent"
 ("workspaceId","clientId",id,"connectionId","resourceType","externalEventId",revision,
 "eventKey",normalized,"payloadHash","occurredAt",status)
 VALUES ('{f.workspace}','{f.client}','synthetic-event','synthetic-connection','alert','{f.observation}','1',
 '{digest(f.workspace + f.observation)}','{{"kind":"DISK_CAPACITY","summary":"Synthetic recovery observation"}}',
 '{digest('Synthetic recovery observation')}','{AT}','PROCESSED');
INSERT INTO "Observation"
 ("workspaceId","clientId",id,"eventId",domain,severity,"severityRank",priority,route,
 confidence,provider,"promptVersion","reasonCodes",status,"createdAt","updatedAt")
 VALUES ('{f.workspace}','{f.client}','{f.observation}','synthetic-event','OPERATIONS','HIGH',3,
 'URGENT','HUMAN_REVIEW',1,'rules','recovery-rules-v1',ARRAY['RULES_BASELINE'],'OPEN','{AT}','{AT}');
COMMIT;""")
    return f


def sql_selectors(f):
    return (f"Id='{f.technician}'", f"Id='{f.organization}'", f"Id='{f.external_link}'",
            f"Id='{f.ticket}'", f"Id='{f.task}'", f"SourceKey='{f.source_key}'",
            f"Id='{f.time_entry}'", f"ClientRequestId='{f.request}'")


def capture(stack, f):
    require_stack(stack)
    # SQLCMD truncates long nvarchar output by default: hash inside SQL Server.
    # FOR JSON includes every stored column, including binary rowversions and nulls.
    queries = ['SET NOCOUNT ON;']
    for index, (table, selector) in enumerate(zip(SQL_TABLES, sql_selectors(f))):
        table = sql_table(table)
        queries.append(f"""IF (SELECT COUNT(*) FROM {table} WHERE {selector}) <> 1
 THROW 51042, 'Rehearsal workflow row missing', 1;
DECLARE @row{index} nvarchar(max)=(SELECT * FROM {table} WHERE {selector} FOR JSON PATH, INCLUDE_NULL_VALUES);
SELECT CONVERT(varchar(64),HASHBYTES('SHA2_256',CONVERT(varbinary(max),@row{index})),2);""")
    lines = stack.sql('\n'.join(queries), 'Crm').decode().split()
    if len(lines) != len(SQL_TABLES) or not all(re.fullmatch('[A-F0-9]{64}', line) for line in lines):
        raise RuntimeError('Incomplete SQL workload fingerprint')
    result = dict(zip(SQL_TABLES, lines))
    selects = []
    for index, table in enumerate(PG_TABLES):
        selector = f'id={literal(f.workspace)}' if table == 'Workspace' else f'"workspaceId"={literal(f.workspace)}'
        selects.append(f"SELECT {index} n, jsonb_build_object('table','{table}','rows',"
                       f"(SELECT jsonb_agg(to_jsonb(t)) FROM \"{table}\" t WHERE {selector})) value")
    raw = stack.pg('SELECT value FROM (' + ' UNION ALL '.join(selects) + ') rows ORDER BY n;')
    records = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    if len(records) != len(PG_TABLES):
        raise RuntimeError('Incomplete PostgreSQL workload fingerprint')
    for table, record in zip(PG_TABLES, records):
        if record.get('table') != table or not isinstance(record.get('rows'), list) or len(record['rows']) != 1:
            raise RuntimeError('PostgreSQL workload row missing or ambiguous')
        result['atlas.' + table] = digest(json.dumps(record['rows'], sort_keys=True, separators=(',', ':')))
    return result


def verify_integrity(stack, f):
    require_stack(stack)
    # Verify actual relations plus permanent identities, not only independent row counts.
    stack.sql(f"""SET NOCOUNT ON;
IF (SELECT COUNT(*) FROM [activities].[SourceTaskLinks] s
 JOIN [activities].[Activities] a ON a.Id=s.ActivityId
 JOIN [service].[Tickets] t ON t.Id=a.LinkedTicketId
 JOIN [time].[TimeEntries] e ON e.SourceActivityId=a.Id AND e.TicketId=t.Id
 JOIN [time].[TimeEntryCreateReceipts] r ON r.TimeEntryId=e.Id
 JOIN [identity].[Users] u ON u.Id=a.AssigneeId AND u.Id=e.TechnicianId AND u.Id=r.RequestedBy
 JOIN [customers].[Organizations] o ON o.Id=a.OrganizationId AND o.Id=e.OrganizationId AND o.Id=t.OrganizationId
 JOIN [integration].[ExternalLinks] l ON l.Id=t.OwnerLinkId AND l.EntityId=o.Id
 WHERE s.SourceKey='{f.source_key}' AND s.WorkspaceId='{f.workspace}' AND s.ClientId='{f.client}'
 AND s.ObservationId='{f.observation}' AND s.TargetKind='Task' AND s.System='Atlas'
 AND r.ClientRequestId='{f.request}' AND r.IntentHash='{f.intent_hash}' AND e.Hours=0.25
 AND a.Status='Open' AND a.IsDeleted=0 AND e.IsDeleted=0 AND e.Status='New'
 AND t.OwnerCustomerId=900029 AND l.ExternalId='900029' AND t.ExternalId=e.ExternalTicketId) <> 1
 THROW 51043, 'Restored workflow relations changed', 1;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_SourceTaskLinks_Activities_ActivityId'
 AND parent_object_id=OBJECT_ID('activities.SourceTaskLinks') AND is_disabled=0 AND is_not_trusted=0)
 OR NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('activities.SourceTaskLinks')
 AND name='IX_SourceTaskLinks_ActivityId' AND is_unique=1 AND is_disabled=0)
 OR NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('time.TimeEntryCreateReceipts')
 AND name='PK_TimeEntryCreateReceipts' AND is_primary_key=1 AND is_disabled=0)
 THROW 51044, 'Restored workflow keys changed', 1;""", 'Crm')
    for login in ('parasol_web', 'parasol_worker'):
        stack.sql(f"""EXECUTE AS LOGIN='{login}';
IF ISNULL(HAS_PERMS_BY_NAME('time.TimeEntryCreateReceipts','OBJECT','SELECT'),0) <> 1
 OR ISNULL(HAS_PERMS_BY_NAME('time.TimeEntryCreateReceipts','OBJECT','UPDATE'),1) <> 0
 OR ISNULL(HAS_PERMS_BY_NAME('time.TimeEntryCreateReceipts','OBJECT','DELETE'),1) <> 0
 THROW 51045, 'Runtime receipt permissions changed', 1;
REVERT;""", 'Crm')
    value = stack.pg(f"""SELECT count(*) FROM "Observation" o JOIN "RawEvent" e
 ON e."workspaceId"=o."workspaceId" AND e."clientId"=o."clientId" AND e.id=o."eventId"
 WHERE o."workspaceId"='{f.workspace}' AND o."clientId"='{f.client}'
 AND o.id='{f.observation}' AND o.status='OPEN' AND e.status='PROCESSED';""").decode().strip()
    if value != '1':
        raise RuntimeError('Restored Atlas observation relation changed')


def mutate_after_backup(stack, f, before):
    require_stack(stack, writable=True)
    stack.sql(f"""SET NOCOUNT ON; SET XACT_ABORT ON; SET QUOTED_IDENTIFIER ON; BEGIN TRANSACTION;
UPDATE [activities].[Activities] SET Subject='Synthetic work after backup' WHERE Id='{f.task}';
UPDATE [time].[TimeEntries] SET Hours=0.50 WHERE Id='{f.time_entry}'; COMMIT;""", 'Crm')
    stack.pg(f"""UPDATE "Observation" SET status='ACKNOWLEDGED',"acknowledgedAt"=now(),
 "acknowledgedBy"='recovery-seeder',"updatedAt"=now() WHERE "workspaceId"='{f.workspace}'
 AND "clientId"='{f.client}' AND id='{f.observation}';""")
    after = capture(stack, f)
    changed = {table for table in before if before[table] != after.get(table)}
    if changed != {'activities.Activities', 'time.TimeEntries', 'atlas.Observation'}:
        raise RuntimeError('Post-backup workload mutation was not isolated and effective')


def verify_restored(stack, f, before):
    after = capture(stack, f)
    if set(before) != set(SQL_TABLES) | {'atlas.' + table for table in PG_TABLES} or before != after:
        raise RuntimeError('Restored workload fingerprint changed')
    verify_integrity(stack, f)
    return {'sqlRows': len(SQL_TABLES), 'atlasRows': len(PG_TABLES),
            'exactRowsAndVersions': True, 'relationsAndKeys': True,
            'runtimeReceiptUpdateDeleteDenied': True,
            'ownerSeededPersistenceOnly': True, 'httpReplayTested': False}
