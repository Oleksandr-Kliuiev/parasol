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
using Crm.SharedKernel.Text;
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

public sealed record SubscriptionQuery(
    string? Search, Guid? OrganizationId, SubscriptionSource? Source, bool RenewingSoon, bool CancellationWindowOpen, bool NotBilled, bool WithoutOrganization,
    int? Limit = null, string? Cursor = null);

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
        return new SubscriptionImportResult(created, updated, unchanged, withoutOrganization, WarningList.Capped(warnings.Distinct()));
    }

    /// <summary>
    /// One page of subscriptions by customer and offer name, and how many the filter matches (DEV-12). "Not billed" depends on the
    /// customers' contracts, which live in another module: it is decided for every matching subscription before the page is cut.
    /// </summary>
    public async Task<PagedResult<SubscriptionDto>> ListAsync(SubscriptionQuery query, CancellationToken ct)
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

        var limit = KeysetCursor.ClampLimit(query.Limit);
        var cursor = KeysetCursor.Decode(query.Cursor);
        if (query.NotBilled)
        {
            return await NotBilledPageAsync(subscriptions, cursor, limit, ct);
        }

        var total = await subscriptions.CountAsync(ct);
        if (cursor is not null)
        {
            var then = cursor.Then ?? string.Empty;
            subscriptions = subscriptions.Where(s =>
                (s.CspCustomerName ?? "").CompareTo(cursor.SortKey) > 0 ||
                ((s.CspCustomerName ?? "") == cursor.SortKey && ((s.OfferName ?? s.OfferId).CompareTo(then) > 0 ||
                                                               ((s.OfferName ?? s.OfferId) == then && s.Id.CompareTo(cursor.Id) > 0))));
        }

        var page = await subscriptions.OrderBy(s => s.CspCustomerName ?? "").ThenBy(s => s.OfferName ?? s.OfferId).ThenBy(s => s.Id)
            .Take(limit + 1).ToListAsync(ct);
        var rows = page.Take(limit).ToList();
        var last = rows.LastOrDefault();
        return new PagedResult<SubscriptionDto>(
            await ToDtosAsync(rows, ct),
            page.Count > limit && last is not null ? new KeysetCursor(last.CspCustomerName ?? "", last.Id, last.OfferName ?? last.OfferId).Encode() : null,
            total);
    }

    /// <summary>The not-billed filter: decided for every matching subscription from one contract query, then paged in the same order.</summary>
    private async Task<PagedResult<SubscriptionDto>> NotBilledPageAsync(IQueryable<CspSubscription> subscriptions, KeysetCursor? cursor, int limit, CancellationToken ct)
    {
        var candidates = await subscriptions
            .Select(s => new { s.Id, s.OrganizationId, s.ProductId, Customer = s.CspCustomerName ?? "", Offer = s.OfferName ?? s.OfferId })
            .ToListAsync(ct);
        var contracted = await contracts.GetContractedProductsAsync(
            candidates.Where(c => c.OrganizationId != null).Select(c => c.OrganizationId!.Value).Distinct().ToList(), Today, ct);
        var notBilled = candidates
            .Where(c => !(c.OrganizationId is { } org && c.ProductId is { } product && contracted.TryGetValue(org, out var set) && set.Contains(product)))
            .OrderBy(c => c.Customer, StringComparer.OrdinalIgnoreCase).ThenBy(c => c.Offer, StringComparer.OrdinalIgnoreCase).ThenBy(c => c.Id)
            .ToList();
        // Keyset in memory, with the comparer of the sort: a row that changed meanwhile neither restarts nor repeats the pages.
        var start = cursor is null
            ? 0
            : notBilled.FindIndex(c => CompareKeys(c.Customer, c.Offer, c.Id, cursor.SortKey, cursor.Then ?? string.Empty, cursor.Id) > 0);
        if (start < 0)
        {
            start = notBilled.Count;
        }

        var page = notBilled.Skip(start).Take(limit + 1).ToList();
        var ids = page.Take(limit).Select(c => c.Id).ToList();
        var rows = await db.CspSubscriptions.AsNoTracking().Where(s => ids.Contains(s.Id)).ToListAsync(ct);
        var dtos = (await ToDtosAsync(rows, ct)).ToDictionary(d => d.Id);
        var last = page.Count > limit ? page[limit - 1] : null;
        return new PagedResult<SubscriptionDto>(
            ids.Where(dtos.ContainsKey).Select(id => dtos[id]).ToList(),
            last is not null ? new KeysetCursor(last.Customer, last.Id, last.Offer).Encode() : null,
            notBilled.Count);
    }

    private static int CompareKeys(string customer, string offer, Guid id, string otherCustomer, string otherOffer, Guid otherId)
    {
        var byCustomer = StringComparer.OrdinalIgnoreCase.Compare(customer, otherCustomer);
        if (byCustomer != 0)
        {
            return byCustomer;
        }

        var byOffer = StringComparer.OrdinalIgnoreCase.Compare(offer, otherOffer);
        return byOffer != 0 ? byOffer : id.CompareTo(otherId);
    }

    /// <summary>What every licensing summary counts, for every subscription that is not deleted — never a subset (DEV-12).</summary>
    private sealed record SubscriptionFacts(
        Guid Id, Guid? OrganizationId, Guid? ProductId, SubscriptionStatus Status, int Quantity, DateTimeOffset? CancellationWindowEndsAt,
        DateOnly? RenewalDate, DateOnly? CommitmentEndDate, bool IsBilled);

    private async Task<List<SubscriptionFacts>> FactsAsync(DateOnly today, CancellationToken ct)
    {
        var rows = await db.CspSubscriptions.AsNoTracking().Where(s => s.Status != SubscriptionStatus.Deleted)
            .Select(s => new { s.Id, s.OrganizationId, s.ProductId, s.Status, s.Quantity, s.CancellationWindowEndsAt, s.RenewalDate, s.CommitmentEndDate })
            .ToListAsync(ct);
        // BR-LIC-03: billed only when the product is on a live contract line of that organization — asked once for all of them.
        var contracted = await contracts.GetContractedProductsAsync(
            rows.Where(r => r.OrganizationId != null).Select(r => r.OrganizationId!.Value).Distinct().ToList(), today, ct);
        return rows.ConvertAll(r => new SubscriptionFacts(
            r.Id, r.OrganizationId, r.ProductId, r.Status, r.Quantity, r.CancellationWindowEndsAt, r.RenewalDate, r.CommitmentEndDate,
            r.OrganizationId is { } org && r.ProductId is { } product && contracted.TryGetValue(org, out var set) && set.Contains(product)));
    }

    /// <summary>
    /// The licensing screen's tiles and its three short lists (DEV-12): the counts cover every subscription, with the definitions the
    /// dashboard uses; each list holds the first twenty of its kind, which the screen labels as such.
    /// </summary>
    public async Task<LicensingAttention> GetAttentionAsync(CancellationToken ct)
    {
        var today = Today;
        var now = time.GetUtcNow();
        var days = options.Value.RenewalNoticeDays;
        var facts = await FactsAsync(today, ct);
        var window = facts.Where(f => CspSubscription.IsCancellationWindowOpen(f.CancellationWindowEndsAt, now)).ToList();
        var renewing = facts.Where(f => CspSubscription.IsRenewingWithin(f.RenewalDate, f.CommitmentEndDate, today, days)).ToList();
        var notBilled = facts.Where(f => !f.IsBilled).ToList();
        var summary = new LicensingSummary(
            facts.Count,
            facts.Where(f => f.Status == SubscriptionStatus.Active).Sum(f => f.Quantity),
            renewing.Count,
            window.Count,
            notBilled.Count,
            facts.Count(f => f.OrganizationId is null));

        var names = await customers.GetOrganizationNamesAsync(notBilled.Where(f => f.OrganizationId != null).Select(f => f.OrganizationId!.Value).Distinct().ToList(), ct);
        var windowIds = window.OrderBy(f => f.CancellationWindowEndsAt).ThenBy(f => f.Id).Take(20).Select(f => f.Id).ToList();
        var renewingIds = renewing.OrderBy(f => f.RenewalDate ?? f.CommitmentEndDate).ThenBy(f => f.Id).Take(20).Select(f => f.Id).ToList();
        var notBilledIds = notBilled
            .OrderBy(f => f.OrganizationId is { } org ? names.GetValueOrDefault(org) : null, StringComparer.CurrentCultureIgnoreCase).ThenBy(f => f.Id)
            .Take(20).Select(f => f.Id).ToList();
        var shown = windowIds.Concat(renewingIds).Concat(notBilledIds).Distinct().ToList();
        var rows = await db.CspSubscriptions.AsNoTracking().Where(s => shown.Contains(s.Id)).ToListAsync(ct);
        var dtos = (await ToDtosAsync(rows, ct)).ToDictionary(d => d.Id);
        List<SubscriptionDto> Of(List<Guid> ids) => ids.Where(dtos.ContainsKey).Select(id => dtos[id]).ToList();
        return new LicensingAttention(summary, Of(windowIds), Of(renewingIds), Of(notBilledIds));
    }

    /// <summary>
    /// Every active subscription whose cancellation window is open or that renews soon (DEV-12): the database picks them, so none is
    /// missed because it fell outside an arbitrary first few thousand rows.
    /// </summary>
    public async Task<IReadOnlyList<SubscriptionAttention>> GetAttentionAsync(DateOnly today, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var until = today.AddDays(options.Value.RenewalNoticeDays);
        var rows = await db.CspSubscriptions.AsNoTracking()
            .Where(s => s.Status == SubscriptionStatus.Active &&
                        (s.CancellationWindowEndsAt > now ||
                         ((s.RenewalDate ?? s.CommitmentEndDate) >= today && (s.RenewalDate ?? s.CommitmentEndDate) <= until)))
            .OrderBy(s => s.Id)
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
    public Task<IReadOnlyList<AssignedLicenses>> GetAssignedLicensesAsync(DateOnly date, CancellationToken cancellationToken) =>
        AssignedLicensesAsync(null, date, cancellationToken);

    public Task<IReadOnlyList<AssignedLicenses>> GetAssignedLicensesAsync(IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken) =>
        AssignedLicensesAsync(organizationIds, date, cancellationToken);

    private async Task<IReadOnlyList<AssignedLicenses>> AssignedLicensesAsync(IReadOnlyCollection<Guid>? organizationIds, DateOnly date, CancellationToken cancellationToken)
    {
        if (organizationIds is { Count: 0 }) return [];
        // Readings are daily; a fortnight back survives a weekend of failed syncs without going stale silently.
        var from = date.AddDays(-14);
        var query = db.LicenseSnapshots.AsNoTracking().Where(s => s.SnapshotDate <= date && s.SnapshotDate >= from);
        if (organizationIds is not null) query = query.Where(s => organizationIds.Contains(s.OrganizationId));
        var snapshots = await query.GroupBy(s => new { s.OrganizationId, s.SkuId })
            .Select(g => g.OrderByDescending(s => s.SnapshotDate).First()).ToListAsync(cancellationToken);
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
        foreach (var latest in snapshots)
        {
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
        var totals = await db.MsBilledLines.AsNoTracking()
            .Where(l => l.OrganizationId != null && l.PeriodStart <= periodEnd && l.PeriodEnd >= periodStart)
            .GroupBy(l => l.OrganizationId!.Value)
            .Select(g => new
            {
                OrganizationId = g.Key,
                Total = g.Sum(l => l.Total),
                Lines = g.Count(),
                // Keep the existing representative-currency contract; no new currency split or conversion.
                Currency = g.Select(l => l.Currency).FirstOrDefault(),
            })
            .ToListAsync(cancellationToken);

        return totals
            .Select(g => new MsCostByOrganization(g.OrganizationId, decimal.Round(g.Total, 2), g.Currency ?? "NOK", g.Lines))
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

    /// <summary>The dashboard's licence tiles, counted over every subscription with the licensing screen's definitions (DEV-12).</summary>
    public async Task<LicenseSummary> GetSummaryAsync(DateOnly today, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var facts = await FactsAsync(today, ct);
        return new LicenseSummary(
            facts.Count,
            facts.Where(f => f.Status == SubscriptionStatus.Active).Sum(f => f.Quantity),
            facts.Count(f => CspSubscription.IsCancellationWindowOpen(f.CancellationWindowEndsAt, now)),
            facts.Count(f => CspSubscription.IsRenewingWithin(f.RenewalDate, f.CommitmentEndDate, today, options.Value.RenewalNoticeDays)),
            facts.Count(f => !f.IsBilled),
            facts.Count(f => f.OrganizationId is null));
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
                WarningList.Capped(parsed.Errors.Concat(parsed.UnknownColumns.Select(c => $"Column '{c}' was ignored."))));
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
        return result with { Warnings = WarningList.Capped(result.Warnings.Concat(parsed.Errors)) };
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
            Warnings = WarningList.Capped(result.Warnings
                .Concat(parsed.Errors)
                .Concat(parsed.UnknownColumns.Select(c => $"Column '{c}' was ignored."))),
        };
    }

    public Task<IReadOnlyList<SubscriptionQuantity>> GetSubscriptionQuantitiesAsync(DateOnly date, CancellationToken ct) =>
        SubscriptionQuantitiesAsync(null, date, ct);

    public Task<IReadOnlyList<SubscriptionQuantity>> GetSubscriptionQuantitiesAsync(IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken ct) =>
        SubscriptionQuantitiesAsync(organizationIds, date, ct);

    private async Task<IReadOnlyList<SubscriptionQuantity>> SubscriptionQuantitiesAsync(IReadOnlyCollection<Guid>? organizationIds, DateOnly date, CancellationToken ct)
    {
        if (organizationIds is { Count: 0 }) return [];
        var query = db.CspSubscriptions.AsNoTracking()
            .Where(s => s.OrganizationId != null && s.ProductId != null && s.Status == SubscriptionStatus.Active &&
                        (s.StartDate == null || s.StartDate <= date) &&
                        (s.CommitmentEndDate == null || s.CommitmentEndDate >= date));
        if (organizationIds is not null) query = query.Where(s => organizationIds.Contains(s.OrganizationId!.Value));
        var rows = await query
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

    /// <summary>Every unmapped offer of the customer (DEV-12): each becomes an anomaly of its basis, none is left out of the review.</summary>
    public async Task<IReadOnlyList<string>> GetUnmappedOfferNamesAsync(Guid organizationId, DateOnly date, CancellationToken ct) =>
        (await GetUnmappedOfferNamesAsync([organizationId], date, ct)).GetValueOrDefault(organizationId, []);

    public async Task<IReadOnlyDictionary<Guid, IReadOnlyList<string>>> GetUnmappedOfferNamesAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken ct)
    {
        if (organizationIds.Count == 0) return new Dictionary<Guid, IReadOnlyList<string>>();
        var rows = await db.CspSubscriptions.AsNoTracking()
            .Where(s => s.OrganizationId != null && organizationIds.Contains(s.OrganizationId.Value) && s.ProductId == null &&
                        s.Status == SubscriptionStatus.Active && (s.CommitmentEndDate == null || s.CommitmentEndDate >= date))
            .Select(s => new { OrganizationId = s.OrganizationId!.Value, Name = s.OfferName ?? s.OfferId })
            .Distinct().OrderBy(s => s.Name).ToListAsync(ct);
        return rows.GroupBy(s => s.OrganizationId).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(s => s.Name).ToList());
    }

    private async Task<IReadOnlyList<SubscriptionDto>> ToDtosAsync(IReadOnlyList<CspSubscription> subscriptions, CancellationToken ct)
    {
        var organizationIds = subscriptions.Where(s => s.OrganizationId != null).Select(s => s.OrganizationId!.Value).Distinct().ToList();
        var organizations = await customers.GetOrganizationNamesAsync(organizationIds, ct);
        var productIds = subscriptions.Where(s => s.ProductId != null).Select(s => s.ProductId!.Value).Distinct().ToList();
        var products = await catalog.GetProductsAsync(productIds, ct);
        var now = time.GetUtcNow();
        var today = Today;

        // BR-LIC-03: a subscription is only billed when its product is on a live contract line of that organization.
        var contracted = await contracts.GetContractedProductsAsync(organizationIds, today, ct);

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
