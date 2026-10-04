SET NOCOUNT ON;
PRINT '== billing data (counts and sums must not change through the DEV-04 migrations)';
SELECT 'runs' AS T, COUNT(*) AS Rows, CHECKSUM_AGG(CHECKSUM(Id, Status, PeriodStart, ContentRevision)) AS Checksum FROM billing.BillingRuns
UNION ALL SELECT 'bases', COUNT(*), CHECKSUM_AGG(CHECKSUM(Id, Status, TotalExVat, OrderNo, Revision)) FROM billing.BillingBases
UNION ALL SELECT 'lines', COUNT(*), CHECKSUM_AGG(CHECKSUM(Id, BasisId, Quantity, UnitPrice, LineTotal, IsDeleted)) FROM billing.BillingLines
UNION ALL SELECT 'charges', COUNT(*), CHECKSUM_AGG(CHECKSUM(Id, [Key], Status, Amount)) FROM billing.Charges
UNION ALL SELECT 'attempts', COUNT(*), CHECKSUM_AGG(CHECKSUM(Id, BasisId, Result)) FROM billing.BillingExportAttempts
UNION ALL SELECT 'audit', COUNT(*), CHECKSUM_AGG(CHECKSUM(Id, [Action], Module, EntityId, UserName)) FROM audit.AuditEntries;
