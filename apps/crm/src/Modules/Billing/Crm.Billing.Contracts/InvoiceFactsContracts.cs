namespace Crm.Billing.Contracts;

/// <summary>
/// An organization's invoices with an amount left, as its invoice tab counts them: <paramref name="Open"/> and
/// <paramref name="Outstanding"/> are what <c>GET /api/v1/billing/invoices?organizationId=…&amp;openOnly=true</c> reports as its
/// count and outstanding total, <paramref name="Overdue"/> and <paramref name="OverdueAmount"/> the overdue part of them (amount
/// left and due before today, Europe/Oslo). The amounts are money: callers show them only to holders of <c>finance.read</c>.
/// </summary>
public sealed record OrganizationInvoiceFacts(Guid OrganizationId, int Open, decimal Outstanding, int Overdue, decimal OverdueAmount);

/// <summary>An organization with overdue invoices: how many and what is left on them (money: <c>finance.read</c> only).</summary>
public sealed record OrganizationOverdueInvoices(Guid OrganizationId, int Overdue, decimal OverdueAmount);

/// <summary>
/// What the billing module can tell about organizations for the customer list (UX 2026, В6). Every call is one SQL aggregate
/// grouped by organization, never a query per organization.
/// </summary>
public interface IInvoiceFacts
{
    /// <summary>
    /// The open invoices of the given organizations (a page of the customer list), overdue as of <paramref name="today"/>; an
    /// organization without an open invoice is absent from the answer.
    /// </summary>
    Task<IReadOnlyList<OrganizationInvoiceFacts>> GetOpenInvoicesAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly today, CancellationToken cancellationToken);

    /// <summary>Every organization with at least one invoice overdue as of <paramref name="today"/>.</summary>
    Task<IReadOnlyList<OrganizationOverdueInvoices>> GetOverdueInvoicesAsync(DateOnly today, CancellationToken cancellationToken);
}
