using System.Globalization;
using Crm.Billing.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Billing.Domain;

/// <summary>
/// An invoice as the accounting system reports it (docs/05 §4.2). The CRM never edits invoices; it mirrors them so a customer's
/// balance is visible next to their contracts. The accounting system gives us only the remaining amount, so a change of it is
/// kept as a balance movement of the kind we can prove (<see cref="InvoiceMovementKind"/>); nothing is called a payment.
/// </summary>
public sealed class Invoice : AuditableEntity
{
    private readonly List<InvoicePayment> _payments = [];

    private Invoice() { }

    public string System { get; private set; } = string.Empty;
    public string InvoiceNo { get; private set; } = string.Empty;
    public Guid? ExternalId { get; private set; }
    public string? ExternalCustomerId { get; private set; }
    public string? HistoryJson { get; private set; }
    public InvoiceDocumentKind? DocumentKind { get; private set; }
    public ExternalInvoiceHistory? History => InvoiceHistoryCodec.Read(HistoryJson);
    public string? OrderNo { get; private set; }
    public string? ExternalReference { get; private set; }
    public Guid? OrganizationId { get; private set; }
    public Guid? BasisId { get; private set; }
    public DateOnly InvoiceDate { get; private set; }
    public DateOnly? DueDate { get; private set; }
    public decimal TotalIncVat { get; private set; }
    public decimal Outstanding { get; private set; }
    public InvoiceStatus Status { get; private set; }
    public string? Url { get; private set; }
    public DateTimeOffset SyncedAt { get; private set; }

    public IReadOnlyList<InvoicePayment> Payments => _payments;

    public bool IsOverdue(DateOnly today) => Status != InvoiceStatus.Credited && DocumentKind != InvoiceDocumentKind.CreditNote && Outstanding > 0 && DueDate is { } due && due < today;

    public static Invoice From(ExternalInvoice source, Guid? organizationId, Guid? basisId, DateTimeOffset now)
    {
        var invoice = new Invoice { System = source.System, InvoiceNo = source.InvoiceNo };
        invoice.Apply(source, organizationId, basisId, now);
        return invoice;
    }

    /// <summary>
    /// Returns true when anything visible changed. A change of the remaining amount between two syncs is recorded as a movement:
    /// a decrease of a credited invoice is a credit note, any other decrease an observed decrease (not a ledger payment), and an
    /// increase is kept as a flagged movement so a reversal or a re-opened invoice is not lost.
    /// </summary>
    public bool Apply(ExternalInvoice source, Guid? organizationId, Guid? basisId, DateTimeOffset now)
    {
        if (source.History is { } history)
        {
            if (ExternalId is { } existingId && existingId != history.ExternalId)
                throw new InvalidOperationException("An invoice source identity cannot change.");
            if (ExternalId is not null && (source.InvoiceNo != InvoiceNo || DocumentKind != history.Kind ||
                ExternalCustomerId is not null && ExternalCustomerId != history.ExternalCustomerId))
                throw new InvalidOperationException("A posted invoice identity cannot change.");
            if (History is { } previous && (history.LastChangedAt < previous.LastChangedAt ||
                previous.BalanceChangedAt is { } balanceTime && (history.BalanceChangedAt is null || history.BalanceChangedAt < balanceTime)))
                return false;
        }
        else if (ExternalId is not null) throw new InvalidOperationException("Historical invoices require their source identity.");
        var before = Signature();
        var previousOutstanding = Outstanding;
        var previousStatus = Status;
        var firstSync = SyncedAt == default;
        OrderNo = source.OrderNo;
        ExternalReference = source.ExternalReference;
        OrganizationId = source.History is not null ? organizationId : organizationId ?? OrganizationId;
        BasisId = source.History is not null ? basisId : basisId ?? BasisId;
        if (source.History is { } snapshot)
        {
            ExternalId = snapshot.ExternalId;
            ExternalCustomerId = snapshot.ExternalCustomerId;
            DocumentKind = snapshot.Kind;
            HistoryJson = InvoiceHistoryCodec.Write(snapshot);
            InvoiceNo = source.InvoiceNo;
        }
        InvoiceDate = source.InvoiceDate;
        DueDate = source.DueDate;
        TotalIncVat = decimal.Round(source.TotalIncVat, 2);
        Outstanding = decimal.Round(source.Outstanding, 2);
        Status = source.Status;
        if (source.History is null || source.Url is not null) Url = source.Url;
        SyncedAt = now;

        // A first sync starts at zero, so only a change between two syncs counts as a movement.
        if (!firstSync)
        {
            var credited = Status == InvoiceStatus.Credited;
            var flippedToCredited = credited && previousStatus != InvoiceStatus.Credited;
            var observedOn = DateOnly.FromDateTime(now.UtcDateTime);
            if (Outstanding < previousOutstanding)
            {
                _payments.Add(InvoicePayment.Create(Id, observedOn, previousOutstanding - Outstanding,
                    credited ? InvoiceMovementKind.CreditNote : InvoiceMovementKind.BalanceDecrease,
                    credited ? "The invoice is credited in the accounting system" : "The remaining amount went down between two syncs"));
            }
            else if (Outstanding > previousOutstanding)
            {
                _payments.Add(InvoicePayment.Create(Id, observedOn, Outstanding - previousOutstanding,
                    InvoiceMovementKind.BalanceIncrease, "The remaining amount went up between two syncs; check the invoice in the accounting system"));
            }
            else if (flippedToCredited)
            {
                // Credited without a visible change of the remaining amount: the fact itself is the movement.
                _payments.Add(InvoicePayment.Create(Id, observedOn, 0m, InvoiceMovementKind.CreditNote, "The invoice became credited in the accounting system"));
            }
        }

        return before != Signature();
    }

    public void LinkBasis(Guid basisId) => BasisId = basisId;

    public void BindHistoricalCustomer(Guid? organizationId, Guid? basisId)
    {
        if (ExternalId is null) throw new InvalidOperationException("Only a historical invoice can use source customer binding.");
        OrganizationId = organizationId;
        BasisId = basisId;
    }

    private string Signature() => string.Join('|',
        OrderNo, ExternalReference, OrganizationId, BasisId, InvoiceNo, ExternalId, HistoryJson, InvoiceDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DueDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        TotalIncVat.ToString("0.####", CultureInfo.InvariantCulture),
        Outstanding.ToString("0.####", CultureInfo.InvariantCulture), Status, Url);
}

/// <summary>
/// What a change of an invoice's remaining amount is known to be. The accounting system's invoice API does not give a ledger, so
/// only the first kinds are ever written; <see cref="Payment"/> and <see cref="WriteOff"/> stay unused until a provider proves them.
/// </summary>
public enum InvoiceMovementKind
{
    /// <summary>The remaining amount went down between two syncs. Not a ledger payment: it can be a payment, a credit or a write-off.</summary>
    BalanceDecrease,

    /// <summary>The invoice is credited in the accounting system (the credited flag, with any change of the remaining amount).</summary>
    CreditNote,

    /// <summary>The remaining amount went up between two syncs; flagged for a person to look at.</summary>
    BalanceIncrease,

    /// <summary>A payment proven by a ledger entry. Not written yet.</summary>
    Payment,

    /// <summary>A write-off proven by a ledger entry. Not written yet.</summary>
    WriteOff,
}

/// <summary>
/// A change of the remaining amount of an invoice, as the sync observed it. <see cref="ObservedOn"/> is the day the sync saw the
/// change, not the day money moved. The table keeps its old name and the date its old column (<c>PaidAt</c>) so the migration is additive.
/// </summary>
public sealed class InvoicePayment : AuditableEntity
{
    private InvoicePayment() { }

    public Guid InvoiceId { get; private set; }
    public DateOnly ObservedOn { get; private set; }
    public decimal Amount { get; private set; }
    public InvoiceMovementKind Kind { get; private set; }
    public string Source { get; private set; } = string.Empty;

    internal static InvoicePayment Create(Guid invoiceId, DateOnly observedOn, decimal amount, InvoiceMovementKind kind, string source) => new()
    {
        InvoiceId = invoiceId,
        ObservedOn = observedOn,
        Amount = decimal.Round(amount, 2),
        Kind = kind,
        Source = source,
    };
}
