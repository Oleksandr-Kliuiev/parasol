using System.Data;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

public sealed record CustomerLedgerInvoiceLink(Guid InvoiceId, string InvoiceNo, Guid SourceVoucherId, string Relation);
public sealed record CustomerLedgerItem(Guid Id, Guid? OrganizationId, ExternalCustomerLedgerEntry Source,
    DateTimeOffset LastSeenAt, bool PresentInLatestScan, IReadOnlyList<CustomerLedgerInvoiceLink> Invoices);
public sealed record CustomerLedgerPage(int Total, int Offset, int Limit, IReadOnlyList<CustomerLedgerItem> Entries);
public sealed record CustomerLedgerQuery(Guid? OrganizationId, Guid? InvoiceId, int Offset = 0, int Limit = 50);

internal sealed partial class BillingService
{
    public async Task<CustomerLedgerPage> ReadCustomerLedgerAsync(CustomerLedgerQuery query, CancellationToken ct) =>
        await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            await using var read = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
            var snapshots = await db.CustomerLedgerSnapshots.AsNoTracking().Where(s => s.System == "poweroffice").ToListAsync(ct);
            var states = snapshots.ToDictionary(s => s.CustomerKey);
            var rows = from entry in db.CustomerLedgerEntries.AsNoTracking()
                       join state in db.CustomerLedgerSnapshots.AsNoTracking() on new { entry.System, entry.CustomerKey } equals new { state.System, state.CustomerKey }
                       where entry.System == "poweroffice" && (query.OrganizationId == null || state.OrganizationId == query.OrganizationId)
                       select entry;
            if (query.InvoiceId is { } invoiceId)
            {
                var invoice = await db.Invoices.AsNoTracking().SingleOrDefaultAsync(i => i.Id == invoiceId && i.System == "poweroffice", ct);
                if (invoice?.ExternalId is not { } voucher || invoice.ExternalCustomerId is not { } customer ||
                    !states.TryGetValue(customer, out var state) || invoice.OrganizationId != state.OrganizationId)
                {
                    await read.CommitAsync(ct);
                    return new CustomerLedgerPage(0, query.Offset, query.Limit, []);
                }
                var kind = invoice.DocumentKind == InvoiceDocumentKind.CreditNote ? CustomerLedgerKind.CreditNote : CustomerLedgerKind.Invoice;
                var anchors = await db.CustomerLedgerEntries.AsNoTracking().Where(e => e.System == invoice.System && e.CustomerKey == customer &&
                    e.VoucherId == voucher && e.Kind == kind && e.LastSeenScanId == state.ScanId).ToListAsync(ct);
                var matches = anchors.Where(a => a.MatchId != null).Select(a => a.MatchId!.Value).Distinct().ToList();
                rows = rows.Where(e => e.CustomerKey == customer && e.LastSeenScanId == state.ScanId &&
                    (e.VoucherId == voucher && e.Kind == kind || e.MatchId != null && matches.Contains(e.MatchId.Value)));
            }
            var total = await rows.CountAsync(ct);
            var page = await rows.OrderByDescending(e => e.PostingDate).ThenBy(e => e.ExternalId).Skip(query.Offset).Take(query.Limit).ToListAsync(ct);
            var links = await LedgerInvoiceLinksAsync(page, states, ct);
            var result = page.Select(e => new CustomerLedgerItem(e.Id, states[e.CustomerKey].OrganizationId, e.Source, e.LastSeenAt,
                e.LastSeenScanId == states[e.CustomerKey].ScanId, links.GetValueOrDefault(e.Id) ?? [])).ToList();
            await read.CommitAsync(ct);
            return new CustomerLedgerPage(total, query.Offset, query.Limit, result);
        });

    private async Task<Dictionary<Guid, List<CustomerLedgerInvoiceLink>>> LedgerInvoiceLinksAsync(
        IReadOnlyList<CustomerLedgerEntry> page, Dictionary<string, CustomerLedgerSnapshot> states, CancellationToken ct)
    {
        var customersOnPage = page.Select(e => e.CustomerKey).Distinct().ToList();
        var matches = page.Where(e => e.MatchId != null).Select(e => e.MatchId!.Value).Distinct().ToList();
        var vouchers = page.Select(e => e.VoucherId).Distinct().ToList();
        var candidates = await db.CustomerLedgerEntries.AsNoTracking().Where(e => e.System == "poweroffice" && customersOnPage.Contains(e.CustomerKey) &&
            (e.Kind == CustomerLedgerKind.Invoice || e.Kind == CustomerLedgerKind.CreditNote) &&
            (vouchers.Contains(e.VoucherId) || e.MatchId != null && matches.Contains(e.MatchId.Value))).ToListAsync(ct);
        var anchors = candidates.Where(e => e.LastSeenScanId == states[e.CustomerKey].ScanId).ToList();
        var ids = anchors.Select(a => a.VoucherId).Distinct().ToList();
        var invoices = await db.Invoices.AsNoTracking().Where(i => i.System == "poweroffice" && i.ExternalId != null && ids.Contains(i.ExternalId.Value)).ToListAsync(ct);
        var result = new Dictionary<Guid, List<CustomerLedgerInvoiceLink>>();
        foreach (var entry in page.Where(e => e.LastSeenScanId == states[e.CustomerKey].ScanId))
        {
            var related = anchors.Where(a => a.CustomerKey == entry.CustomerKey &&
                (a.VoucherId == entry.VoucherId && a.Kind == entry.Kind || a.MatchId != null && a.MatchId == entry.MatchId));
            var confirmed = new List<CustomerLedgerInvoiceLink>();
            foreach (var anchor in related)
            {
                var kind = anchor.Kind == CustomerLedgerKind.CreditNote ? InvoiceDocumentKind.CreditNote : InvoiceDocumentKind.Invoice;
                foreach (var invoice in invoices.Where(i => i.ExternalId == anchor.VoucherId && i.ExternalCustomerId == anchor.CustomerKey &&
                    i.DocumentKind == kind && i.OrganizationId == states[entry.CustomerKey].OrganizationId))
                    confirmed.Add(new(invoice.Id, invoice.InvoiceNo, anchor.VoucherId, entry.VoucherId == anchor.VoucherId && entry.Kind == anchor.Kind ? "DirectVoucher" : "MatchGroup"));
            }
            result[entry.Id] = confirmed.Distinct().OrderBy(l => l.InvoiceId).ToList();
        }
        return result;
    }
}
