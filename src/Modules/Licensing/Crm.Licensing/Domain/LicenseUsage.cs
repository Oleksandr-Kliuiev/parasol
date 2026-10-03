using System.Globalization;
using Crm.Licensing.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Licensing.Domain;

/// <summary>
/// How many licences of one SKU a customer has bought and how many are actually assigned in their tenant, as read once a
/// day through GDAP (FR-LIC-03). Keeping a row per day makes "unused for a month" a question the CRM can answer.
/// </summary>
public sealed class LicenseSnapshot : Entity
{
    private LicenseSnapshot() { }

    public Guid OrganizationId { get; private set; }
    public DateOnly SnapshotDate { get; private set; }

    /// <summary>Microsoft's SKU identifier in the customer tenant.</summary>
    public string SkuId { get; private set; } = string.Empty;

    /// <summary>Readable SKU, e.g. <c>SPB</c> for Microsoft 365 Business Premium.</summary>
    public string SkuPartNumber { get; private set; } = string.Empty;

    public int Purchased { get; private set; }
    public int Assigned { get; private set; }
    public DateTimeOffset ReadAt { get; private set; }

    public int Unused => Math.Max(Purchased - Assigned, 0);

    public static LicenseSnapshot Create(LicenseUsageReading reading, DateOnly date, DateTimeOffset readAt) => new()
    {
        OrganizationId = reading.OrganizationId,
        SnapshotDate = date,
        SkuId = reading.SkuId,
        SkuPartNumber = reading.SkuPartNumber,
        Purchased = Math.Max(reading.Purchased, 0),
        Assigned = Math.Max(reading.Assigned, 0),
        ReadAt = readAt,
    };

    /// <summary>A second reading on the same day replaces the first; the day is the unit, not the moment.</summary>
    public void Update(LicenseUsageReading reading, DateTimeOffset readAt)
    {
        Purchased = Math.Max(reading.Purchased, 0);
        Assigned = Math.Max(reading.Assigned, 0);
        SkuPartNumber = reading.SkuPartNumber;
        ReadAt = readAt;
    }
}

/// <summary>
/// One line of what Microsoft charged the partner (FR-LIC-04). It comes from the partner billing export or from the
/// distributor's invoice file, and is compared with what the CRM billed the customer for the same period.
/// </summary>
public sealed class MsBilledLine : Entity
{
    private MsBilledLine() { }

    /// <summary>`{source}:{invoice}:{subscription}:{offer}:{period}` — the same line is never imported twice.</summary>
    public string LineKey { get; private set; } = string.Empty;

    public MsBillingSource Source { get; private set; }
    public DateOnly PeriodStart { get; private set; }
    public DateOnly PeriodEnd { get; private set; }
    public string? InvoiceId { get; private set; }
    public string CspCustomerId { get; private set; } = string.Empty;
    public string? CspCustomerName { get; private set; }
    public Guid? OrganizationId { get; private set; }
    public string? SubscriptionId { get; private set; }
    public string OfferId { get; private set; } = string.Empty;
    public string? OfferName { get; private set; }
    public decimal Quantity { get; private set; }
    public decimal UnitPrice { get; private set; }
    public decimal Total { get; private set; }
    public string Currency { get; private set; } = "NOK";
    public DateTimeOffset ImportedAt { get; private set; }

    public static string KeyOf(ExternalBilledLine line) => string.Create(
        CultureInfo.InvariantCulture,
        $"{line.Source}:{line.InvoiceId}:{line.SubscriptionId}:{line.OfferId}:{line.PeriodStart:yyyy-MM-dd}");

    public static MsBilledLine Create(ExternalBilledLine line, Guid? organizationId, DateTimeOffset importedAt)
    {
        var billed = new MsBilledLine { LineKey = KeyOf(line) };
        billed.Apply(line, organizationId, importedAt);
        return billed;
    }

    public void Apply(ExternalBilledLine line, Guid? organizationId, DateTimeOffset importedAt)
    {
        Source = line.Source;
        PeriodStart = line.PeriodStart;
        PeriodEnd = line.PeriodEnd;
        InvoiceId = Clean(line.InvoiceId);
        CspCustomerId = line.CspCustomerId;
        CspCustomerName = Clean(line.CspCustomerName);
        OrganizationId = organizationId;
        SubscriptionId = Clean(line.SubscriptionId);
        OfferId = line.OfferId;
        OfferName = Clean(line.OfferName);
        Quantity = decimal.Round(line.Quantity, 2);
        UnitPrice = decimal.Round(line.UnitPrice, 4);
        Total = decimal.Round(line.Total, 2);
        Currency = string.IsNullOrWhiteSpace(line.Currency) ? "NOK" : line.Currency.Trim().ToUpperInvariant();
        ImportedAt = importedAt;
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
