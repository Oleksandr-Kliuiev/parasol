using System.Globalization;
using Crm.Billing.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Billing.Domain;

/// <summary>
/// An invoice as the accounting system reports it (docs/05 §4.2). The CRM never edits invoices; it mirrors them so a customer's
/// balance is visible next to their contracts. Payments are derived from the outstanding amount going down.
/// </summary>
public sealed class Invoice : AuditableEntity
{
    private readonly List<InvoicePayment> _payments = [];

    private Invoice() { }

    public string System { get; private set; } = string.Empty;
    public string InvoiceNo { get; private set; } = string.Empty;
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

    public bool IsOverdue(DateOnly today) => Outstanding > 0 && DueDate is { } due && due < today;

    public static Invoice From(ExternalInvoice source, Guid? organizationId, Guid? basisId, DateTimeOffset now)
    {
        var invoice = new Invoice { System = source.System, InvoiceNo = source.InvoiceNo };
        invoice.Apply(source, organizationId, basisId, now);
        return invoice;
    }

    /// <summary>Returns true when anything visible changed; a lower outstanding amount is recorded as a payment.</summary>
    public bool Apply(ExternalInvoice source, Guid? organizationId, Guid? basisId, DateTimeOffset now)
    {
        var before = Signature();
        var previousOutstanding = Outstanding;
        OrderNo = source.OrderNo;
        ExternalReference = source.ExternalReference;
        OrganizationId = organizationId ?? OrganizationId;
        BasisId = basisId ?? BasisId;
        InvoiceDate = source.InvoiceDate;
        DueDate = source.DueDate;
        TotalIncVat = decimal.Round(source.TotalIncVat, 2);
        Outstanding = decimal.Round(source.Outstanding, 2);
        Status = source.Status;
        Url = source.Url;
        SyncedAt = now;

        // A first sync starts at zero, so only a real decrease between two syncs counts as a payment.
        if (Outstanding < previousOutstanding)
        {
            _payments.Add(InvoicePayment.Create(Id, DateOnly.FromDateTime(now.UtcDateTime), previousOutstanding - Outstanding));
        }

        return before != Signature();
    }

    public void LinkBasis(Guid basisId) => BasisId = basisId;

    private string Signature() => string.Join('|',
        OrderNo, ExternalReference, OrganizationId, InvoiceDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DueDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        TotalIncVat.ToString("0.####", CultureInfo.InvariantCulture),
        Outstanding.ToString("0.####", CultureInfo.InvariantCulture), Status, Url);
}

/// <summary>A payment inferred from the outstanding amount of an invoice going down between two syncs.</summary>
public sealed class InvoicePayment : AuditableEntity
{
    private InvoicePayment() { }

    public Guid InvoiceId { get; private set; }
    public DateOnly PaidAt { get; private set; }
    public decimal Amount { get; private set; }

    internal static InvoicePayment Create(Guid invoiceId, DateOnly paidAt, decimal amount) => new()
    {
        InvoiceId = invoiceId,
        PaidAt = paidAt,
        Amount = decimal.Round(amount, 2),
    };
}
