SET NOCOUNT ON;
-- An INSERT with the column list of the pre-DEV-01 model, as the previous application version would send during a rollback window.
INSERT INTO billing.BillingLines (Id, BasisId, [Group], ProductId, Description, Quantity, UnitPrice, DiscountPct, VatRate, LineTotal, SourceRefs, ManuallyAdjusted, CreatedAt, IsDeleted)
VALUES (NEWID(), '22222222-0000-0000-0000-000000000001', 'OneOff', NULL, 'Inserted by the old model', 1, 10, 0, 25, 10, NULL, 1, SYSDATETIMEOFFSET(), 0);
SELECT Description, Origin, Decision, Conflict, ManuallyAdjusted FROM billing.BillingLines WHERE Description = 'Inserted by the old model';
