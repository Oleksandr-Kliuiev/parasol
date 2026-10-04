namespace Crm.Billing.Persistence;

/// <summary>
/// The SQL triggers that guard approved billing data whoever writes it (DEV-04): an approved run, its bases, lines, approval
/// acts, charges and export attempts change only the way the application changes them — export progress, order numbers,
/// reconciliation — and never their amounts, content or history. EF Core is told about them (HasTrigger), so it does not use
/// OUTPUT without INTO and keeps its concurrency checks. A database administrator can still disable a trigger; that is an
/// audited administrative act, not something the application identities can do.
/// </summary>
internal static class BillingTriggers
{
    public const string Runs = "trg_BillingRuns_Protect";
    public const string Bases = "trg_BillingBases_Protect";
    public const string Lines = "trg_BillingLines_Protect";
    public const string Approvals = "trg_BillingApprovals_Protect";
    public const string Charges = "trg_Charges_Protect";
    public const string ExportAttempts = "trg_BillingExportAttempts_Protect";

    public static readonly IReadOnlyList<string> All = [Runs, Bases, Lines, Approvals, Charges, ExportAttempts];

    public const string CreateRuns = """
        CREATE OR ALTER TRIGGER [billing].[trg_BillingRuns_Protect] ON [billing].[BillingRuns] AFTER UPDATE, DELETE AS
        BEGIN
            SET NOCOUNT ON;
            -- A released run keeps what it was released with; only its export progress and closing move (ADR-012).
            IF EXISTS (
                SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.Id = d.Id
                WHERE d.Status IN (N'Approved', N'Exporting', N'Exported', N'ExportedWithErrors', N'Closed')
                  AND (i.Id IS NULL
                       OR i.Status NOT IN (N'Approved', N'Exporting', N'Exported', N'ExportedWithErrors', N'Closed')
                       OR (d.Status = N'Closed' AND i.Status <> N'Closed')
                       OR EXISTS (SELECT i.PeriodStart, i.PeriodEnd, i.Kind, i.CollectedAt, i.ApprovedBy, i.SecondApprovedBy, i.ApprovedAt,
                                         i.RequiresSecondApproval, i.ContentRevision, i.ApprovedRevision, i.ApprovedDigest, i.Notes, i.IsDeleted, i.CreatedAt
                                  EXCEPT
                                  SELECT d.PeriodStart, d.PeriodEnd, d.Kind, d.CollectedAt, d.ApprovedBy, d.SecondApprovedBy, d.ApprovedAt,
                                         d.RequiresSecondApproval, d.ContentRevision, d.ApprovedRevision, d.ApprovedDigest, d.Notes, d.IsDeleted, d.CreatedAt)))
                THROW 51001, N'BILLING_APPROVED_IMMUTABLE: an approved billing run cannot be changed or deleted.', 1;
        END
        """;

    public const string CreateBases = """
        CREATE OR ALTER TRIGGER [billing].[trg_BillingBases_Protect] ON [billing].[BillingBases] AFTER INSERT, UPDATE, DELETE AS
        BEGIN
            SET NOCOUNT ON;
            -- A basis starts as a draft; once approved its payer, amounts and content are fixed. Its delivery moves on:
            -- approved, being sent, failed, waiting for reconciliation, exported or cancelled (ADR-013). A draft cancelled in a
            -- run that is still open is not approved content: discarding the run may still remove it.
            IF EXISTS (SELECT 1 FROM inserted i WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.Id = i.Id) AND i.Status <> N'Draft')
                THROW 51002, N'BILLING_APPROVED_IMMUTABLE: a billing basis is created as a draft.', 1;
            IF EXISTS (
                SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.Id = d.Id
                WHERE (d.Status IN (N'Approved', N'Exported', N'Failed', N'ReconciliationRequired')
                       OR (d.Status = N'Cancelled' AND EXISTS (
                              SELECT 1 FROM [billing].[BillingRuns] r
                              WHERE r.Id = d.RunId AND r.Status IN (N'Approved', N'Exporting', N'Exported', N'ExportedWithErrors', N'Closed'))))
                  AND (i.Id IS NULL
                       OR i.Status = N'Draft'
                       OR (d.Status IN (N'Exported', N'Cancelled') AND i.Status <> d.Status)
                       OR EXISTS (SELECT i.RunId, i.OrganizationId, i.IdempotencyKey, i.TotalExVat, i.PreviousPeriodTotal, i.AnomaliesJson,
                                         i.CustomerReference, i.Revision, i.IsDeleted, i.CreatedAt
                                  EXCEPT
                                  SELECT d.RunId, d.OrganizationId, d.IdempotencyKey, d.TotalExVat, d.PreviousPeriodTotal, d.AnomaliesJson,
                                         d.CustomerReference, d.Revision, d.IsDeleted, d.CreatedAt)
                       OR (d.Status = N'Exported' AND EXISTS (SELECT i.OrderNo, i.ExportedAt, i.ExportSystem EXCEPT SELECT d.OrderNo, d.ExportedAt, d.ExportSystem))))
                THROW 51003, N'BILLING_APPROVED_IMMUTABLE: an approved billing basis cannot be changed or deleted.', 1;
        END
        """;

    public const string CreateLines = """
        CREATE OR ALTER TRIGGER [billing].[trg_BillingLines_Protect] ON [billing].[BillingLines] AFTER INSERT, UPDATE, DELETE AS
        BEGIN
            SET NOCOUNT ON;
            -- The lines of an approved basis are what was approved: none is added, changed or removed (BR-BIL-10).
            IF EXISTS (
                SELECT 1 FROM (SELECT BasisId FROM inserted UNION SELECT BasisId FROM deleted) x
                JOIN [billing].[BillingBases] b ON b.Id = x.BasisId
                JOIN [billing].[BillingRuns] r ON r.Id = b.RunId
                WHERE b.Status IN (N'Approved', N'Exported', N'Failed', N'ReconciliationRequired')
                   OR (b.Status = N'Cancelled' AND r.Status IN (N'Approved', N'Exporting', N'Exported', N'ExportedWithErrors', N'Closed')))
                THROW 51004, N'BILLING_APPROVED_IMMUTABLE: the lines of an approved billing basis cannot be changed.', 1;
        END
        """;

    public const string CreateApprovals = """
        CREATE OR ALTER TRIGGER [billing].[trg_BillingApprovals_Protect] ON [billing].[BillingApprovals] AFTER UPDATE, DELETE AS
        BEGIN
            SET NOCOUNT ON;
            -- An approval act is never removed; a later revision only sets it aside once, with the reason (ADR-012).
            IF EXISTS (
                SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.Id = d.Id
                WHERE i.Id IS NULL
                   OR (d.InvalidatedAt IS NOT NULL AND EXISTS (SELECT i.InvalidatedAt, i.InvalidationReason EXCEPT SELECT d.InvalidatedAt, d.InvalidationReason))
                   OR EXISTS (SELECT i.RunId, i.Kind, i.ApprovedBy, i.ApprovedAt, i.ContentRevision, i.ContentDigest, i.Policy, i.RequiredSecond, i.IsDeleted, i.CreatedAt
                              EXCEPT
                              SELECT d.RunId, d.Kind, d.ApprovedBy, d.ApprovedAt, d.ContentRevision, d.ContentDigest, d.Policy, d.RequiredSecond, d.IsDeleted, d.CreatedAt))
                THROW 51005, N'BILLING_APPROVED_IMMUTABLE: an approval act cannot be changed or deleted.', 1;
        END
        """;

    public const string CreateCharges = """
        CREATE OR ALTER TRIGGER [billing].[trg_Charges_Protect] ON [billing].[Charges] AFTER INSERT, UPDATE, DELETE AS
        BEGIN
            SET NOCOUNT ON;
            -- The register only moves forward (ADR-013): a charge is reserved first, its identity never changes, and once it is
            -- committed neither its amount nor its holder does.
            IF EXISTS (SELECT 1 FROM inserted i WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.Id = i.Id) AND i.Status <> N'Reserved')
                THROW 51006, N'BILLING_CHARGE_IMMUTABLE: a charge is registered as reserved.', 1;
            IF EXISTS (
                SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.Id = d.Id
                WHERE i.Id IS NULL
                   OR EXISTS (SELECT i.[Key], i.Kind, i.SeriesId, i.ServiceFrom, i.ServiceTo, i.CorrectsLineId, i.Currency, i.RunId, i.IsDeleted, i.CreatedAt
                              EXCEPT
                              SELECT d.[Key], d.Kind, d.SeriesId, d.ServiceFrom, d.ServiceTo, d.CorrectsLineId, d.Currency, d.RunId, d.IsDeleted, d.CreatedAt)
                   OR (d.Status <> N'Reserved'
                       AND EXISTS (SELECT i.Amount, i.BasisId, i.LineId, i.PayerOrganizationId, i.SourceOrganizationId, i.ContractLineId
                                   EXCEPT
                                   SELECT d.Amount, d.BasisId, d.LineId, d.PayerOrganizationId, d.SourceOrganizationId, d.ContractLineId))
                   OR (i.Status <> d.Status AND NOT (
                          (d.Status = N'Reserved' AND i.Status IN (N'Committed', N'Released', N'ReconciliationRequired', N'ExportConfirmed'))
                       OR (d.Status = N'Committed' AND i.Status IN (N'ExportConfirmed', N'ReconciliationRequired', N'Released'))
                       OR (d.Status = N'ReconciliationRequired' AND i.Status IN (N'ExportConfirmed', N'Committed'))
                       OR (d.Status = N'LegacyUnresolved' AND i.Status IN (N'ExportConfirmed', N'Released')))))
                THROW 51007, N'BILLING_CHARGE_IMMUTABLE: the charge cannot be changed this way.', 1;
        END
        """;

    public const string CreateExportAttempts = """
        CREATE OR ALTER TRIGGER [billing].[trg_BillingExportAttempts_Protect] ON [billing].[BillingExportAttempts] AFTER UPDATE, DELETE AS
        BEGIN
            SET NOCOUNT ON;
            -- The export log is only ever added to.
            IF EXISTS (SELECT 1 FROM deleted)
                THROW 51008, N'BILLING_EXPORT_LOG_APPEND_ONLY: export attempts cannot be changed or deleted.', 1;
        END
        """;
}
