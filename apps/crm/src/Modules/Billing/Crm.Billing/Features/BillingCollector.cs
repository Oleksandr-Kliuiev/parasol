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
using Crm.SharedKernel.Operations;
using Crm.TimeTracking.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Billing.Features;

public sealed record CollectResult(int Organizations, int Lines, decimal Total, int WithAnomalies, bool RequiresSecondApproval, int Conflicts);

/// <summary>
/// Builds the bases of a run from contracts, CSP subscriptions, approved hours, hour-bank purchases and manual lines
/// (docs/02 §4.9). Every collected line carries a charge key, so re-collecting updates the same lines and keeps Finance's
/// decisions once instead of adding the source again (BR-BIL-02, docs/adr/ADR-011). Across runs the charge register
/// decides: an obligation another run holds — billed, or reserved by another open run — is left out, and of a contract
/// service only the days no other run billed are collected (docs/adr/ADR-013). Runs inside the register's lock.
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
    ChargeLedger ledger,
    TimeProvider time,
    IOptions<BillingOptions> options,
    IEnumerable<ISyncCompletenessSource> syncCompleteness)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<CollectResult> CollectAsync(BillingRun run, CancellationToken ct)
    {
        var settings = options.Value;
        var periodStart = run.PeriodStart;
        var periodEnd = run.PeriodEnd;
        var now = time.GetUtcNow();

        var contractLines = await contracts.GetBillableLinesAsync(periodStart, periodEnd, ct);
        var purchases = await contracts.GetHourBankPurchasesAsync(periodStart, periodEnd, ct);
        // Hours that left with an exported order are never collected again, also where their charge predates the register.
        var billableTime = (await timeTracking.GetBillableTimeAsync(periodStart, periodEnd, ct)).Where(t => !t.Invoiced).ToList();
        // One-time items that are waiting for a run (an accepted quote today); they stay queued until a basis is exported.
        var pendingCharges = await db.PendingCharges
            .Where(c => c.InvoicedBasisId == null && c.ChargeableFrom <= periodEnd)
            .ToListAsync(ct);
        var snapshot = await ledger.LoadAsync(
            run.Id,
            billableTime.Select(t => ChargeLedger.TimeKey(t.AllocationId))
                .Concat(purchases.Select(p => ChargeLedger.HourBankKey(p.EntryId)))
                .Concat(pendingCharges.Select(c => ChargeLedger.PendingKey(c.Id)))
                .ToList(),
            contractLines.Select(l => l.SeriesId).Distinct().ToList(),
            contractLines.Select(l => l.LineId).Distinct().ToList(),
            ct);
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

        // DEV-16: load only this run's portfolio once. Parents need their own anomaly review even when only subsidiaries bill.
        var portfolioOrganizations = organizationIds.Concat(invoiceTargets.Values).Distinct().ToArray();
        var subscriptions = await licensing.GetSubscriptionQuantitiesAsync(portfolioOrganizations, periodEnd, ct);
        var contractedProducts = await contracts.GetContractedProductsAsync(portfolioOrganizations, periodEnd, ct);
        var unmappedOffers = await licensing.GetUnmappedOfferNamesAsync(portfolioOrganizations, periodEnd, ct);
        // A reading is as old as the day it was taken, measured from the end of the period, or from today when the period is not over yet.
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Oslo).DateTime);
        var readingReference = periodEnd < today ? periodEnd : today;
        var quantities = await BillingQuantities.ReadAsync(
            contractLines, subscriptions, periodEnd, readingReference, settings.StaleQuantityDays, licensing, service, ct);
        var hoursRun = await LatestHoursRunAsync(settings, ct);
        var previousTotals = await PreviousTotalsAsync(run, portfolioOrganizations, ct);
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
        var contractLinesByOrganization = contractLines.ToLookup(l => l.OrganizationId);
        var timeByOrganization = billableTime.ToLookup(t => t.OrganizationId);
        var purchasesByOrganization = purchases.ToLookup(p => p.OrganizationId);
        var chargesByOrganization = pendingCharges.ToLookup(c => c.OrganizationId);
        var draftIndexes = new Dictionary<Guid, int>();
        var drafts = new List<(Guid OrganizationId, List<LineDraft> Lines, List<BillingAnomaly> Anomalies, string? CustomerReference)>();

        foreach (var organizationId in organizationIds)
        {
            var lines = new List<LineDraft>();
            var anomalies = new List<BillingAnomaly>();
            var organizationLines = contractLinesByOrganization[organizationId].ToList();
            var customerReference = organizationLines.Select(l => l.CustomerReference).FirstOrDefault(r => !string.IsNullOrWhiteSpace(r));

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

                // ADR-013: a line billed before the register existed holds its days until Finance decides about it.
                if (snapshot.LegacyFor(line.LineId, prorated.From, prorated.To) is { } legacy)
                {
                    anomalies.Add(new BillingAnomaly(
                        "BIL_LEGACY_CHARGE",
                        $"{product?.Name ?? "Product"} was billed for {snapshot.PeriodOf(legacy):yyyy-MM} before charges were registered; it is not billed again until Finance decides about that line."));
                    continue;
                }

                // Only the days no other run holds: a quarter billed in advance and a later month of the same series never overlap.
                var pieces = ChargeCoverage.Uncovered(prorated.From, prorated.To, snapshot.TakenIntervals(line.SeriesId));
                if (pieces.Count == 0)
                {
                    continue;
                }

                var quantity = quantities.QuantityOf(line, product, anomalies);
                if (quantity <= 0)
                {
                    continue;
                }

                quantities.AddReadingAnomalies(line, product, anomalies);

                var prices = pricesByCategory[line.PriceCategory ?? defaultCategory];
                var fullPrice = line.UnitPrice ?? (prices.TryGetValue(line.ProductId, out var resolved) ? resolved.UnitPrice : 0m);
                var subscriptionIds = quantities.SubscriptionIdsOf(line);

                foreach (var (from, to) in pieces)
                {
                    var days = to.DayNumber - from.DayNumber + 1;
                    var piece = days >= covered.Days ? new Proration(covered.From, covered.To, 1m) : new Proration(from, to, decimal.Round((decimal)days / covered.Days, 4));

                    // The quantity stays what the customer has; the price carries the part of the period that is billed.
                    var unitPrice = piece.IsPartial ? decimal.Round(fullPrice * piece.Factor, 2) : fullPrice;
                    if (unitPrice <= 0)
                    {
                        anomalies.Add(new BillingAnomaly("BIL_LINE_WITHOUT_PRICE", $"{product?.Name ?? "Product"} has no price for this period."));
                    }

                    // The service across its versions and the days it is billed for: two versions of a mid-period change are two
                    // charges, a repeated collect of the same days is the same one.
                    var key = ChargeLedger.ContractKey(line.SeriesId, piece.From, piece.To);
                    lines.Add(new LineDraft(
                        product?.Type == ProductType.MicrosoftLicense ? BillingGroup.License : BillingGroup.Subscription,
                        line.ProductId,
                        Describe(product?.Name ?? "Product", line.Description, covered, piece),
                        quantity,
                        unitPrice,
                        line.DiscountPct,
                        product?.VatRate ?? 25m,
                        JsonSerializer.Serialize(new
                        {
                            contractId = line.ContractId,
                            contractLineId = line.LineId,
                            subscriptionIds,
                            prorationFactor = piece.IsPartial ? piece.Factor : (decimal?)null,
                        }),
                        key,
                        organizationId,
                        [new ChargeClaim(key, ChargeKind.Contract, BillingLine.Amount(quantity, unitPrice, line.DiscountPct), line.SeriesId, piece.From, piece.To, line.LineId)]));
                }
            }

            var hours = timeByOrganization[organizationId].ToList();
            var heldHours = hours.Where(t => snapshot.HeldElsewhere(ChargeLedger.TimeKey(t.AllocationId)) is not null).ToList();
            ReportHeldElsewhere(anomalies, heldHours.Select(t => snapshot.HeldElsewhere(ChargeLedger.TimeKey(t.AllocationId))!), snapshot,
                charge => string.Create(CultureInfo.InvariantCulture, $"{heldHours.Count} approved time entries"));
            AddHourlyLines(lines, hours.Except(heldHours).ToList(), hourlyProducts, periodStart, periodEnd, settings, anomalies);

            var organizationPurchases = purchasesByOrganization[organizationId].ToList();
            var heldPurchases = organizationPurchases.Where(p => snapshot.HeldElsewhere(ChargeLedger.HourBankKey(p.EntryId)) is not null).ToList();
            foreach (var purchase in heldPurchases)
            {
                ReportHeldElsewhere(anomalies, [snapshot.HeldElsewhere(ChargeLedger.HourBankKey(purchase.EntryId))!], snapshot, _ => $"The prepaid package “{purchase.Name}”");
            }

            await AddHourBankLinesAsync(lines, organizationPurchases.Except(heldPurchases).ToList(), organizationLines, products, pricesByCategory, defaultCategory, anomalies, ct);

            var organizationCharges = chargesByOrganization[organizationId].ToList();
            var heldCharges = organizationCharges.Where(c => snapshot.HeldElsewhere(ChargeLedger.PendingKey(c.Id)) is not null).ToList();
            foreach (var pending in heldCharges)
            {
                ReportHeldElsewhere(anomalies, [snapshot.HeldElsewhere(ChargeLedger.PendingKey(pending.Id))!], snapshot, _ => $"“{pending.Description}”");
            }

            AddPendingChargeLines(lines, organizationCharges.Except(heldCharges).ToList());
            if (hoursRun is { Complete: false })
            {
                var at = TimeZoneInfo.ConvertTime(hoursRun.StartedAt, Oslo);
                anomalies.Add(new BillingAnomaly(
                    "BIL_INCOMPLETE_HOURS",
                    $"The latest import of work hours did not finish completely ({at:dd.MM.yyyy HH:mm}); hours may be missing from this basis.",
                    new Dictionary<string, string> { ["date"] = at.ToString("dd.MM.yyyy HH:mm", CultureInfo.InvariantCulture) }));
            }

            // The customer the work was done for travels with each line, also when a group parent pays for it (FR-CUS-07).
            lines = lines.ConvertAll(l => l with { SourceOrganizationId = organizationId });

            if (invoiceTargets.TryGetValue(organizationId, out var invoicedTo))
            {
                // Every line says which company in the group it belongs to, so one invoice still reads per company.
                var subsidiary = subsidiaryNames.GetValueOrDefault(organizationId, "—");
                lines = lines.ConvertAll(l => l with { Description = $"{subsidiary}: {l.Description}" });
                anomalies = anomalies.ConvertAll(a => a with
                {
                    Message = $"{subsidiary}: {a.Message}",
                    Args = new Dictionary<string, string>(a.Args ?? new Dictionary<string, string>()) { ["subsidiary"] = subsidiary },
                });
                if (draftIndexes.TryGetValue(invoicedTo, out var existingDraft))
                {
                    drafts[existingDraft].Lines.AddRange(lines);
                    drafts[existingDraft].Anomalies.AddRange(anomalies);
                    continue;
                }

                draftIndexes.Add(invoicedTo, drafts.Count);
                drafts.Add((invoicedTo, lines, anomalies, null));
                continue;
            }

            if (draftIndexes.TryGetValue(organizationId, out var own))
            {
                // The parent was collected after one of its subsidiaries; its own lines go first on the invoice.
                drafts[own].Lines.InsertRange(0, lines);
                drafts[own].Anomalies.InsertRange(0, anomalies);
                drafts[own] = drafts[own] with { CustomerReference = customerReference ?? drafts[own].CustomerReference };
                continue;
            }

            draftIndexes.Add(organizationId, drafts.Count);
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
        var conflicts = 0;

        foreach (var (organizationId, lines, anomalies, customerReference) in drafts)
        {
            var basis = existing.GetValueOrDefault(organizationId);

            // Everything of this customer is billed or held by another run (a supplementary run, typically): no empty basis.
            if (basis is null && lines.Count == 0)
            {
                continue;
            }

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

            if (!basis.CurrentLines.Any())
            {
                basis.MarkDeleted();
            }

            ledger.Sync(basis, lines, snapshot, now);
            if (basis.IsDeleted)
            {
                continue;
            }

            conflicts += applied.Value.Conflicts;

            basis.SetPreviousTotal(previousTotals.GetValueOrDefault(organizationId));
            AddPortfolioAnomalies(anomalies, basis, organizationId, readiness, allProducts, settings,
                contractedProducts.GetValueOrDefault(organizationId), subscriptionsByOrganization.GetValueOrDefault(organizationId),
                unmappedOffers.GetValueOrDefault(organizationId));
            basis.SetAnomalies(anomalies);

            totalLines += basis.CurrentLines.Count();
            total += basis.TotalExVat;
            if (anomalies.Count > 0)
            {
                withAnomalies++;
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
            var gone = !organizationIds.Contains(organizationId) || invoiceTargets.ContainsKey(organizationId);
            if (!gone)
            {
                continue;
            }

            if (basis.CurrentLines.Any())
            {
                // Nothing to bill for this customer any more: collected lines go, decided ones wait for Finance.
                conflicts += basis.ApplyCollected([], null).Value.Conflicts;
            }

            if (!basis.CurrentLines.Any())
            {
                basis.MarkDeleted();
            }

            ledger.Sync(basis, [], snapshot, now);
        }

        // The same rule the approval applies again to the content it approves (BR-BIL-04, ADR-012).
        var requiresSecondApproval = BillingRun.NeedsSecondApproval(existing.Values, settings.SecondApprovalThreshold);
        return new CollectResult(existing.Values.Count(b => !b.IsDeleted), totalLines, decimal.Round(total, 2), withAnomalies, requiresSecondApproval, conflicts);
    }

    /// <summary>
    /// One-time items from accepted quotes (BR-SAL-07), completed project phases and Finance's corrections; they carry their id
    /// so the export can close them, and a correction refers to the exported line it adds to (ADR-013).
    /// </summary>
    private static void AddPendingChargeLines(List<LineDraft> lines, IReadOnlyList<PendingCharge> charges)
    {
        foreach (var charge in charges)
        {
            var key = ChargeLedger.PendingKey(charge.Id);
            lines.Add(new LineDraft(
                BillingGroup.OneOff,
                charge.ProductId,
                charge.Description,
                charge.Quantity,
                charge.UnitPrice,
                charge.DiscountPct,
                charge.VatRate,
                JsonSerializer.Serialize(new { pendingChargeIds = new[] { charge.Id } }),
                key,
                Claims: [new ChargeClaim(
                    key, ChargeKind.OneOff, BillingLine.Amount(charge.Quantity, charge.UnitPrice, charge.DiscountPct),
                    CorrectsLineId: charge.SourceType == PendingCharge.CorrectionSource ? charge.SourceId : null)]));
        }
    }

    /// <summary>The latest finished run of the work-hours import, or null when no source answers or it never ran (nothing to judge).</summary>
    private async Task<SyncCompleteness?> LatestHoursRunAsync(BillingOptions settings, CancellationToken ct)
    {
        foreach (var source in syncCompleteness)
        {
            if (await source.LatestAsync(settings.HoursSyncSystem, settings.HoursSyncJob, ct) is { } latest)
            {
                return latest;
            }
        }

        return null;
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
                        ChargeLedger.TimeKey(entry.AllocationId),
                        Claims: [TimeClaim(entry, rate)]));
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
                    string.Create(CultureInfo.InvariantCulture, $"time:{group.Key.Key}:{rate:0.####}"),
                    Claims: group.Select(e => TimeClaim(e, rate)).ToList()));
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
                JsonSerializer.Serialize(new { timeEntryIds = group.Select(e => e.EntryId).Distinct().ToList(), allocationIds = group.Select(e => e.AllocationId).ToList() }),
                $"info:{group.Key}",
                Claims: group.Select(e => new ChargeClaim(ChargeLedger.TimeKey(e.AllocationId), ChargeKind.TimeInfo, 0m, ServiceFrom: e.WorkDate, ServiceTo: e.WorkDate)).ToList()));
        }
    }

    private static ChargeClaim TimeClaim(BillableTime entry, decimal rate) =>
        new(ChargeLedger.TimeKey(entry.AllocationId), ChargeKind.Time, BillingLine.Amount(entry.BilledHours, rate, 0), ServiceFrom: entry.WorkDate, ServiceTo: entry.WorkDate);

    /// <summary>
    /// An obligation another open run reserved is billed there; the basis says so. Obligations that are already billed are
    /// left out without a word — that is what a supplementary run is for.
    /// </summary>
    private static void ReportHeldElsewhere(List<BillingAnomaly> anomalies, IEnumerable<Charge> held, ChargeSnapshot snapshot, Func<Charge, string> what)
    {
        if (held.FirstOrDefault(c => c.Status == ChargeStatus.Reserved) is { } reserved)
        {
            anomalies.Add(new BillingAnomaly(
                "BIL_CHARGE_RESERVED_ELSEWHERE",
                $"{what(reserved)}: on a basis of the open run for {snapshot.PeriodOf(reserved):yyyy-MM}, billed there."));
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
                ChargeLedger.HourBankKey(purchase.EntryId),
                Claims: [new ChargeClaim(ChargeLedger.HourBankKey(purchase.EntryId), ChargeKind.HourBankPurchase, BillingLine.Amount(purchase.Hours, unitPrice, line.DiscountPct), ServiceFrom: purchase.Date, ServiceTo: purchase.Date)]));
        }
    }

    private static void AddPortfolioAnomalies(
        List<BillingAnomaly> anomalies,
        BillingBasis basis,
        Guid organizationId,
        BillingReadiness? readiness,
        IReadOnlyDictionary<Guid, ProductRef> products,
        BillingOptions settings,
        IReadOnlySet<Guid>? contracted,
        IReadOnlyList<SubscriptionQuantity>? quantities,
        IReadOnlyList<string>? unmappedOffers)
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
        foreach (var subscription in (quantities ?? []).Where(s => contracted?.Contains(s.ProductId) != true))
        {
            anomalies.Add(new BillingAnomaly(
                "BIL_SUBSCRIPTION_NOT_CONTRACTED", $"{subscription.OfferName ?? subscription.OfferId} ({subscription.Quantity}) is not on any contract line."));
        }

        foreach (var offer in unmappedOffers ?? [])
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

    private async Task<Dictionary<Guid, decimal>> PreviousTotalsAsync(BillingRun run, IReadOnlyCollection<Guid> organizationIds, CancellationToken ct)
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
            .Where(b => b.RunId == previous && organizationIds.Contains(b.OrganizationId))
            .GroupBy(b => b.OrganizationId)
            .Select(g => new { g.Key, Total = g.Sum(b => b.TotalExVat) })
            .ToDictionaryAsync(x => x.Key, x => x.Total, ct);
    }
}
