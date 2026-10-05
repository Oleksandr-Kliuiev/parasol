using Crm.SharedKernel.Domain;

namespace Crm.Billing.Contracts;

/// <summary>Draft → Collected → InReview → Approved → Exporting → Exported/ExportedWithErrors → Closed (docs/02 §4.9).</summary>
public enum BillingRunStatus
{
    Draft,
    Collected,
    InReview,
    Approved,
    Exporting,
    Exported,
    ExportedWithErrors,
    Closed,
}

public enum BillingBasisStatus
{
    Draft,
    Approved,
    Exported,
    Failed,
    Cancelled,

    /// <summary>A send may have created the order, but nobody can prove it either way; a person checks the accounting system (ADR-013).</summary>
    ReconciliationRequired,
}

/// <summary>Where a line came from; "Info" lines carry hours already covered by a contract or an hour bank and cost nothing.</summary>
public enum BillingGroup
{
    Subscription,
    License,
    HourlyWork,
    HourBank,
    OneOff,
    Info,
}

public enum InvoiceStatus
{
    Draft,
    Sent,
    PartiallyPaid,
    Paid,
    Overdue,
    Credited,
}

/// <summary>A line of a basis as an external accounting system needs it; prices are excluding VAT.</summary>
public sealed record ExportLine(
    BillingGroup Group,
    Guid? ProductId,
    string? ProductCode,
    string Description,
    decimal Quantity,
    decimal UnitPrice,
    decimal DiscountPct,
    decimal LineTotal);

/// <summary>One customer's billing basis, ready to be sent to the accounting system (BR-BIL-05/06).</summary>
/// <summary>
/// One approved basis as the accounting system receives it. <paramref name="SendStarted"/>: an earlier attempt reached the
/// point of sending, so the order may exist even when a lookup by <paramref name="IdempotencyKey"/> finds nothing (ADR-013).
/// <paramref name="CheckedAt"/>: when Finance last reconciled the basis against the accounting system — earlier attempts are
/// settled by that decision (DEV-13). <paramref name="SendStartedAt"/>: when that attempt reached the point of sending — an
/// outcome that is still unknown shortly after is given time to show up before it is handed to a person.
/// </summary>
public sealed record ExportBasis(
    Guid BasisId,
    Guid RunId,
    Guid OrganizationId,
    string IdempotencyKey,
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    string? CustomerReference,
    decimal TotalExVat,
    bool SendStarted,
    IReadOnlyList<ExportLine> Lines,
    DateTimeOffset? CheckedAt = null,
    DateTimeOffset? SendStartedAt = null);

/// <summary>An invoice as the accounting system reports it.</summary>
public sealed record ExternalInvoice(
    string System,
    string InvoiceNo,
    string? OrderNo,
    string? ExternalReference,
    Guid? OrganizationId,
    DateOnly InvoiceDate,
    DateOnly? DueDate,
    decimal TotalIncVat,
    decimal Outstanding,
    InvoiceStatus Status,
    string? Url);

public sealed record InvoiceSyncResult(int Created, int Updated, int Unchanged, int Unmatched);

/// <summary>Invoiced amount of one month, and of one product within it (FR-RPT-01).</summary>
public sealed record RevenueByMonth(int Year, int Month, decimal TotalExVat, IReadOnlyDictionary<Guid, decimal> ByProduct);

/// <summary>What one customer was billed in a period, split the way the margin report reads it (FR-RPT-02).</summary>
public sealed record RevenueByOrganization(
    Guid OrganizationId, decimal Total, decimal Licenses, decimal Subscriptions, decimal Hours, decimal OneOff);

public sealed record InvoiceTotals(int Open, decimal Outstanding, decimal Overdue, int OverdueCount);

/// <summary>
/// One month's billing, split by how final it is (DEV-14): <paramref name="ApprovedExVat"/> is the content of bases that were
/// approved (frozen, DEV-02; whatever became of their export), <paramref name="PendingExVat"/> what collected but still draft
/// bases would bill. Cancelled bases and information lines count nowhere.
/// </summary>
public sealed record RevenueSplit(int Year, int Month, decimal ApprovedExVat, decimal PendingExVat);

/// <summary>An invoice as the accounting system reports it, for the BI mart: what was invoiced and what is still unpaid — never "paid".</summary>
public sealed record InvoiceRow(
    string System, string InvoiceNo, Guid? OrganizationId, DateOnly InvoiceDate, DateOnly? DueDate, decimal TotalIncVat, decimal Outstanding, InvoiceStatus Status);

/// <summary>Licence revenue of one organization and product in a billing period (FR-LIC-04).</summary>
public sealed record BilledLicenseLine(Guid OrganizationId, Guid? ProductId, decimal Quantity, decimal Amount);

public sealed record OverdueInvoice(Guid InvoiceId, string InvoiceNo, Guid? OrganizationId, decimal Outstanding, DateOnly DueDate, int DaysOverdue);

/// <summary>
/// What the charge register holds for one payer, month and currency (DEV-20, cutover reconciliation): <paramref name="Billed"/>
/// is what the accounting system confirmed, <paramref name="Pending"/> what is reserved, committed or waiting for a person to
/// check, and <paramref name="Unconfirmed"/> the lines billed before the register existed whose origin cannot be proven (they
/// are never counted as billed). Amounts exclude VAT.
/// </summary>
public sealed record BilledPeriodTotal(
    Guid OrganizationId, DateOnly PeriodStart, string Currency, int Charges, decimal Billed, decimal Pending, decimal Unconfirmed);

/// <summary>Public API of the Billing module for integrations.</summary>
public interface IBillingApi
{
    /// <summary>
    /// The basis if it is approved and waiting to be sent; null once it is exported or cancelled, so a repeated delivery of
    /// <see cref="BillingBasisApproved"/> sends nothing a second time.
    /// </summary>
    Task<ExportBasis?> GetBasisForExportAsync(Guid basisId, CancellationToken cancellationToken);

    /// <summary>Records a successful export; repeated calls with the same order number are ignored (BR-BIL-05).</summary>
    Task MarkExportedAsync(Guid basisId, string system, string orderNo, string? correlationId, CancellationToken cancellationToken);

    /// <summary>The order was not created: a check before sending failed, or the accounting system rejected it.</summary>
    Task MarkExportFailedAsync(Guid basisId, string system, string message, string? correlationId, CancellationToken cancellationToken);

    /// <summary>
    /// Recorded, and committed, right before the order is sent; false when the basis no longer waits to be sent (cancelled,
    /// say), in which case nothing is sent (ADR-013).
    /// </summary>
    Task<bool> MarkExportSendingAsync(Guid basisId, string system, string? correlationId, CancellationToken cancellationToken);

    /// <summary>
    /// An earlier send may have created the order and a lookup does not find it: the basis and its charges wait for a person
    /// to check the accounting system instead of being sent again (ADR-013).
    /// </summary>
    Task MarkReconciliationRequiredAsync(Guid basisId, string system, string message, string? correlationId, CancellationToken cancellationToken);

    /// <summary>
    /// The time entries an exported basis invoiced: those on its lines that were not excluded (BR-BIL-08). Empty while the
    /// basis is not exported. Time tracking marks them when it hears <see cref="BillingBasisExported"/>, in its own module
    /// (DEV-07: a handler changes one module only).
    /// </summary>
    Task<IReadOnlyList<Guid>> GetInvoicedTimeEntryIdsAsync(Guid basisId, CancellationToken cancellationToken);

    /// <summary>Inserts or updates invoices and their outstanding amounts (BR-BIL-08).</summary>
    Task<InvoiceSyncResult> UpsertInvoicesAsync(IReadOnlyCollection<ExternalInvoice> invoices, CancellationToken cancellationToken);

    /// <summary>What was billed per month, from the bases of the runs in the window (closed or not).</summary>
    Task<IReadOnlyList<RevenueByMonth>> GetRevenueAsync(DateOnly from, DateOnly to, CancellationToken cancellationToken);

    /// <summary>
    /// What customers were billed for Microsoft licences in a period, per organization and product (FR-LIC-04). Only lines
    /// of runs that cover the period count, so the comparison with Microsoft's invoice is like for like.
    /// </summary>
    Task<IReadOnlyList<BilledLicenseLine>> GetBilledLicensesAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken);

    /// <summary>What each customer was billed for the runs covering the period, by line group (FR-RPT-02).</summary>
    Task<IReadOnlyList<RevenueByOrganization>> GetRevenueByOrganizationAsync(
        DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken, bool approvedOnly = false);

    /// <summary>What was billed per month, split into approved and still-draft content (DEV-14).</summary>
    Task<IReadOnlyList<RevenueSplit>> GetRevenueSplitAsync(DateOnly periodFrom, DateOnly periodTo, CancellationToken cancellationToken);

    /// <summary>Every invoice dated in the window, oldest first with the invoice number and id as tie-breakers (DEV-14).</summary>
    Task<IReadOnlyList<InvoiceRow>> GetInvoiceRowsAsync(DateOnly periodFrom, DateOnly periodTo, CancellationToken cancellationToken);

    /// <summary>
    /// The register's totals per payer, month of the run's period and currency, for the given payers and months (inclusive,
    /// first day of the month) — summed in the database, read-only (DEV-20). A payer is the organization that is invoiced.
    /// </summary>
    Task<IReadOnlyList<BilledPeriodTotal>> GetBilledTotalsAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly firstMonth, DateOnly lastMonth, CancellationToken cancellationToken);

    Task<InvoiceTotals> GetInvoiceTotalsAsync(DateOnly today, CancellationToken cancellationToken);

    /// <summary>Invoices past their due date with an amount left, oldest first.</summary>
    Task<IReadOnlyList<OverdueInvoice>> GetOverdueInvoicesAsync(DateOnly today, CancellationToken cancellationToken);

    /// <summary>The runs of a period, newest first: whether one is still open and whether the period is already billed decides what a parallel pilot run would be (DEV-22).</summary>
    Task<IReadOnlyList<RunPeriodState>> GetRunStatesAsync(DateOnly periodStart, CancellationToken cancellationToken);

    /// <summary>Every run that is not closed, newest period first (DEV-22).</summary>
    Task<IReadOnlyList<RunPeriodState>> GetOpenRunStatesAsync(CancellationToken cancellationToken);
}

/// <summary>One billing run as far as the pilot readiness probe needs to know it.</summary>
public sealed record RunPeriodState(Guid RunId, DateOnly PeriodStart, bool Supplementary, BillingRunStatus Status);

/// <summary>
/// Asked by billing before a run is approved: the accounting system says which customers and products it can invoice
/// (BR-BIL-03). Implemented by the integration, so core modules stay independent of it.
/// </summary>
public interface IBillingTargetSystem
{
    string System { get; }

    /// <summary>The accounting system is switched on for billing. Readiness is answered from stored links and the catalog.</summary>
    bool IsConfigured { get; }

    Task<BillingReadiness> CheckAsync(
        IReadOnlyCollection<Guid> organizationIds, IReadOnlyCollection<Guid> productIds, CancellationToken cancellationToken);
}

/// <summary>Customers linked in the accounting system and the product codes it knows.</summary>
public sealed record BillingReadiness(IReadOnlySet<Guid> LinkedOrganizations, IReadOnlyDictionary<Guid, string> ProductCodes);

/// <summary>A run was approved: the bases can be exported.</summary>
public sealed record BillingRunApproved(Guid RunId, DateOnly PeriodStart, DateOnly PeriodEnd) : DomainEvent;

/// <summary>One customer's basis is ready to be sent; integrations queue their own outbound operation.</summary>
public sealed record BillingBasisApproved(Guid BasisId, Guid RunId, Guid OrganizationId, string IdempotencyKey) : DomainEvent;

public sealed record BillingBasisExported(Guid BasisId, Guid OrganizationId, string System, string OrderNo) : DomainEvent;
