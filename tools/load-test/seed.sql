-- DEV-16 synthetic data only. local.py creates and verifies the database ownership marker.
-- Fixed IDs, dates and distributions; each INSERT is bounded by @Batch (no giant transaction).
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @Organizations int = $(Organizations), @Contacts int = $(Contacts),
        @Tickets int = $(Tickets), @TimeEntries int = $(TimeEntries), @Audit int = $(Audit),
        @Batch int = 10000, @Start int = 1, @End int;
IF NOT EXISTS (SELECT 1 FROM sys.extended_properties WHERE class = 0 AND name = 'DEV16.Owner' AND CONVERT(nvarchar(128),value) = '$(Owner)')
    THROW 51160, 'Synthetic database ownership mismatch.', 1;
IF EXISTS (SELECT 1 FROM customers.Organizations) OR EXISTS (SELECT 1 FROM audit.AuditEntries)
    THROW 51161, 'Seed requires an empty migrated database.', 1;
CREATE TABLE #N (n int NOT NULL PRIMARY KEY);
WITH d(n) AS (SELECT n FROM (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))v(n))
INSERT #N SELECT 1+a.n+10*b.n+100*c.n+1000*d.n FROM d a CROSS JOIN d b CROSS JOIN d c CROSS JOIN d;

INSERT customers.Organizations (Id,Name,Status,EhfEnabled,Domains,RegistryStatus,CreatedAt,IsDeleted,InvoiceEmail)
SELECT CONVERT(uniqueidentifier,CONCAT('16160001-0000-0000-0000-',RIGHT(CONCAT('000000000000',n),12))),
       CONCAT('Synthetic DEV16 Organization ',FORMAT(n,'00000')), 'Customer',0,'[]','Active','2021-10-05',0,CONCAT('invoice',n,'@example.invalid')
FROM #N WHERE n <= @Organizations;
WHILE @Start <= @Contacts
BEGIN
    INSERT customers.Contacts (Id,FirstName,LastName,Email,CreatedAt,IsDeleted)
    SELECT CONVERT(uniqueidentifier,CONCAT('16160002-0000-0000-0000-',RIGHT(CONCAT('000000000000',n+@Start-1),12))),
        'Synthetic', CONCAT('DEV16 Contact ',n+@Start-1),CONCAT('contact',n+@Start-1,'@example.invalid'),'2021-10-05',0
    FROM #N WHERE n+@Start-1 <= @Contacts;
    INSERT customers.OrganizationContacts (Id,OrganizationId,ContactId,Roles,IsPrimary,IsActive,CreatedAt,IsDeleted)
    SELECT CONVERT(uniqueidentifier,CONCAT('16160003-0000-0000-0000-',RIGHT(CONCAT('000000000000',n+@Start-1),12))),
        CONVERT(uniqueidentifier,CONCAT('16160001-0000-0000-0000-',RIGHT(CONCAT('000000000000',(n+@Start-2)%@Organizations+1),12))),
        CONVERT(uniqueidentifier,CONCAT('16160002-0000-0000-0000-',RIGHT(CONCAT('000000000000',n+@Start-1),12))),
        8,CASE WHEN n+@Start-1 <= @Organizations THEN 1 ELSE 0 END,1,'2021-10-05',0
    FROM #N WHERE n+@Start-1 <= @Contacts;
    SET @Start += @Batch;
END;

SET @Start = 1;
WHILE @Start <= @Tickets
BEGIN
    INSERT service.Tickets (Id,System,ExternalId,OrganizationId,Title,Status,IsOpen,Priority,CreatedAtSource,ResolvedAt,SyncedAt,TechnicianName)
    SELECT CONVERT(uniqueidentifier,CONCAT('16160004-0000-0000-0000-',RIGHT(CONCAT('000000000000',i),12))),
        'atera',i,CONVERT(uniqueidentifier,CONCAT('16160001-0000-0000-0000-',RIGHT(CONCAT('000000000000',(i-1)%@Organizations+1),12))),
        CONCAT('Synthetic DEV16 ticket ',i),CASE WHEN i%20=0 THEN 'Open' ELSE 'Resolved' END,CASE WHEN i%20=0 THEN 1 ELSE 0 END,
        CASE WHEN i%5=0 THEN 'High' ELSE 'Medium' END,
        DATEADD(day,-((i*37)%1826),CONVERT(datetimeoffset,'2026-10-04T12:00:00Z')),
        CASE WHEN i%20<>0 THEN DATEADD(day,-((i*37)%1826),CONVERT(datetimeoffset,'2026-10-04T13:00:00Z')) END,
        '2026-10-04','Synthetic technician'
    FROM #N CROSS APPLY (SELECT n+@Start-1 i) v WHERE i<=@Tickets;
    SET @Start += @Batch;
END;

SET @Start = 1;
WHILE @Start <= @TimeEntries
BEGIN
    INSERT time.TimeEntries (Id,Source,ExternalId,OrganizationId,WorkDate,Hours,Billable,Onsite,AfterHours,Status,ApprovalCount,Amount,ApprovedAt,CreatedAt,IsDeleted,TechnicianName)
    SELECT CONVERT(uniqueidentifier,CONCAT('16160005-0000-0000-0000-',RIGHT(CONCAT('000000000000',i),12))),
        'Atera',CONCAT('dev16-',i),CONVERT(uniqueidentifier,CONCAT('16160001-0000-0000-0000-',RIGHT(CONCAT('000000000000',(i-1)%@Organizations+1),12))),
        DATEADD(day,-((i*37)%1826),CONVERT(date,'2026-10-04')),1+(i%8)*0.25,1,0,0,'Invoiced',1,(1+(i%8)*0.25)*1000,'2026-10-04','2021-10-05',0,'Synthetic technician'
    FROM #N CROSS APPLY (SELECT n+@Start-1 i) v WHERE i<=@TimeEntries;
    INSERT time.TimeAllocations (Id,TimeEntryId,Classification,Hours,BilledHours,Rate,Amount,CreatedAt,IsDeleted)
    SELECT CONVERT(uniqueidentifier,CONCAT('16160006-0000-0000-0000-',RIGHT(CONCAT('000000000000',i),12))),
        CONVERT(uniqueidentifier,CONCAT('16160005-0000-0000-0000-',RIGHT(CONCAT('000000000000',i),12))),
        'Rate',1+(i%8)*0.25,1+(i%8)*0.25,1000,(1+(i%8)*0.25)*1000,'2021-10-05',0
    FROM #N CROSS APPLY (SELECT n+@Start-1 i) v WHERE i<=@TimeEntries;
    SET @Start += @Batch;
END;

SET @Start = 1;
WHILE @Start <= @Audit
BEGIN
    INSERT audit.AuditEntries (At,Action,Module,EntityType,EntityId,Changes,CorrelationId)
    SELECT DATEADD(second,i%86400,DATEADD(day,-((i*37)%1826),CONVERT(datetimeoffset,'2026-10-04T00:00:00Z'))),
        'Update','customers','Organization',CONVERT(uniqueidentifier,CONCAT('16160001-0000-0000-0000-',RIGHT(CONCAT('000000000000',(i-1)%@Organizations+1),12))),
        CONCAT('{"syntheticOrdinal":',i,'}'),'DEV16-seed'
    FROM #N CROSS APPLY (SELECT n+@Start-1 i) v WHERE i<=@Audit ORDER BY i;
    SET @Start += @Batch;
END;

INSERT catalog.Products (Id,Sku,Name,Type,BusinessLine,Unit,BillingPeriod,VatRate,ListPrice,UnitCost,Currency,CommitmentTerm,IsActive,CreatedAt,IsDeleted)
VALUES ('16160007-0000-0000-0000-000000000001','DEV16-MSP','Synthetic managed service','ManagedService','Atera','Device','Monthly',25,150,80,'NOK','None',1,'2021-10-05',0);
INSERT contracts.Contracts (Id,Number,OrganizationId,Title,Type,Status,StartDate,EndDate,AutoRenew,RenewalTermMonths,NoticePeriodDays,InvoiceFrequency,InvoiceTiming,Indexation,RenewalCount,CreatedAt,IsDeleted)
SELECT CONVERT(uniqueidentifier,CONCAT('16160008-0000-0000-0000-',RIGHT(CONCAT('000000000000',n),12))),CONCAT('DEV16-',n),
    CONVERT(uniqueidentifier,CONCAT('16160001-0000-0000-0000-',RIGHT(CONCAT('000000000000',n),12))),
    'Synthetic managed service','Msp','Active','2026-09-01','2026-12-31',0,0,30,'Monthly','InAdvance',0,0,'2026-09-01',0 FROM #N WHERE n<=500;
INSERT contracts.ContractLines (Id,ContractId,SeriesId,Version,ProductId,QuantityModel,DeviceFilter,Quantity,UnitPrice,DiscountPct,ValidFrom,CreatedAt,IsDeleted)
SELECT CONVERT(uniqueidentifier,CONCAT('16160009-0000-0000-0000-',RIGHT(CONCAT('000000000000',n),12))),
    CONVERT(uniqueidentifier,CONCAT('16160008-0000-0000-0000-',RIGHT(CONCAT('000000000000',n),12))),
    CONVERT(uniqueidentifier,CONCAT('16160009-0000-0000-0000-',RIGHT(CONCAT('000000000000',n),12))),
    1,'16160007-0000-0000-0000-000000000001','Fixed','All',10,150,0,'2026-09-01','2026-09-01',0 FROM #N WHERE n<=500;
INSERT integration.ExternalLinks (Id,EntityType,EntityId,System,ExternalType,ExternalId,Method,LinkedAt)
SELECT CONVERT(uniqueidentifier,CONCAT('16160010-0000-0000-0000-',RIGHT(CONCAT('000000000000',n),12))),
    'Organization',CONVERT(uniqueidentifier,CONCAT('16160001-0000-0000-0000-',RIGHT(CONCAT('000000000000',n),12))),
    'poweroffice','Customer',CONVERT(varchar(20),n),'Manual','2026-09-01' FROM #N WHERE n<=500;
INSERT integration.ExternalLinks (Id,EntityType,EntityId,System,ExternalType,ExternalId,Method,LinkedAt)
VALUES ('16160010-0000-0000-0000-000000005001','Product','16160007-0000-0000-0000-000000000001','poweroffice','Product','1','Manual','2026-09-01');
-- Seed insertion is not measured application traffic; update statistics before warming caches.
EXEC sp_updatestats;
