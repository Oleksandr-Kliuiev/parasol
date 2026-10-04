using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Licensing.Contracts;
using Crm.Licensing.Domain;
using Crm.Licensing.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Licensing.Features;

public sealed record SubscriptionDto(
    Guid Id,
    SubscriptionSource Source,
    string SubscriptionId,
    string? CspCustomerName,
    Guid? OrganizationId,
    string? OrganizationName,
    string OfferId,
    string? OfferName,
    string? Sku,
    int Quantity,
    SubscriptionStatus Status,
    SubscriptionTerm Term,
    SubscriptionBillingCycle BillingCycle,
    DateOnly? StartDate,
    DateOnly? CommitmentEndDate,
    DateOnly? RenewalDate,
    bool AutoRenew,
    DateTimeOffset? CancellationWindowEndsAt,
    bool CancellationWindowOpen,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? PartnerUnitPrice,
    Guid? ProductId,
    string? ProductName,
    bool IsBilled,
    DateTimeOffset SyncedAt);

public sealed record LicensingSummary(
    int Subscriptions,
    int Licenses,
    int RenewingSoon,
    int CancellationWindowOpen,
    int NotBilled,
    int WithoutOrganization);

public sealed record LicensingAttention(LicensingSummary Summary, IReadOnlyList<SubscriptionDto> CancellationWindow, IReadOnlyList<SubscriptionDto> Renewing, IReadOnlyList<SubscriptionDto> NotBilled);

public sealed record SubscriptionQuery(string? Search, Guid? OrganizationId, SubscriptionSource? Source, bool RenewingSoon, bool CancellationWindowOpen, bool NotBilled, bool WithoutOrganization);

internal sealed class LicensingService(
    LicensingDbContext db,
    ICustomersApi customers,
    ICatalogApi catalog,
    IContractsApi contracts,
    ICurrentUser currentUser,
    IRequestContext requestContext,
    TimeProvider time,
    IOptions<LicensingOptions> options) : ILicensingApi
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private DateOnly Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);

    public async Task<SubscriptionImportResult> UpsertAsync(IReadOnlyCollection<ExternalSubscription> subscriptions, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var window = TimeSpan.FromHours(options.Value.CancellationWindowHours);
        int created = 0, updated = 0, unchanged = 0;
        var warnings = new List<string>();

        var products = await catalog.FindProductsByOfferIdAsync(subscriptions.Select(s => s.OfferId).ToList(), cancellationToken);
        var matcher = await customers.CreateMatcherAsync(cancellationToken);
        var knownByCustomer = await db.CspSubscriptions.AsNoTracking()
            .Where(s => s.OrganizationId != null)
            .GroupBy(s => s.CspCustomerId)
            .Select(g => new { g.Key, OrganizationId = g.Min(s => s.OrganizationId) })
            .ToDictionaryAsync(x => x.Key, x => x.OrganizationId!.Value, cancellationToken);

        foreach (var group in subscriptions.GroupBy(s => s.Source))
        {
            var ids = group.Select(s => s.SubscriptionId).Distinct().ToList();
            var existing = await db.CspSubscriptions
                .Where(s => s.Source == group.Key && ids.Contains(s.SubscriptionId))
                .ToDictionaryAsync(s => s.SubscriptionId, StringComparer.Ordinal, cancellationToken);

            foreach (var incoming in group.DistinctBy(s => s.SubscriptionId, StringComparer.Ordinal))
            {
                CspSubscription subscription;
                if (existing.TryGetValue(incoming.SubscriptionId, out var found))
                {
                    subscription = found;
                    if (subscription.Apply(incoming, now, window))
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
                    subscription = CspSubscription.From(incoming, window, now);
                    db.CspSubscriptions.Add(subscription);
                    created++;
                }

                // BR-LIC-01: a mapped CSP customer wins, then the organization another subscription of the same customer uses, then a match.
                if (incoming.OrganizationId is { } mapped)
                {
                    subscription.LinkOrganization(mapped);
                    knownByCustomer[incoming.CspCustomerId] = mapped;
                }
                else if (subscription.OrganizationId is null)
                {
                    if (knownByCustomer.TryGetValue(incoming.CspCustomerId, out var organizationId))
                    {
                        subscription.LinkOrganization(organizationId);
                    }
                    else
                    {
                        var data = new ExternalOrganizationData(incoming.CspCustomerName ?? incoming.CspCustomerId, incoming.OrganizationNumber, null, null, null, [], null, null, null);
                        var matches = matcher.Match(data);
                        if (matches.FirstOrDefault(m => m.IsExact) is { } exact)
                        {
                            subscription.LinkOrganization(exact.OrganizationId);
                            knownByCustomer[incoming.CspCustomerId] = exact.OrganizationId;
                        }
                        else if (matches.Count > 0)
                        {
                            warnings.Add($"{incoming.CspCustomerName ?? incoming.CspCustomerId}: several possible organizations, link it by hand.");
                        }
                    }
                }

                subscription.LinkProduct(products.TryGetValue(incoming.OfferId, out var product) ? product.Id : null);
            }
        }

        await db.SaveChangesAsync(cancellationToken);
        var withoutOrganization = await db.CspSubscriptions.CountAsync(s => s.OrganizationId == null && s.Status != SubscriptionStatus.Deleted, cancellationToken);
        return new SubscriptionImportResult(created, updated, unchanged, withoutOrganization, warnings.Distinct().Take(20).ToList());
    }

    public async Task<IReadOnlyList<SubscriptionDto>> ListAsync(SubscriptionQuery query, CancellationToken ct)
    {
        var subscriptions = db.CspSubscriptions.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var term = query.Search.Trim();
            subscriptions = subscriptions.Where(s =>
                (s.OfferName != null && s.OfferName.Contains(term)) || s.OfferId.Contains(term) ||
                (s.CspCustomerName != null && s.CspCustomerName.Contains(term)) || s.SubscriptionId == term);
        }

        if (query.OrganizationId is { } organizationId)
        {
            subscriptions = subscriptions.Where(s => s.OrganizationId == organizationId);
        }

        if (query.Source is { } source)
        {
            subscriptions = subscriptions.Where(s => s.Source == source);
        }

        if (query.WithoutOrganization)
        {
            subscriptions = subscriptions.Where(s => s.OrganizationId == null);
        }

        if (query.CancellationWindowOpen)
        {
            var now = time.GetUtcNow();
            subscriptions = subscriptions.Where(s => s.CancellationWindowEndsAt > now);
        }

        if (query.RenewingSoon)
        {
            var until = Today.AddDays(options.Value.RenewalNoticeDays);
            subscriptions = subscriptions.Where(s => (s.RenewalDate ?? s.CommitmentEndDate) >= Today && (s.RenewalDate ?? s.CommitmentEndDate) <= until);
        }

        var rows = await subscriptions.OrderBy(s => s.CspCustomerName).ThenBy(s => s.OfferName).Take(1000).ToListAsync(ct);
        var dtos = await ToDtosAsync(rows, ct);
        return query.NotBilled ? dtos.Where(d => !d.IsBilled).ToList() : dtos;
    }

    public async Task<LicensingAttention> GetAttentionAsync(CancellationToken ct)
    {
        var rows = await db.CspSubscriptions.AsNoTracking().Where(s => s.Status != SubscriptionStatus.Deleted).Take(2000).ToListAsync(ct);
        var dtos = await ToDtosAsync(rows, ct);
        var summary = new LicensingSummary(
            dtos.Count,
            dtos.Where(d => d.Status == SubscriptionStatus.Active).Sum(d => d.Quantity),
            dtos.Count(d => d.RenewalDate is not null && d.RenewalDate >= Today && d.RenewalDate.Value.DayNumber - Today.DayNumber <= options.Value.RenewalNoticeDays),
            dtos.Count(d => d.CancellationWindowOpen),
            dtos.Count(d => !d.IsBilled),
            dtos.Count(d => d.OrganizationId is null));
        return new LicensingAttention(
            summary,
            dtos.Where(d => d.CancellationWindowOpen).OrderBy(d => d.CancellationWindowEndsAt).Take(20).ToList(),
            dtos.Where(d => d.RenewalDate is not null && d.RenewalDate >= Today && d.RenewalDate.Value.DayNumber - Today.DayNumber <= options.Value.RenewalNoticeDays)
                .OrderBy(d => d.RenewalDate).Take(20).ToList(),
            dtos.Where(d => !d.IsBilled).OrderBy(d => d.OrganizationName).Take(20).ToList());
    }

    public async Task<IReadOnlyList<SubscriptionAttention>> GetAttentionAsync(DateOnly today, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var rows = await db.CspSubscriptions.AsNoTracking()
            .Where(s => s.Status == SubscriptionStatus.Active)
            .Take(2000)
            .ToListAsync(ct);

        var attention = new List<SubscriptionAttention>();
        foreach (var subscription in rows)
        {
            var name = subscription.OfferName ?? subscription.OfferId;
            if (subscription.IsCancellationWindowOpen(now))
            {
                attention.Add(new SubscriptionAttention(
                    subscription.Id, SubscriptionAttentionKind.CancellationWindow, subscription.OrganizationId, name, subscription.Quantity,
                    null, subscription.CancellationWindowEndsAt));
            }

            if (subscription.IsRenewingWithin(today, options.Value.RenewalNoticeDays))
            {
                attention.Add(new SubscriptionAttention(
                    subscription.Id, SubscriptionAttentionKind.Renewal, subscription.OrganizationId, name, subscription.Quantity,
                    subscription.RenewalDate ?? subscription.CommitmentEndDate, null));
            }
        }

        return attention;
    }

    /// <summary>FR-LIC-03: today's "bought / assigned" reading per SKU; reading the same day again replaces it.</summary>
    public async Task<int> UpsertLicenseUsageAsync(IReadOnlyCollection<LicenseUsageReading> readings, DateOnly date, CancellationToken cancellationToken)
    {
        if (readings.Count == 0)
        {
            return 0;
        }

        var now = time.GetUtcNow();
        var organizationIds = readings.Select(r => r.OrganizationId).Distinct().ToList();
        var existing = await db.LicenseSnapshots
            .Where(s => s.SnapshotDate == date && organizationIds.Contains(s.OrganizationId))
            .ToListAsync(cancellationToken);

        var changed = 0;
        foreach (var reading in readings.DistinctBy(r => (r.OrganizationId, r.SkuId)))
        {
            var snapshot = existing.Find(s => s.OrganizationId == reading.OrganizationId && s.SkuId == reading.SkuId);
            if (snapshot is null)
            {
                db.LicenseSnapshots.Add(LicenseSnapshot.Create(reading, date, now));
            }
            else
            {
                snapshot.Update(reading, now);
            }

            changed++;
        }

        await db.SaveChangesAsync(cancellationToken);
        return changed;
    }

    /// <summary>
    /// BR-CON-02: assigned licences per organization and catalog product, from the newest reading on or before the date.
    /// A product is found by its Microsoft identifier, which may be the SKU part number or the SKU id.
    /// </summary>
    public async Task<IReadOnlyList<AssignedLicenses>> GetAssignedLicensesAsync(DateOnly date, CancellationToken cancellationToken)
    {
        // Readings are daily; a fortnight back survives a weekend of failed syncs without going stale silently.
        var from = date.AddDays(-14);
        var snapshots = await db.LicenseSnapshots.AsNoTracking()
            .Where(s => s.SnapshotDate <= date && s.SnapshotDate >= from)
            .ToListAsync(cancellationToken);
        if (snapshots.Count == 0)
        {
            return [];
        }

        var keys = snapshots.SelectMany(s => new[] { s.SkuPartNumber, s.SkuId })
            .Where(k => k.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var products = await catalog.FindProductsByOfferIdAsync(keys, cancellationToken);
        var result = new List<AssignedLicenses>();
        foreach (var group in snapshots.GroupBy(s => new { s.OrganizationId, s.SkuId }))
        {
            var latest = group.MaxBy(s => s.SnapshotDate)!;
            if (!products.TryGetValue(latest.SkuPartNumber, out var product) && !products.TryGetValue(latest.SkuId, out product))
            {
                continue;
            }

            result.Add(new AssignedLicenses(
                latest.OrganizationId, product.Id, latest.SkuPartNumber, latest.Assigned, latest.Purchased, latest.SnapshotDate));
        }

        return result;
    }

    public async Task<IReadOnlyList<MsCostByOrganization>> GetMsCostsAsync(
        DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken)
    {
        var lines = await db.MsBilledLines.AsNoTracking()
            .Where(l => l.OrganizationId != null && l.PeriodStart <= periodEnd && l.PeriodEnd >= periodStart)
            .Select(l => new { OrganizationId = l.OrganizationId!.Value, l.Total, l.Currency })
            .ToListAsync(cancellationToken);

        return lines
            .GroupBy(l => l.OrganizationId)
            .Select(g => new MsCostByOrganization(
                g.Key, decimal.Round(g.Sum(l => l.Total), 2), g.Select(l => l.Currency).FirstOrDefault() ?? "NOK", g.Count()))
            .ToList();
    }

    /// <summary>FR-LIC-04: stores Microsoft's cost lines, linking each to the organization behind the subscription.</summary>
    public async Task<MsBillingImportResult> ImportBilledLinesAsync(
        IReadOnlyCollection<ExternalBilledLine> lines, bool dryRun, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var warnings = new List<string>();
        int created = 0, updated = 0, unchanged = 0, withoutOrganization = 0;

        var subscriptionIds = lines.Select(l => l.SubscriptionId).OfType<string>().Distinct().ToList();
        var customerIds = lines.Select(l => l.CspCustomerId).Distinct().ToList();
        var bySubscription = await db.CspSubscriptions.AsNoTracking()
            .Where(s => s.OrganizationId != null && subscriptionIds.Contains(s.SubscriptionId))
            .GroupBy(s => s.SubscriptionId)
            .Select(g => new { g.Key, OrganizationId = g.Min(s => s.OrganizationId) })
            .ToDictionaryAsync(x => x.Key, x => x.OrganizationId!.Value, StringComparer.Ordinal, cancellationToken);
        var byCustomer = await db.CspSubscriptions.AsNoTracking()
            .Where(s => s.OrganizationId != null && customerIds.Contains(s.CspCustomerId))
            .GroupBy(s => s.CspCustomerId)
            .Select(g => new { g.Key, OrganizationId = g.Min(s => s.OrganizationId) })
            .ToDictionaryAsync(x => x.Key, x => x.OrganizationId!.Value, StringComparer.Ordinal, cancellationToken);

        var keys = lines.Select(MsBilledLine.KeyOf).Distinct(StringComparer.Ordinal).ToList();
        var existing = await db.MsBilledLines
            .Where(l => keys.Contains(l.LineKey))
            .ToDictionaryAsync(l => l.LineKey, StringComparer.Ordinal, cancellationToken);

        foreach (var line in lines.DistinctBy(MsBilledLine.KeyOf, StringComparer.Ordinal))
        {
            Guid? organizationId = line.SubscriptionId is { } subscriptionId && bySubscription.TryGetValue(subscriptionId, out var fromSubscription)
                ? fromSubscription
                : byCustomer.TryGetValue(line.CspCustomerId, out var fromCustomer) ? fromCustomer : null;
            if (organizationId is null)
            {
                withoutOrganization++;
                if (warnings.Count < 10)
                {
                    warnings.Add($"{line.CspCustomerName ?? line.CspCustomerId}: no CRM customer is linked to this CSP customer.");
                }
            }

            var key = MsBilledLine.KeyOf(line);
            if (existing.TryGetValue(key, out var stored))
            {
                if (stored.Total == decimal.Round(line.Total, 2) && stored.Quantity == decimal.Round(line.Quantity, 2)
                    && stored.OrganizationId == organizationId)
                {
                    unchanged++;
                    continue;
                }

                updated++;
                if (!dryRun)
                {
                    stored.Apply(line, organizationId, now);
                }
            }
            else
            {
                created++;
                if (!dryRun)
                {
                    db.MsBilledLines.Add(MsBilledLine.Create(line, organizationId, now));
                }
            }
        }

        if (!dryRun && (created > 0 || updated > 0))
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        return new MsBillingImportResult(created, updated, unchanged, withoutOrganization, warnings);
    }

    public async Task<LicenseSummary> GetSummaryAsync(DateOnly today, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var rows = await db.CspSubscriptions.AsNoTracking().Where(s => s.Status != SubscriptionStatus.Deleted).Take(5000).ToListAsync(ct);
        var contracted = new Dictionary<Guid, IReadOnlySet<Guid>>();
        foreach (var organizationId in rows.Where(s => s.OrganizationId is not null).Select(s => s.OrganizationId!.Value).Distinct())
        {
            contracted[organizationId] = await contracts.GetContractedProductsAsync(organizationId, today, ct);
        }

        bool IsBilled(Domain.CspSubscription s) =>
            s.OrganizationId is { } org && s.ProductId is { } product && contracted.GetValueOrDefault(org)?.Contains(product) == true;

        return new LicenseSummary(
            rows.Count,
            rows.Where(s => s.Status == SubscriptionStatus.Active).Sum(s => s.Quantity),
            rows.Count(s => s.IsCancellationWindowOpen(now)),
            rows.Count(s => s.IsRenewingWithin(today, options.Value.RenewalNoticeDays)),
            rows.Count(s => !IsBilled(s)),
            rows.Count(s => s.OrganizationId is null));
    }

    public async Task<Result<SubscriptionImportResult>> ImportAsync(string csv, bool dryRun, CancellationToken ct)
    {
        var parsed = SubscriptionCsv.Parse(csv);
        if (parsed.Errors.Count > 0 && parsed.Subscriptions.Count == 0)
        {
            return Error.Validation("LIC_IMPORT_INVALID", string.Join(" ", parsed.Errors.Take(5)),
                new Dictionary<string, object?> { ["errors"] = parsed.Errors, ["unknownColumns"] = parsed.UnknownColumns });
        }

        if (dryRun)
        {
            // The preview answers "what would change", so the rows are applied to detached copies and counted the same way
            // the real import counts them; nothing is tracked and nothing is saved.
            var ids = parsed.Subscriptions.Select(s => s.SubscriptionId).Distinct(StringComparer.Ordinal).ToList();
            var existing = await db.CspSubscriptions.AsNoTracking()
                .Where(s => s.Source == SubscriptionSource.Distributor && ids.Contains(s.SubscriptionId))
                .ToDictionaryAsync(s => s.SubscriptionId, StringComparer.Ordinal, ct);
            var previewWindow = TimeSpan.FromHours(options.Value.CancellationWindowHours);
            var previewNow = time.GetUtcNow();
            int wouldCreate = 0, wouldUpdate = 0, wouldStay = 0;
            foreach (var incoming in parsed.Subscriptions.DistinctBy(s => s.SubscriptionId, StringComparer.Ordinal))
            {
                if (!existing.TryGetValue(incoming.SubscriptionId, out var found))
                {
                    wouldCreate++;
                }
                else if (found.Apply(incoming, previewNow, previewWindow))
                {
                    wouldUpdate++;
                }
                else
                {
                    wouldStay++;
                }
            }

            return new SubscriptionImportResult(
                wouldCreate,
                wouldUpdate,
                wouldStay,
                0,
                parsed.Errors.Concat(parsed.UnknownColumns.Select(c => $"Column '{c}' was ignored.")).Take(20).ToList());
        }

        var result = await UpsertAsync(parsed.Subscriptions, ct);
        db.RecordAudit(currentUser, requestContext, time, "Import", "CspSubscription", Guid.Empty, new
        {
            Source = nameof(SubscriptionSource.Distributor),
            Rows = parsed.Subscriptions.Count,
            result.Created,
            result.Updated,
        });
        await db.SaveChangesAsync(ct);
        return result with { Warnings = result.Warnings.Concat(parsed.Errors).Take(20).ToList() };
    }

    /// <summary>The distributor's invoice file (FR-LIC-04); ?dryRun=true counts the same way the real import does.</summary>
    public async Task<Result<MsBillingImportResult>> ImportBilledCsvAsync(string csv, bool dryRun, CancellationToken ct)
    {
        // A file without period columns is read as the month that just ended, which is what a distributor invoice covers.
        var lastMonth = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime).AddMonths(-1);
        var parsed = MsBillingCsv.Parse(csv, new DateOnly(lastMonth.Year, lastMonth.Month, 1));
        if (parsed.Lines.Count == 0)
        {
            return Error.Validation("LIC_MSBILLING_INVALID", string.Join(" ", parsed.Errors.Take(5).DefaultIfEmpty("The file has no lines.")),
                new Dictionary<string, object?> { ["errors"] = parsed.Errors, ["unknownColumns"] = parsed.UnknownColumns });
        }

        var result = await ImportBilledLinesAsync(parsed.Lines, dryRun, ct);
        if (!dryRun)
        {
            db.RecordAudit(currentUser, requestContext, time, "Import", "MsBilledLine", Guid.Empty, new
            {
                Source = nameof(MsBillingSource.Csv),
                Rows = parsed.Lines.Count,
                result.Created,
                result.Updated,
            });
            await db.SaveChangesAsync(ct);
        }

        return result with
        {
            Warnings = result.Warnings
                .Concat(parsed.Errors)
                .Concat(parsed.UnknownColumns.Select(c => $"Column '{c}' was ignored."))
                .Take(20)
                .ToList(),
        };
    }

    public async Task<IReadOnlyList<SubscriptionQuantity>> GetSubscriptionQuantitiesAsync(DateOnly date, CancellationToken ct)
    {
        var rows = await db.CspSubscriptions.AsNoTracking()
            .Where(s => s.OrganizationId != null && s.ProductId != null && s.Status == SubscriptionStatus.Active &&
                        (s.StartDate == null || s.StartDate <= date) &&
                        (s.CommitmentEndDate == null || s.CommitmentEndDate >= date))
            .Select(s => new { OrganizationId = s.OrganizationId!.Value, ProductId = s.ProductId!.Value, s.OfferId, s.OfferName, s.Quantity, s.SubscriptionId })
            .ToListAsync(ct);

        return rows
            .GroupBy(s => new { s.OrganizationId, s.ProductId })
            .Select(g => new SubscriptionQuantity(
                g.Key.OrganizationId,
                g.Key.ProductId,
                g.First().OfferId,
                g.First().OfferName,
                g.Sum(s => s.Quantity),
                g.Select(s => s.SubscriptionId).Order(StringComparer.Ordinal).ToList()))
            .ToList();
    }

    public async Task<IReadOnlyList<string>> GetUnmappedOfferNamesAsync(Guid organizationId, DateOnly date, CancellationToken ct) =>
        await db.CspSubscriptions.AsNoTracking()
            .Where(s => s.OrganizationId == organizationId && s.ProductId == null && s.Status == SubscriptionStatus.Active &&
                        (s.CommitmentEndDate == null || s.CommitmentEndDate >= date))
            .Select(s => s.OfferName ?? s.OfferId)
            .Distinct()
            .Take(20)
            .ToListAsync(ct);

    private async Task<IReadOnlyList<SubscriptionDto>> ToDtosAsync(IReadOnlyList<CspSubscription> subscriptions, CancellationToken ct)
    {
        var organizationIds = subscriptions.Where(s => s.OrganizationId != null).Select(s => s.OrganizationId!.Value).Distinct().ToList();
        var organizations = await customers.GetOrganizationNamesAsync(organizationIds, ct);
        var productIds = subscriptions.Where(s => s.ProductId != null).Select(s => s.ProductId!.Value).Distinct().ToList();
        var products = await catalog.GetProductsAsync(productIds, ct);
        var now = time.GetUtcNow();
        var today = Today;

        // BR-LIC-03: a subscription is only billed when its product is on a live contract line of that organization.
        var contracted = new Dictionary<Guid, IReadOnlySet<Guid>>();
        foreach (var organizationId in organizationIds)
        {
            contracted[organizationId] = await contracts.GetContractedProductsAsync(organizationId, today, ct);
        }

        return subscriptions.Select(s => new SubscriptionDto(
            s.Id, s.Source, s.SubscriptionId, s.CspCustomerName, s.OrganizationId,
            s.OrganizationId is { } orgId ? organizations.GetValueOrDefault(orgId) : null,
            s.OfferId, s.OfferName, s.Sku, s.Quantity, s.Status, s.Term, s.BillingCycle, s.StartDate, s.CommitmentEndDate, s.RenewalDate, s.AutoRenew,
            s.CancellationWindowEndsAt, s.IsCancellationWindowOpen(now), s.PartnerUnitPrice, s.ProductId,
            s.ProductId is { } productId && products.TryGetValue(productId, out var product) ? product.Name : null,
            s.OrganizationId is { } billedOrg && s.ProductId is { } billedProduct && contracted.GetValueOrDefault(billedOrg)?.Contains(billedProduct) == true,
            s.SyncedAt)).ToList();
    }
}

/// <summary>Subscriptions follow their organization into a merge.</summary>
internal sealed class LicensingMergeHandler(LicensingDbContext db, ICustomersApi customers) : IDomainEventHandler<OrganizationsMerged>
{
    public async Task HandleAsync(OrganizationsMerged domainEvent, CancellationToken cancellationToken)
    {
        // Delivered late (retried or replayed) after the merge was undone: the organizations are apart again (DEV-07).
        if (await customers.IsMergeUndoneAsync(domainEvent.MergeId, cancellationToken))
        {
            return;
        }

        await db.CspSubscriptions.Where(s => s.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
    }
}
