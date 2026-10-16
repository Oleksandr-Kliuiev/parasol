namespace Crm.Sales;

/// <summary>Sales settings (docs/02 §4.3). Discount limits and the company block on the quote are configuration, not code.</summary>
public sealed class SalesOptions
{
    public const string SectionName = "Sales";

    /// <summary>Line discount a salesperson may give on their own; above it management approves (BR-SAL-05).</summary>
    public decimal DiscountLimitPercent { get; set; } = 15m;

    /// <summary>How long a new quote stays valid when its template does not say otherwise.</summary>
    public int QuoteValidityDays { get; set; } = 30;

    /// <summary>Send quotes from the salesperson's own mailbox (FR-SAL-04). Off until Mail.Send is granted in Entra ID.</summary>
    public bool EmailEnabled { get; set; }

    public QuoteCompanyOptions Company { get; set; } = new();
}

/// <summary>Our own details as they appear in the head and foot of the quote.</summary>
public sealed class QuoteCompanyOptions
{
    public string Name { get; set; } = "Vardahei AS";

    public string? OrgNumber { get; set; }

    public string? Street { get; set; }

    public string? PostalCode { get; set; }

    public string? City { get; set; }

    public string? Email { get; set; }

    public string? Phone { get; set; }

    public string? Website { get; set; }
}
