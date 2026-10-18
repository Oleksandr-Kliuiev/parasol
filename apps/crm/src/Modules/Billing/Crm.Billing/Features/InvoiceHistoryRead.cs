using Crm.Billing.Contracts;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

public sealed record InvoiceHistoryDto(InvoiceDto Invoice, ExternalInvoiceHistory? History);

internal sealed partial class BillingService
{
    public async Task<InvoiceHistoryDto?> ReadInvoiceHistoryAsync(Guid id, CancellationToken ct, Guid? expectedOrganizationId = null)
    {
        var invoice = await db.Invoices.AsNoTracking().Include(i => i.Payments).SingleOrDefaultAsync(i => i.Id == id && (expectedOrganizationId == null || i.OrganizationId == expectedOrganizationId), ct);
        if (invoice is null) return null;
        var names = await customers.GetOrganizationNamesAsync(invoice.OrganizationId is { } organizationId ? [organizationId] : [], ct);
        return new InvoiceHistoryDto(ToDto(invoice, names, Today), invoice.History);
    }
}
