using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

/// <summary>
/// The invoice side of the customer facts (UX 2026, В6), with the predicates of <see cref="BillingService.ListInvoicesAsync"/> — the
/// invoice tab of the customer card: open is <c>openOnly</c> (any amount left, a credit included), overdue its overdue rule (an
/// amount still owed on an invoice that is neither credited nor a credit note, due before today). The invoice list applies no
/// record scope beyond <c>billing.read</c>, and neither does this.
/// </summary>
internal sealed class InvoiceFacts(BillingDbContext db) : IInvoiceFacts
{
    public async Task<IReadOnlyList<OrganizationInvoiceFacts>> GetOpenInvoicesAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly today, CancellationToken cancellationToken)
    {
        if (organizationIds.Count == 0)
        {
            return [];
        }

        var wanted = organizationIds.Select(id => (Guid?)id).ToList();
        var rows = await db.Invoices.AsNoTracking()
            .Where(i => wanted.Contains(i.OrganizationId) && i.Outstanding != 0)
            .GroupBy(i => i.OrganizationId)
            .Select(g => new
            {
                g.Key,
                Open = g.Count(),
                Outstanding = g.Sum(i => i.Outstanding),
                Overdue = g.Count(i => i.Status != InvoiceStatus.Credited && i.DocumentKind != InvoiceDocumentKind.CreditNote
                    && i.Outstanding > 0 && i.DueDate != null && i.DueDate < today),
                OverdueAmount = g.Sum(i => i.Status != InvoiceStatus.Credited && i.DocumentKind != InvoiceDocumentKind.CreditNote
                    && i.Outstanding > 0 && i.DueDate != null && i.DueDate < today ? i.Outstanding : 0m),
            })
            .ToListAsync(cancellationToken);
        return rows
            .Select(r => new OrganizationInvoiceFacts(r.Key!.Value, r.Open, decimal.Round(r.Outstanding, 2), r.Overdue, decimal.Round(r.OverdueAmount, 2)))
            .ToList();
    }

    public async Task<IReadOnlyList<OrganizationOverdueInvoices>> GetOverdueInvoicesAsync(DateOnly today, CancellationToken cancellationToken)
    {
        var rows = await db.Invoices.AsNoTracking()
            .Where(i => i.OrganizationId != null && i.Status != InvoiceStatus.Credited && i.DocumentKind != InvoiceDocumentKind.CreditNote
                && i.Outstanding > 0 && i.DueDate != null && i.DueDate < today)
            .GroupBy(i => i.OrganizationId)
            .Select(g => new { g.Key, Overdue = g.Count(), Amount = g.Sum(i => i.Outstanding) })
            .ToListAsync(cancellationToken);
        return rows.Select(r => new OrganizationOverdueInvoices(r.Key!.Value, r.Overdue, decimal.Round(r.Amount, 2))).ToList();
    }
}
