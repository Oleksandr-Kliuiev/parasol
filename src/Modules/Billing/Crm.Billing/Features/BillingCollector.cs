using System.Globalization;
using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Licensing.Contracts;
using Crm.Service.Contracts;
using Crm.TimeTracking.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Billing.Features;

public sealed record CollectResult(int Organizations, int Lines, decimal Total, int WithAnomalies, bool RequiresSecondApproval, int Conflicts);

/// <summary>
/// Builds the bases of a run from contracts, CSP subscriptions, approved hours, hour-bank purchases and manual lines
/// (docs/02 §4.9). Every collected line carries a charge key, so re-collecting updates the same lines and keeps Finance's
/// decisions once instead of adding the source again (BR-BIL-02, docs/adr/ADR-011).
/// </summary>
internal sealed class BillingCollector(
    BillingDbContext db,
    IContractsApi contracts,
    ICatalogApi catalog,
    ICustomersApi customers,
    ILicensingApi licensing,
    ITimeTrackingApi timeTracking,
    IServiceApi service,
    IEnumerable<IBillingTargetSystem> targets,
    IOptions<BillingOptions> options)
{
    public async Task<CollectResult> CollectAsync(BillingRun run, CancellationToken ct)
    {
        var settings = options.Value;
        var periodStart = run.PeriodStart;
        var periodEnd = run.PeriodEnd;

        var contractLines = await contracts.GetBillableLinesAsync(periodStart, periodEnd, ct);
        var purchases = await contracts.GetHourBankPurchasesAsync(periodStart, periodEnd, ct);
        var billableTime = await timeTracking.GetBillableTimeAsync(periodStart, periodEnd, ct);
        // One-time items that are waiting for a run (an accepted quote today); they stay queued until a basis is exported.
        var pendingCharges = await db.PendingCharges
            .Where(c => c.InvoicedBasisId == null && c.ChargeableFrom <= periodEnd)
            .ToListAsync(ct);
        var subscriptions = await licensing.GetSubscriptionQuantitiesAsync(periodEnd, ct);
        // Assigned Microsoft 365 licences from the tenant reading (FR-LIC-03); without it the contract estimate is used.
        var assigned = (await licensing.GetAssignedLicensesAsync(periodEnd, ct))
            .ToDictionary(a => (a.OrganizationId, a.ProductId), a => a);

        var defaultCategory = await catalog.GetDefaultCategoryAsync(ct);
        var productIds = contractLines.Select(l => l.ProductId).Distinct().ToList();
        var products = await catalog.GetProductsAsync(productIds, ct);

        // Prices are resolved once per customer category of the contracts in the run.
        var categories = contractLines.Select(l => l.PriceCategory ?? defaultCategory).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var pricesByCategory = new Dictionary<string, IReadOnlyDictionary<Guid, ResolvedPrice>>(StringComparer.OrdinalIgnoreCase);
        foreach (var category in categories)
        {
            pricesByCategory[category] = await catalog.ResolvePricesAsync(productIds, category, periodStart, ct);
        }

        var organizationIds = contractLines.Select(l => l.OrganizationId)
            .Concat(purchases.Select(p => p.OrganizationId))
            .Concat(billableTime.Select(t => t.OrganizationId))
            .Concat(pendingCharges.Select(c => c.OrganizationId))
            .Distinct()
            .ToList();

        // FR-CUS-07: a subsidiary billed through its group parent has no basis of its own; its lines join the parent's.
        var invoiceTargets = (await customers.GetInvoiceTargetsAsync(ct))
            .Where(t => organizationIds.Contains(t.Key))
            .ToDictionary(t => t.Key, t => t.Value);
        var subsidiaryNames = invoiceTargets.Count > 0
            ? await customers.GetOrganizationNamesAsync(invoiceTargets.Keys.ToList(), ct)
            : new Dictionary<Guid, string>();

        var previousTotals = await PreviousTotalsAsync(run, ct);
        var existing = await db.BillingBases
            .Include(b => b.Lines)
            .Where(b => b.RunId == run.Id)
            .ToDictionaryAsync(b => b.OrganizationId, ct);
        // A customer can drop out of a run and come back on a later collect. The basis key ({period}-{customer}-{run}) is
        // unique, so the earlier basis is brought back instead of a second one being created.
        var dropped = await db.BillingBases.IgnoreQueryFilters()
            .Where(b => b.RunId == run.Id && b.IsDeleted)
            .ToDictionaryAsync(b => b.OrganizationId, ct);

        var hourlyProducts = await ResolveHourlyProductsAsync(billableTime, settings.FallbackHourlySku, ct);
        var subscriptionsByOrganization = subscriptions.GroupBy(s => s.OrganizationId).ToDictionary(g => g.Key, g => g.ToList());
        var drafts = new List<(Guid OrganizationId, List<LineDraft> Lines, List<BillingAnomaly> Anomalies, string? CustomerReference)>();

        foreach (var organizationId in organizationIds)
        {
            var lines = new List<LineDraft>();
            var anomalies = new List<BillingAnomaly>();
            var organizationLines = contractLines.Where(l => l.OrganizationId == organizationId).ToList();
            var customerReference = organizationLines.Select(l => l.CustomerReference).FirstOrDefault(r => !string.IsNullOrWhiteSpace(r));
            var deviceCounts = organizationLines.Any(l => l.QuantityModel == QuantityModel.PerAteraDevice)
                ? await service.GetDeviceCountsAsync(organizationId, periodEnd, ct)
                : new Dictionary<DeviceType, int>();

            foreach (var line in organizationLines)
            {
                var covered = BillingSchedule.Covers(line.ContractStart, line.InvoiceFrequency, line.InvoiceTiming, periodStart, line.LineValidFrom, line.LineValidTo);
                if (covered is null)
                {
                    continue;
                }

                products.TryGetValue(line.ProductId, out var product);
                if (product?.Type == ProductType.HourBank)
                {
                    // Prepaid hours are invoiced when the package is bought, not every month.
                    continue;
                }

                // FR-BIL-05: a line that starts, ends or changes in the middle of the covered period is billed for its days.
                var prorated = BillingSchedule.Prorate(covered, line.LineValidFrom, line.LineValidTo);
                if (prorated.Factor <= 0)
                {
                    continue;
                }

                var quantity = QuantityOf(
                    line, subscriptionsByOrganization.GetValueOrDefault(organizationId), deviceCounts, anomalies, product,
                    assigned.GetValueOrDefault((organizationId, line.ProductId)));
                if (quantity <= 0)
                {
                    continue;
                }

                var prices = pricesByCategory[line.PriceCategory ?? defaultCategory];
                var fullPrice = line.UnitPrice ?? (prices.TryGetValue(line.ProductId, out var resolved) ? resolved.UnitPrice : 0m);
                // The quantity stays what the customer has; the price carries the part of the period that is billed.
                var unitPrice = prorated.IsPartial ? decimal.Round(fullPrice * prorated.Factor, 2) : fullPrice;
                if (unitPrice <= 0)
                {
                    anomalies.Add(new BillingAnomaly("BIL_LINE_WITHOUT_PRICE", $"{product?.Name ?? "Product"} has no price for this period."));
                }

                var subscriptionIds = line.QuantityModel == QuantityModel.PerSubscription
                    ? subscriptionsByOrganization.GetValueOrDefault(organizationId)?.FirstOrDefault(s => s.ProductId == line.ProductId)?.SubscriptionIds
                    : null;

                // The service across its versions and the days it is billed for: two versions of a mid-period change are two
                // charges, a repeated collect of the same days is the same one.
                lines.Add(new LineDraft(
                    product?.Type == ProductType.MicrosoftLicense ? BillingGroup.License : BillingGroup.Subscription,
                    line.ProductId,
                    Describe(product?.Name ?? "Product", line.Description, covered, prorated),
                    quantity,
                    unitPrice,
                    line.DiscountPct,
                    product?.VatRate ?? 25m,
                    JsonSerializer.Serialize(new
                    {
                        contractId = line.ContractId,
                        contractLineId = line.LineId,
                        subscriptionIds,
                        prorationFactor = prorated.IsPartial ? prorated.Factor : (decimal?)null,
                    }),
                    string.Create(CultureInfo.InvariantCulture, $"contract:{line.SeriesId:N}:{prorated.From:yyyy-MM-dd}:{prorated.To:yyyy-MM-dd}"),
                    organizationId));
            }

            AddHourlyLines(lines, billableTime.Where(t => t.OrganizationId == organizationId).ToList(), hourlyProducts, periodStart, periodEnd, settings, anomalies);
            await AddHourBankLinesAsync(lines, purchases.Where(p => p.OrganizationId == organizationId).ToList(), organizationLines, products, pricesByCategory, defaultCategory, anomalies, ct);
            AddPendingChargeLines(lines, pendingCharges.Where(c => c.OrganizationId == organizationId).ToList());
            // The customer the work was done for travels with each line, also when a group parent pays for it (FR-CUS-07).
            lines = lines.ConvertAll(l => l with { SourceOrganizationId = organizationId });

            if (invoiceTargets.TryGetValue(organizationId, out var invoicedTo))
            {
                // Every line says which company in the group it belongs to, so one invoice still reads per company.
                var subsidiary = subsidiaryNames.GetValueOrDefault(organizationId, "—");
                lines = lines.ConvertAll(l => l with { Description = $"{subsidiary}: {l.Description}" });
                anomalies = anomalies.ConvertAll(a => a with { Message = $"{subsidiary}: {a.Message}" });
                var existingDraft = drafts.FindIndex(d => d.OrganizationId == invoicedTo);
                if (existingDraft >= 0)
                {
                    drafts[existingDraft].Lines.AddRange(lines);
                    drafts[existingDraft].Anomalies.AddRange(anomalies);
                    continue;
                }

                drafts.Add((invoicedTo, lines, anomalies, null));
                continue;
            }

            var own = drafts.FindIndex(d => d.OrganizationId == organizationId);
            if (own >= 0)
            {
                // The parent was collected after one of its subsidiaries; its own lines go first on the invoice.
                drafts[own].Lines.InsertRange(0, lines);
                drafts[own].Anomalies.InsertRange(0, anomalies);
                drafts[own] = drafts[own] with { CustomerReference = customerReference ?? drafts[own].CustomerReference };
                continue;
            }

            drafts.Add((organizationId, lines, anomalies, customerReference));
        }

        // The accounting system is asked about every product that actually reached a line, not only the contract ones.
        var linedProductIds = drafts.SelectMany(d => d.Lines).Where(l => l.ProductId is not null).Select(l => l.ProductId!.Value)
            .Concat(productIds)
            .Distinct()
            .ToList();
        var allProducts = await catalog.GetProductsAsync(linedProductIds, ct);
        var readiness = await CheckTargetsAsync(organizationIds, linedProductIds, ct);

        var totalLines = 0;
        decimal total = 0;
        var withAnomalies = 0;
        var requiresSecondApproval = false;
        var conflicts = 0;

        foreach (var (organizationId, lines, anomalies, customerReference) in drafts)
        {
            var basis = existing.GetValueOrDefault(organizationId);
            if (basis is null && dropped.Remove(organizationId, out var earlier))
            {
                earlier.Restore();
                basis = earlier;
                existing[organizationId] = basis;
            }

            if (basis is null)
            {
                basis = BillingBasis.Create(run, organizationId, customerReference);
                db.BillingBases.Add(basis);
                existing[organizationId] = basis;
            }

            var applied = basis.ApplyCollected(lines, customerReference);
            if (!applied.IsSuccess)
            {
                if (applied.Error!.Code == "BIL_BASIS_LOCKED")
                {
                    continue;
                }

                // A duplicate or missing charge key is a defect of a source, never something to bill around.
                throw new InvalidOperationException(applied.Error.Message);
            }

            conflicts += applied.Value.Conflicts;

            basis.SetPreviousTotal(previousTotals.GetValueOrDefault(organizationId));
            await AddPortfolioAnomaliesAsync(anomalies, basis, organizationId, periodEnd, readiness, allProducts, settings, ct);
            basis.SetAnomalies(anomalies);

            totalLines += basis.CurrentLines.Count();
            total += basis.TotalExVat;
            if (anomalies.Count > 0)
            {
                withAnomalies++;
            }

            if (basis.TotalExVat > settings.SecondApprovalThreshold)
            {
                requiresSecondApproval = true;
            }
        }

        // A customer who no longer has anything to bill keeps no empty basis around.
        foreach (var (organizationId, basis) in existing)
        {
            if (basis.IsLocked)
            {
                continue;
            }

            // A subsidiary that has since joined its parent's invoice drops the basis it had from an earlier collect; lines
            // Finance decided about stay, flagged, until somebody resolves them.
            if (invoiceTargets.ContainsKey(organizationId) && basis.CurrentLines.Any())
            {
                conflicts += basis.ApplyCollected([], null).Value.Conflicts;
            }
            else if (!organizationIds.Contains(organizationId) && basis.CurrentLines.Any())
            {
                // Nothing to bill for this customer any more: collected lines go, decided ones wait for Finance.
                conflicts += basis.ApplyCollected([], null).Value.Conflicts;
            }

            if ((!organizationIds.Contains(organizationId) || invoiceTargets.ContainsKey(organizationId)) && !basis.CurrentLines.Any())
            {
                basis.MarkDeleted();
            }
        }

        return new CollectResult(existing.Values.Count(b => !b.IsDeleted), totalLines, decimal.Round(total, 2), withAnomalies, requiresSecondApproval, conflicts);
    }

    /// <summary>One-time items from accepted quotes (BR-SAL-07); they carry their id so the export can close them.</summary>
    private static void AddPendingChargeLines(List<LineDraft> lines, IReadOnlyList<PendingCharge> charges)
    {
        foreach (var charge in charges)
        {
            lines.Add(new LineDraft(
                BillingGroup.OneOff,
                charge.ProductId,
                charge.Description,
                charge.Quantity,
                charge.UnitPrice,
                charge.DiscountPct,
                charge.VatRate,
                JsonSerializer.Serialize(new { pendingChargeIds = new[] { charge.Id } }),
                string.Create(CultureInfo.InvariantCulture, $"pending:{charge.Id:N}")));
        }
    }

    private static decimal QuantityOf(
        BillableContractLine line,
        List<SubscriptionQuantity>? subscriptions,
        IReadOnlyDictionary<DeviceType, int> deviceCounts,
        List<BillingAnomaly> anomalies,
        ProductRef? product,
        AssignedLicenses? assigned) => line.QuantityModel switch
    {
        QuantityModel.PerSubscription => SubscriptionQuantityOf(line, subscriptions, anomalies, product),
        QuantityModel.PerAteraDevice => line.DeviceFilter switch
        {
            DeviceFilter.Workstations => deviceCounts.GetValueOrDefault(DeviceType.Workstation),
            DeviceFilter.Servers => deviceCounts.GetValueOrDefault(DeviceType.Server),
            _ => deviceCounts.Values.Sum(),
        },
        QuantityModel.PerM365User => M365UserQuantity(line, anomalies, product, assigned),
        _ => line.Quantity,
    };

    private static decimal SubscriptionQuantityOf(
        BillableContractLine line, List<SubscriptionQuantity>? subscriptions, List<BillingAnomaly> anomalies, ProductRef? product)
    {
        if (subscriptions?.FirstOrDefault(s => s.ProductId == line.ProductId) is { } match)
        {
            return match.Quantity;
        }

        anomalies.Add(new BillingAnomaly(
            "BIL_NO_SUBSCRIPTION", $"{product?.Name ?? "Product"} is billed per subscription, but the customer has none; the contract quantity is used."));
        return line.Quantity;
    }

    /// <summary>
    /// BR-CON-02: the number of assigned licences in the customer's tenant (FR-LIC-03). Without a reading the contract's
    /// estimate is billed and the basis says so, so nobody silently invoices a guess.
    /// </summary>
    private static decimal M365UserQuantity(
        BillableContractLine line, List<BillingAnomaly> anomalies, ProductRef? product, AssignedLicenses? assigned)
    {
        if (assigned is null)
        {
            anomalies.Add(new BillingAnomaly(
                "BIL_ESTIMATED_QUANTITY", $"{product?.Name ?? "Product"} is billed per Microsoft 365 user; the contract estimate is used until the tenant is read."));
            return line.Quantity;
        }

        if (assigned.Assigned == 0)
        {
            anomalies.Add(new BillingAnomaly(
                "BIL_NO_ASSIGNED_LICENCES", $"{product?.Name ?? "Product"} is billed per Microsoft 365 user, but the tenant has none assigned ({assigned.SnapshotDate:dd.MM.yyyy})."));
            return line.Quantity;
        }

        return assigned.Assigned;
    }

    private static void AddHourlyLines(
        List<LineDraft> lines,
        List<BillableTime> entries,
        IReadOnlyDictionary<string, ProductRef> hourlyProducts,
        DateOnly periodStart,
        DateOnly periodEnd,
        BillingOptions settings,
        List<BillingAnomaly> anomalies)
    {
        var period = $"{periodStart:dd.MM.yyyy}–{periodEnd:dd.MM.yyyy}";
        foreach (var group in entries.Where(e => e.Classification == TimeClassification.Rate && e.BilledHours > 0)
                     .GroupBy(e => new { Key = e.WorkType ?? string.Empty, e.Rate }))
        {
            var product = hourlyProducts.GetValueOrDefault(group.Key.Key);
            if (product is null)
            {
                anomalies.Add(new BillingAnomaly("BIL_NO_HOURLY_PRODUCT", $"No hourly product for work type “{group.Key.Key}”; the hours are not billed."));
                continue;
            }

            var rate = group.Key.Rate ?? 0m;
            if (settings.DetailedHourLines)
            {
                foreach (var entry in group.OrderBy(e => e.WorkDate).ThenBy(e => e.EntryId))
                {
                    lines.Add(new LineDraft(
                        BillingGroup.HourlyWork,
                        product.Id,
                        HourDescription(product.Name, entry),
                        entry.BilledHours,
                        rate,
                        0,
                        product.VatRate,
                        JsonSerializer.Serialize(new { timeEntryIds = new[] { entry.EntryId }, allocationIds = new[] { entry.AllocationId } }),
                        // The approved allocation: a re-approval creates new allocations and therefore a new charge.
                        string.Create(CultureInfo.InvariantCulture, $"time:{entry.AllocationId:N}")));
                }
            }
            else
            {
                lines.Add(new LineDraft(
                    BillingGroup.HourlyWork,
                    product.Id,
                    $"{product.Name} ({period})",
                    group.Sum(e => e.BilledHours),
                    rate,
                    0,
                    product.VatRate,
                    JsonSerializer.Serialize(new
                    {
                        timeEntryIds = group.Select(e => e.EntryId).Distinct().ToList(),
                        allocationIds = group.Select(e => e.AllocationId).ToList(),
                    }),
                    string.Create(CultureInfo.InvariantCulture, $"time:{group.Key.Key}:{rate:0.####}")));
            }
        }

        if (!settings.IncludeInfoLines)
        {
            return;
        }

        // Covered and prepaid hours are shown so the customer sees the work, at no charge (docs/02 §4.9).
        foreach (var group in entries.Where(e => e.Classification is TimeClassification.Covered or TimeClassification.HourBank && e.Hours > 0)
                     .GroupBy(e => e.Classification))
        {
            var label = group.Key == TimeClassification.Covered ? "Included in the contract" : "Drawn from the prepaid hours";
            lines.Add(new LineDraft(
                BillingGroup.Info,
                null,
                $"{label} ({period})",
                decimal.Round(group.Sum(e => e.Hours), 2),
                0,
                0,
                0,
                JsonSerializer.Serialize(new { timeEntryIds = group.Select(e => e.EntryId).Distinct().ToList() }),
                $"info:{group.Key}"));
        }
    }

    /// <summary>BR-BIL-07: the description always names the period the line covers.</summary>
    private static string Describe(string productName, string? lineDescription, CoveredPeriod covered, Proration prorated)
    {
        var name = string.IsNullOrWhiteSpace(lineDescription) ? productName : $"{productName} — {lineDescription}";
        return prorated.IsPartial
            ? $"{name} ({prorated.From:dd.MM.yyyy}–{prorated.To:dd.MM.yyyy}, {prorated.To.DayNumber - prorated.From.DayNumber + 1}/{covered.Days})"
            : $"{name} ({covered.From:dd.MM.yyyy}–{covered.To:dd.MM.yyyy})";
    }

    private static string HourDescription(string productName, BillableTime entry)
    {
        var parts = new List<string> { $"{productName} {entry.WorkDate:dd.MM.yyyy}" };
        if (entry.ExternalTicketId is { } ticket)
        {
            parts.Add($"#{ticket.ToString(CultureInfo.InvariantCulture)}");
        }

        if (!string.IsNullOrWhiteSpace(entry.Description ?? entry.TicketTitle))
        {
            parts.Add((entry.Description ?? entry.TicketTitle)!);
        }

        if (!string.IsNullOrWhiteSpace(entry.TechnicianName))
        {
            parts.Add(entry.TechnicianName!);
        }

        return string.Join(" · ", parts);
    }

    private async Task AddHourBankLinesAsync(
        List<LineDraft> lines,
        List<HourBankPurchase> purchases,
        List<BillableContractLine> organizationLines,
        IReadOnlyDictionary<Guid, ProductRef> products,
        Dictionary<string, IReadOnlyDictionary<Guid, ResolvedPrice>> pricesByCategory,
        string defaultCategory,
        List<BillingAnomaly> anomalies,
        CancellationToken ct)
    {
        foreach (var purchase in purchases)
        {
            var line = organizationLines.FirstOrDefault(l =>
                (purchase.ContractId is null || l.ContractId == purchase.ContractId) &&
                products.TryGetValue(l.ProductId, out var candidate) && candidate.Type == ProductType.HourBank);
            if (line is null)
            {
                anomalies.Add(new BillingAnomaly(
                    "BIL_NO_HOUR_BANK_PRODUCT", $"The prepaid package “{purchase.Name}” has no hour-bank product on the contract; add the line by hand."));
                continue;
            }

            var product = products[line.ProductId];
            var prices = pricesByCategory.TryGetValue(line.PriceCategory ?? defaultCategory, out var known)
                ? known
                : await catalog.ResolvePricesAsync([line.ProductId], line.PriceCategory ?? defaultCategory, purchase.Date, ct);
            var unitPrice = line.UnitPrice ?? (prices.TryGetValue(line.ProductId, out var resolved) ? resolved.UnitPrice : 0m);
            lines.Add(new LineDraft(
                BillingGroup.HourBank,
                product.Id,
                $"{product.Name}: {purchase.Name} ({purchase.Hours.ToString("0.##", CultureInfo.InvariantCulture)} h, {purchase.Date:dd.MM.yyyy})",
                purchase.Hours,
                unitPrice,
                line.DiscountPct,
                product.VatRate,
                JsonSerializer.Serialize(new { hourBankId = purchase.HourBankId, hourBankEntryId = purchase.EntryId, contractId = line.ContractId }),
                // The purchase movement itself: re-reading it is the same charge, a second purchase of the same bank is another.
                string.Create(CultureInfo.InvariantCulture, $"hourbank:{purchase.EntryId:N}")));
        }
    }

    private async Task AddPortfolioAnomaliesAsync(
        List<BillingAnomaly> anomalies,
        BillingBasis basis,
        Guid organizationId,
        DateOnly periodEnd,
        BillingReadiness? readiness,
        IReadOnlyDictionary<Guid, ProductRef> products,
        BillingOptions settings,
        CancellationToken ct)
    {
        if (basis.PreviousPeriodTotal > 0)
        {
            var change = Math.Abs(basis.TotalExVat - basis.PreviousPeriodTotal) / basis.PreviousPeriodTotal * 100m;
            if (change > settings.TotalChangeAnomalyPct)
            {
                anomalies.Add(new BillingAnomaly(
                    "BIL_TOTAL_CHANGE",
                    $"The total changed by {change.ToString("0.#", CultureInfo.InvariantCulture)} % against the previous period."));
            }
        }

        if (readiness is not null)
        {
            if (!readiness.LinkedOrganizations.Contains(organizationId))
            {
                anomalies.Add(new BillingAnomaly("BIL_CUSTOMER_NOT_LINKED", "The customer is not linked to the accounting system; the order cannot be exported."));
            }

            foreach (var productId in basis.BilledLines.Where(l => l.ProductId is not null).Select(l => l.ProductId!.Value).Distinct())
            {
                if (!readiness.ProductCodes.ContainsKey(productId))
                {
                    anomalies.Add(new BillingAnomaly(
                        "BIL_PRODUCT_NOT_MAPPED", $"{products.GetValueOrDefault(productId)?.Name ?? "A product"} has no product in the accounting system."));
                }
            }
        }

        // BR-BIL-03: a subscription the customer pays Microsoft for but has no contract line for is money left on the table.
        var contracted = await contracts.GetContractedProductsAsync(organizationId, periodEnd, ct);
        var quantities = await licensing.GetSubscriptionQuantitiesAsync(periodEnd, ct);
        foreach (var subscription in quantities.Where(s => s.OrganizationId == organizationId && !contracted.Contains(s.ProductId)))
        {
            anomalies.Add(new BillingAnomaly(
                "BIL_SUBSCRIPTION_NOT_CONTRACTED", $"{subscription.OfferName ?? subscription.OfferId} ({subscription.Quantity}) is not on any contract line."));
        }

        foreach (var offer in await licensing.GetUnmappedOfferNamesAsync(organizationId, periodEnd, ct))
        {
            anomalies.Add(new BillingAnomaly("BIL_SUBSCRIPTION_NOT_MAPPED", $"The subscription “{offer}” has no catalog product."));
        }
    }

    private async Task<IReadOnlyDictionary<string, ProductRef>> ResolveHourlyProductsAsync(
        IReadOnlyList<BillableTime> entries, string? fallbackSku, CancellationToken ct)
    {
        var workTypes = entries.Where(e => e.Classification == TimeClassification.Rate).Select(e => e.WorkType ?? string.Empty).Distinct().ToList();
        var result = new Dictionary<string, ProductRef>(StringComparer.OrdinalIgnoreCase);
        foreach (var workType in workTypes)
        {
            if (await catalog.FindHourlyProductAsync(workType.Length == 0 ? null : workType, fallbackSku, ct) is { } product)
            {
                result[workType] = product;
            }
        }

        return result;
    }

    private async Task<BillingReadiness?> CheckTargetsAsync(IReadOnlyCollection<Guid> organizationIds, IReadOnlyCollection<Guid> productIds, CancellationToken ct)
    {
        foreach (var target in targets.Where(t => t.IsConfigured))
        {
            return await target.CheckAsync(organizationIds, productIds, ct);
        }

        return null;
    }

    private async Task<Dictionary<Guid, decimal>> PreviousTotalsAsync(BillingRun run, CancellationToken ct)
    {
        var previous = await db.BillingRuns.AsNoTracking()
            .Where(r => r.PeriodStart < run.PeriodStart)
            .OrderByDescending(r => r.PeriodStart)
            .Select(r => r.Id)
            .FirstOrDefaultAsync(ct);
        if (previous == Guid.Empty)
        {
            return [];
        }

        return await db.BillingBases.AsNoTracking()
            .Where(b => b.RunId == previous)
            .GroupBy(b => b.OrganizationId)
            .Select(g => new { g.Key, Total = g.Sum(b => b.TotalExVat) })
            .ToDictionaryAsync(x => x.Key, x => x.Total, ct);
    }
}
