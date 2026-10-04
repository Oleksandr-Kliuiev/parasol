using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.SharedKernel.Domain;
using Crm.TimeTracking.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Billing.Features;

/// <summary>What integrations may do with billing: read approved bases, report the result and mirror invoices back.</summary>
internal sealed class BillingApi(BillingDbContext db, ICatalogApi catalog, ChargeLedger ledger, TimeProvider time) : IBillingApi
{
    public async Task<IReadOnlyList<Guid>> GetInvoicedTimeEntryIdsAsync(Guid basisId, CancellationToken cancellationToken)
    {
        if (!await db.BillingBases.AsNoTracking().AnyAsync(b => b.Id == basisId && b.Status == BillingBasisStatus.Exported, cancellationToken))
        {
            return [];
        }

        var refs = await db.BillingLines.AsNoTracking()
            .Where(l => l.BasisId == basisId && l.SourceRefs != null && l.Decision != BillingLineDecision.Exclusion)
            .Select(l => l.SourceRefs!)
            .ToListAsync(cancellationToken);
        return refs.SelectMany(SourceRefs.TimeEntryIds).Distinct().ToList();
    }

    public async Task<ExportBasis?> GetBasisForExportAsync(Guid basisId, CancellationToken cancellationToken)
    {
        // Only a basis that waits to be sent: an approval event delivered again after the order was created (or after the
        // basis was cancelled) finds nothing to send (DEV-02).
        var basis = await db.BillingBases.AsNoTracking().Include(b => b.Lines)
            .SingleOrDefaultAsync(b => b.Id == basisId && b.Status == BillingBasisStatus.Approved, cancellationToken);
        if (basis is null)
        {
            return null;
        }

        var runs = await RunsOfAsync([basis], cancellationToken);
        var codes = await ProductCodesAsync([basis], cancellationToken);
        return ToExport(basis, runs[basis.RunId], codes);
    }

    public async Task MarkExportedAsync(Guid basisId, string system, string orderNo, string? correlationId, CancellationToken cancellationToken)
    {
        if (await db.BillingBases.Include(b => b.Attempts).SingleOrDefaultAsync(b => b.Id == basisId, cancellationToken) is not { } basis)
        {
            return;
        }

        var now = time.GetUtcNow();
        basis.MarkExported(system, orderNo, now, correlationId);
        // The order exists: the basis's charges are billed for good, in the same transaction (ADR-013).
        await ledger.ConfirmExportAsync(basis.Id, now, null, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        await UpdateRunStatusAsync(basis.RunId, cancellationToken);
    }

    public async Task<bool> MarkExportSendingAsync(Guid basisId, string system, string? correlationId, CancellationToken cancellationToken)
    {
        if (await db.BillingBases.Include(b => b.Attempts).SingleOrDefaultAsync(b => b.Id == basisId, cancellationToken) is not { } basis)
        {
            return false;
        }

        if (!basis.MarkSending(system, time.GetUtcNow(), correlationId).IsSuccess)
        {
            return false;
        }

        await db.SaveChangesAsync(cancellationToken);
        return true;
    }

    public async Task MarkReconciliationRequiredAsync(Guid basisId, string system, string message, string? correlationId, CancellationToken cancellationToken)
    {
        if (await db.BillingBases.Include(b => b.Attempts).SingleOrDefaultAsync(b => b.Id == basisId, cancellationToken) is not { } basis)
        {
            return;
        }

        var now = time.GetUtcNow();
        if (!basis.RequireReconciliation(system, message, now, correlationId).IsSuccess)
        {
            return;
        }

        await ledger.RequireReconciliationAsync(basis.Id, now, message, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        await UpdateRunStatusAsync(basis.RunId, cancellationToken);
    }

    public async Task MarkExportFailedAsync(Guid basisId, string system, string message, string? correlationId, CancellationToken cancellationToken)
    {
        if (await db.BillingBases.Include(b => b.Attempts).SingleOrDefaultAsync(b => b.Id == basisId, cancellationToken) is not { } basis)
        {
            return;
        }

        basis.MarkFailed(system, message, time.GetUtcNow(), correlationId);
        await db.SaveChangesAsync(cancellationToken);
        await UpdateRunStatusAsync(basis.RunId, cancellationToken);
    }

    public async Task<InvoiceSyncResult> UpsertInvoicesAsync(IReadOnlyCollection<ExternalInvoice> invoices, CancellationToken cancellationToken)
    {
        int created = 0, updated = 0, unchanged = 0, unmatched = 0;
        var now = time.GetUtcNow();
        foreach (var group in invoices.GroupBy(i => i.System, StringComparer.Ordinal))
        {
            var numbers = group.Select(i => i.InvoiceNo).Distinct(StringComparer.Ordinal).ToList();
            var existing = await db.Invoices
                .Include(i => i.Payments)
                .Where(i => i.System == group.Key && numbers.Contains(i.InvoiceNo))
                .ToDictionaryAsync(i => i.InvoiceNo, StringComparer.Ordinal, cancellationToken);

            // The order reference carries the basis key, so an invoice finds its basis and customer even without a mapping.
            var references = group.Select(i => i.ExternalReference).Where(r => !string.IsNullOrWhiteSpace(r)).Select(r => r!).Distinct(StringComparer.Ordinal).ToList();
            var byKey = await db.BillingBases.AsNoTracking()
                .Where(b => references.Contains(b.IdempotencyKey))
                .Select(b => new { b.Id, b.IdempotencyKey, b.OrganizationId })
                .ToDictionaryAsync(b => b.IdempotencyKey, StringComparer.Ordinal, cancellationToken);
            var orderNumbers = group.Select(i => i.OrderNo).Where(o => !string.IsNullOrWhiteSpace(o)).Select(o => o!).Distinct(StringComparer.Ordinal).ToList();
            var basesByOrder = await db.BillingBases.AsNoTracking()
                .Where(b => b.OrderNo != null && orderNumbers.Contains(b.OrderNo))
                .Select(b => new { b.Id, OrderNo = b.OrderNo!, b.OrganizationId, b.ExportedAt })
                .ToListAsync(cancellationToken);
            // An order number is not ours to keep unique: a credited and re-exported basis, or a restored database, can repeat
            // it. The newest export wins instead of failing the whole sync.
            var byOrder = basesByOrder
                .GroupBy(b => b.OrderNo, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.OrderByDescending(b => b.ExportedAt).First(), StringComparer.Ordinal);

            foreach (var incoming in group.DistinctBy(i => i.InvoiceNo, StringComparer.Ordinal))
            {
                var match = incoming.ExternalReference is { } key && byKey.TryGetValue(key, out var byReference)
                    ? (byReference.Id, byReference.OrganizationId)
                    : incoming.OrderNo is { } order && byOrder.TryGetValue(order, out var byOrderNo)
                        ? (byOrderNo.Id, byOrderNo.OrganizationId)
                        : ((Guid, Guid)?)null;
                var organizationId = incoming.OrganizationId ?? match?.Item2;
                if (organizationId is null)
                {
                    unmatched++;
                }

                if (existing.TryGetValue(incoming.InvoiceNo, out var invoice))
                {
                    if (invoice.Apply(incoming, organizationId, match?.Item1, now))
                    {
                        updated++;
                    }
                    else
                    {
                        unchanged++;
                    }
                }
                else
                {
                    db.Invoices.Add(Invoice.From(incoming, organizationId, match?.Item1, now));
                    created++;
                }
            }
        }

        await db.SaveChangesAsync(cancellationToken);
        return new InvoiceSyncResult(created, updated, unchanged, unmatched);
    }

    /// <summary>FR-LIC-04: licence lines billed to customers for a period, so Microsoft's invoice can be held against them.</summary>
    public async Task<IReadOnlyList<BilledLicenseLine>> GetBilledLicensesAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken)
    {
        DateOnly first = periodStart, last = periodEnd;
        var rows = await (
                from line in db.BillingLines.AsNoTracking()
                join basis in db.BillingBases.AsNoTracking() on line.BasisId equals basis.Id
                join run in db.BillingRuns.AsNoTracking() on basis.RunId equals run.Id
                where run.PeriodStart >= first && run.PeriodStart <= last &&
                      basis.Status != BillingBasisStatus.Cancelled && line.Group == BillingGroup.License && line.Decision != BillingLineDecision.Exclusion
                select new { basis.OrganizationId, line.ProductId, line.Quantity, line.LineTotal })
            .ToListAsync(cancellationToken);

        return rows
            .GroupBy(r => new { r.OrganizationId, r.ProductId })
            .Select(g => new BilledLicenseLine(g.Key.OrganizationId, g.Key.ProductId, g.Sum(r => r.Quantity), g.Sum(r => r.LineTotal)))
            .ToList();
    }

    public async Task<IReadOnlyList<RevenueByOrganization>> GetRevenueByOrganizationAsync(
        DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken)
    {
        var rows = await (
                from line in db.BillingLines.AsNoTracking()
                join basis in db.BillingBases.AsNoTracking() on line.BasisId equals basis.Id
                join run in db.BillingRuns.AsNoTracking() on basis.RunId equals run.Id
                where run.PeriodStart >= periodStart && run.PeriodStart <= periodEnd &&
                      basis.Status != BillingBasisStatus.Cancelled && line.Group != BillingGroup.Info && line.Decision != BillingLineDecision.Exclusion
                select new { basis.OrganizationId, line.Group, line.LineTotal })
            .ToListAsync(cancellationToken);

        return rows
            .GroupBy(r => r.OrganizationId)
            .Select(g => new RevenueByOrganization(
                g.Key,
                decimal.Round(g.Sum(r => r.LineTotal), 2),
                Sum(g, BillingGroup.License),
                Sum(g, BillingGroup.Subscription),
                Sum(g, BillingGroup.HourlyWork) + Sum(g, BillingGroup.HourBank),
                Sum(g, BillingGroup.OneOff)))
            .ToList();

        static decimal Sum(IEnumerable<dynamic> lines, BillingGroup group) =>
            decimal.Round(lines.Where(l => (BillingGroup)l.Group == group).Sum(l => (decimal)l.LineTotal), 2);

    }

    public async Task<IReadOnlyList<RevenueByMonth>> GetRevenueAsync(DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        DateOnly firstPeriod = from, lastPeriod = to;
        var rows = await (
                from line in db.BillingLines.AsNoTracking()
                join basis in db.BillingBases.AsNoTracking() on line.BasisId equals basis.Id
                join run in db.BillingRuns.AsNoTracking() on basis.RunId equals run.Id
                where run.PeriodStart >= firstPeriod && run.PeriodStart <= lastPeriod &&
                      basis.Status != BillingBasisStatus.Cancelled && line.Group != BillingGroup.Info && line.Decision != BillingLineDecision.Exclusion
                select new { run.PeriodStart.Year, run.PeriodStart.Month, line.ProductId, line.LineTotal })
            .ToListAsync(cancellationToken);

        return rows
            .GroupBy(r => new { r.Year, r.Month })
            .Select(g => new RevenueByMonth(
                g.Key.Year,
                g.Key.Month,
                decimal.Round(g.Sum(r => r.LineTotal), 2),
                g.Where(r => r.ProductId is not null)
                    .GroupBy(r => r.ProductId!.Value)
                    .ToDictionary(p => p.Key, p => decimal.Round(p.Sum(r => r.LineTotal), 2))))
            .OrderBy(r => r.Year)
            .ThenBy(r => r.Month)
            .ToList();
    }

    public async Task<InvoiceTotals> GetInvoiceTotalsAsync(DateOnly today, CancellationToken cancellationToken)
    {
        var open = await db.Invoices.AsNoTracking()
            .Where(i => i.Outstanding > 0 && i.Status != InvoiceStatus.Credited)
            .Select(i => new { i.Outstanding, i.DueDate })
            .ToListAsync(cancellationToken);
        var overdue = open.Where(i => i.DueDate != null && i.DueDate < today).ToList();
        return new InvoiceTotals(
            open.Count,
            decimal.Round(open.Sum(i => i.Outstanding), 2),
            decimal.Round(overdue.Sum(i => i.Outstanding), 2),
            overdue.Count);
    }

    /// <summary>Every overdue invoice (DEV-12): the daily scan notices all of them, not the oldest few hundred.</summary>
    public async Task<IReadOnlyList<OverdueInvoice>> GetOverdueInvoicesAsync(DateOnly today, CancellationToken cancellationToken)
    {
        var rows = await db.Invoices.AsNoTracking()
            .Where(i => i.Outstanding > 0 && i.Status != InvoiceStatus.Credited && i.DueDate != null && i.DueDate < today)
            .OrderBy(i => i.DueDate).ThenBy(i => i.Id)
            .Select(i => new { i.Id, i.InvoiceNo, i.OrganizationId, i.Outstanding, i.DueDate })
            .ToListAsync(cancellationToken);

        return rows
            .Select(i => new OverdueInvoice(
                i.Id, i.InvoiceNo, i.OrganizationId, i.Outstanding, i.DueDate!.Value, today.DayNumber - i.DueDate!.Value.DayNumber))
            .ToList();
    }

    private Task UpdateRunStatusAsync(Guid runId, CancellationToken ct) => UpdateRunStatusAsync(db, runId, time.GetUtcNow(), ct);

    /// <summary>
    /// The run follows its bases: exporting while any is waiting, then exported, or exported with errors while a basis failed
    /// or waits for reconciliation (ADR-013). Two bases of one run finishing at the same moment both update the run: the
    /// loser of that race reads the run again and derives its status again, which is always right because the status is
    /// derived from the bases (DEV-07; found in DEV-15). Without this the export of the second basis — already done in the
    /// accounting system — failed afterwards and could leave the run "exporting".
    /// </summary>
    internal static async Task UpdateRunStatusAsync(BillingDbContext db, Guid runId, DateTimeOffset now, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                await DeriveRunStatusAsync(db, runId, now, ct);
                return;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 4)
            {
                foreach (var entry in db.ChangeTracker.Entries<BillingRun>().Where(e => e.Entity.Id == runId).ToList())
                {
                    entry.State = EntityState.Detached;
                }
            }
        }
    }

    private static async Task DeriveRunStatusAsync(BillingDbContext db, Guid runId, DateTimeOffset now, CancellationToken ct)
    {
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == runId, ct) is not { } run || run.Status == BillingRunStatus.Closed)
        {
            return;
        }

        var statuses = await db.BillingBases.AsNoTracking().Where(b => b.RunId == runId).Select(b => b.Status).ToListAsync(ct);
        if (statuses.Contains(BillingBasisStatus.Approved))
        {
            if (run.Status == BillingRunStatus.Approved)
            {
                run.StartExport();
            }
        }
        else if (run.Status is BillingRunStatus.Approved or BillingRunStatus.Exporting or BillingRunStatus.Exported or BillingRunStatus.ExportedWithErrors)
        {
            run.FinishExport(statuses.Contains(BillingBasisStatus.Failed) || statuses.Contains(BillingBasisStatus.ReconciliationRequired), now);
        }

        await db.SaveChangesAsync(ct);
    }

    private async Task<Dictionary<Guid, BillingRun>> RunsOfAsync(IReadOnlyCollection<BillingBasis> bases, CancellationToken ct)
    {
        var runIds = bases.Select(b => b.RunId).Distinct().ToList();
        return await db.BillingRuns.AsNoTracking().Where(r => runIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, ct);
    }

    private async Task<IReadOnlyDictionary<Guid, ProductRef>> ProductCodesAsync(IReadOnlyCollection<BillingBasis> bases, CancellationToken ct)
    {
        var productIds = bases.SelectMany(b => b.BilledLines).Where(l => l.ProductId is not null).Select(l => l.ProductId!.Value).Distinct().ToList();
        return await catalog.GetProductsAsync(productIds, ct);
    }

    private static ExportBasis ToExport(BillingBasis basis, BillingRun run, IReadOnlyDictionary<Guid, ProductRef> products) => new(
        basis.Id,
        basis.RunId,
        basis.OrganizationId,
        basis.IdempotencyKey,
        run.PeriodStart,
        run.PeriodEnd,
        basis.CustomerReference,
        basis.TotalExVat,
        basis.SendStartedAt is not null,
        basis.BilledLines
            .Where(l => l.Group != BillingGroup.Info || l.LineTotal != 0)
            .OrderBy(l => l.Group)
            .Select(l => new ExportLine(
                l.Group,
                l.ProductId,
                l.ProductCode ?? (l.ProductId is { } id ? products.GetValueOrDefault(id)?.Sku : null),
                l.Description,
                l.Quantity,
                l.UnitPrice,
                l.DiscountPct,
                l.LineTotal))
            .ToList());
}

/// <summary>
/// One-time items become invoiced once their basis left the CRM (BR-BIL-08, BR-SAL-07). Its hours are marked by time
/// tracking, which hears the same event (DEV-07: a handler changes one module only).
/// </summary>
internal sealed class BasisExportedHandler(
    BillingDbContext db, TimeProvider time, ILogger<BasisExportedHandler> logger) : IDomainEventHandler<BillingBasisExported>
{
    public async Task HandleAsync(BillingBasisExported domainEvent, CancellationToken cancellationToken)
    {
        // Only what was invoiced closes its source: an excluded line leaves its one-time items for a later run.
        var lines = await db.BillingLines.AsNoTracking()
            .Where(l => l.BasisId == domainEvent.BasisId && l.SourceRefs != null && l.Decision != BillingLineDecision.Exclusion)
            .Select(l => l.SourceRefs!)
            .ToListAsync(cancellationToken);
        var chargeIds = lines.SelectMany(json => SourceRefs.Ids(json, "pendingChargeIds")).Distinct().ToList();
        if (chargeIds.Count == 0)
        {
            return;
        }

        // The one-time items on this basis are now invoiced and must not be collected into another run (BR-SAL-07) — also
        // one withdrawn meanwhile (a project phase reopened), so that completing it again does not queue it a second time.
        foreach (var charge in await db.PendingCharges.IgnoreQueryFilters().Where(c => chargeIds.Contains(c.Id)).ToListAsync(cancellationToken))
        {
            charge.MarkInvoiced(domainEvent.BasisId, time.GetUtcNow());
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Basis {BasisId} exported as {OrderNo}: {Charges} one-time items marked invoiced.",
            domainEvent.BasisId, domainEvent.OrderNo, chargeIds.Count);
    }
}

internal static class SourceRefs
{
    public static IEnumerable<Guid> TimeEntryIds(string json) => Ids(json, "timeEntryIds");

    public static IEnumerable<Guid> Ids(string json, string property)
    {
        using var document = System.Text.Json.JsonDocument.Parse(json);
        if (!document.RootElement.TryGetProperty(property, out var ids) || ids.ValueKind != System.Text.Json.JsonValueKind.Array)
        {
            return [];
        }

        return ids.EnumerateArray().Where(e => e.ValueKind == System.Text.Json.JsonValueKind.String)
            .Select(e => Guid.TryParse(e.GetString(), out var id) ? id : Guid.Empty)
            .Where(id => id != Guid.Empty)
            .ToList();
    }
}
