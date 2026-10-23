using System.Globalization;
using Crm.Backup.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Security.Contracts;
using Crm.Service.Contracts;
using Crm.TimeTracking.Contracts;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Reports;

/// <summary>A source's security figures of the month, from its own monthly report (Huntress).</summary>
public sealed record SecurityMonth(
    string System, int? IncidentsReported, int? IncidentsResolved, long? SignalsDetected, long? SignalsInvestigated, int? AgentsCount);

/// <summary>Device counts at the month's end (the daily count of that day or the latest before it); null date: the live list was counted.</summary>
public sealed record DeviceMonth(IReadOnlyDictionary<DeviceType, int> Counts, DateOnly? CountedOn);

/// <summary>
/// Everything the monthly summary of one customer says (M43), gathered once from the modules' contracts and rendered from this alone.
/// Counts and dates only: no alert title, device name, person or amount of money.
/// </summary>
public sealed record CustomerMonthSnapshot(
    Guid OrganizationId,
    string OrganizationName,
    string? OrgNumber,
    DateOnly MonthStart,
    DateOnly MonthEnd,
    string Language,
    StoredDocumentProvenance Provenance,
    DateTimeOffset TakenAt,
    ServiceMonth Service,
    DeviceMonth? Devices,
    IReadOnlyList<SecurityMonth> Security,
    BackupState? Backup,
    decimal? Hours,
    decimal? BilledHours);

/// <summary>What one filing round did: summaries filed, already filed before, and customers whose summary failed (counted, logged by id).</summary>
public sealed record CustomerMonthRun(string Month, int Candidates, int Filed, int FiledBefore, int Failed);

/// <summary>
/// Parasoll's own monthly summary of each serviced customer (M43), filed among the customer's documents next to Huntress's report.
/// Reporting owns no schema: the summary is gathered from the modules' contracts, rendered once (<see cref="CustomerMonthPdf"/>) and
/// filed through the Customers module, which keeps it unchanged for good — a month is never rendered again. A summary taken more than
/// <see cref="ReportsOptions.SnapshotTimelyDays"/> after the month ended is Reconstructed from what the modules hold by then and says so
/// on every page (ADR-022): resolved alerts and closed incidents may already be past their retention, backups are as they are now.
/// The customers are the serviced ones: a contract in force in the month, or records of a linked Atera, Huntress or CloudAlly
/// organization (the mirrors hold only linked customers).
/// </summary>
internal sealed class CustomerMonthReports(
    IServiceScopeFactory scopes,
    TimeProvider time,
    IOptions<ReportsOptions> options,
    ILogger<CustomerMonthReports> logger)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    /// <summary>The month before today (Oslo): the month a daily round files.</summary>
    public DateOnly PreviousMonth()
    {
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
        return new DateOnly(today.Year, today.Month, 1).AddMonths(-1);
    }

    /// <summary>
    /// Files the summary of <paramref name="monthStart"/>'s month for every serviced customer that has none yet; only for those of
    /// <paramref name="only"/> among them when given.
    /// </summary>
    public async Task<CustomerMonthRun> FileMonthAsync(DateOnly monthStart, CancellationToken ct, IReadOnlyCollection<Guid>? only = null)
    {
        var first = new DateOnly(monthStart.Year, monthStart.Month, 1);
        var last = first.AddMonths(1).AddDays(-1);
        var (from, to) = (Instant(first), Instant(first.AddMonths(1)));
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
        if (today <= last)
        {
            throw new InvalidOperationException("A month is summarised after its last day.");
        }

        var key = StoredDocumentKinds.ParasollSummary(first);
        List<Guid> candidates;
        HashSet<Guid> filed;
        MonthShared shared;
        await using (var scope = scopes.CreateAsyncScope())
        {
            candidates = (await CandidatesAsync(scope.ServiceProvider, first, last, from, to, ct)).Where(id => only is null || only.Contains(id)).ToList();
            filed = (await scope.ServiceProvider.GetRequiredService<ICustomerDocuments>().FiledAsync(StoredDocumentKinds.ParasollMonthly, [key], ct))
                .Select(f => f.OrganizationId).ToHashSet();
            // What every customer's summary reads of the whole month is read once for the round.
            shared = new MonthShared(
                (await scope.ServiceProvider.GetRequiredService<IBackupApi>().GetOrganizationsAsync("cloudally", ct)).ToHashSet(),
                (await scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().GetHoursByOrganizationAsync(first, last, ct))
                    .GroupBy(h => h.OrganizationId).ToDictionary(g => g.Key, g => g.First()));
        }

        int created = 0, before = 0, failed = 0;
        foreach (var organizationId in candidates)
        {
            if (filed.Contains(organizationId))
            {
                before++;
                continue;
            }

            // One scope per customer: a summary that fails leaves nothing tracked behind for the next one.
            await using var scope = scopes.CreateAsyncScope();
            var documents = scope.ServiceProvider.GetRequiredService<ICustomerDocuments>();
            try
            {
                var snapshot = await ComposeAsync(scope.ServiceProvider, organizationId, first, last, from, to, today, shared, ct);
                if (snapshot is null)
                {
                    continue;
                }

                var outcome = await documents.FileAsync(new StoredDocumentFiling(
                    organizationId, StoredDocumentKinds.ParasollMonthly, key, first, last, FileName(first), CustomerMonthPdf.Render(snapshot),
                    snapshot.Provenance, CustomerMonthPdf.RendererVersion), ct);
                if (outcome.Created)
                {
                    created++;
                }
                else
                {
                    before++;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                logger.LogWarning("The monthly summary of organization {OrganizationId} for {Month} failed ({ErrorType})",
                    organizationId, first.ToString("yyyy-MM", CultureInfo.InvariantCulture), ex.GetType().Name);
            }
        }

        return new CustomerMonthRun(first.ToString("yyyy-MM", CultureInfo.InvariantCulture), candidates.Count, created, before, failed);
    }

    /// <summary>Gathers one customer's month; null when the customer is no longer there.</summary>
    private async Task<CustomerMonthSnapshot?> ComposeAsync(
        IServiceProvider services, Guid organizationId, DateOnly first, DateOnly last, DateTimeOffset from, DateTimeOffset to, DateOnly today, MonthShared shared,
        CancellationToken ct)
    {
        var customers = services.GetRequiredService<ICustomersApi>();
        if (await customers.GetOrganizationAsync(organizationId, ct) is not { } organization)
        {
            return null;
        }

        var service = await services.GetRequiredService<IServiceMonthFacts>().GetMonthAsync(organizationId, from, to, ct);
        var devices = (await services.GetRequiredService<IServiceApi>().GetDeviceCountReadingsAsync([organizationId], last, ct)).GetValueOrDefault(organizationId);
        var reports = await services.GetRequiredService<ISecurityReports>().GetMonthlyReportsAsync("huntress", first, [organizationId], ct);
        var security = reports.Where(r => r.PeriodStart is { } start && start <= last)
            .Select(r => new SecurityMonth(r.System, r.IncidentsReported, r.IncidentsResolved, r.SignalsDetected, r.SignalsInvestigated, r.AgentsCount))
            .ToList();
        var backup = shared.BackedUp.Contains(organizationId) ? await services.GetRequiredService<IBackupFacts>().GetStateAsync(organizationId, ct) : null;
        var hours = shared.Hours.GetValueOrDefault(organizationId);
        var provenance = BiSnapshotService.ProvenanceOf(today, last, options.Value.SnapshotTimelyDays) == "Captured"
            ? StoredDocumentProvenance.Captured
            : StoredDocumentProvenance.Reconstructed;
        return new CustomerMonthSnapshot(
            organizationId, organization.Name, organization.OrgNumber, first, last, options.Value.CustomerMonthLanguage, provenance, time.GetUtcNow(),
            service, devices is null || devices.Counts.Count == 0 ? null : new DeviceMonth(devices.Counts, devices.SnapshotDate), security, backup,
            hours?.Hours, hours?.BilledHours);
    }

    /// <summary>The month's facts of every customer at once: who has a CloudAlly account, and the hours per customer.</summary>
    private sealed record MonthShared(HashSet<Guid> BackedUp, Dictionary<Guid, HoursByOrganization> Hours);

    public static string FileName(DateOnly monthStart) => string.Create(CultureInfo.InvariantCulture, $"parasoll-{monthStart:yyyy-MM}.pdf");

    /// <summary>The serviced customers of the month: a contract line in force in it, or records in the Service, Security or Backup mirrors.</summary>
    private static async Task<List<Guid>> CandidatesAsync(
        IServiceProvider services, DateOnly first, DateOnly last, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        var contracted = (await services.GetRequiredService<IContractsApi>().GetBillableLinesAsync(first, last, ct)).Select(l => l.OrganizationId);
        var serviced = await services.GetRequiredService<IServiceMonthFacts>().GetServicedOrganizationsAsync(from, to, ct);
        var reported = (await services.GetRequiredService<ISecurityReports>().GetMonthlyReportsAsync("huntress", first, null, ct))
            .Where(r => r.PeriodStart is { } start && start <= last).Select(r => r.OrganizationId);
        var backedUp = await services.GetRequiredService<IBackupApi>().GetOrganizationsAsync("cloudally", ct);
        return contracted.Concat(serviced).Concat(reported).Concat(backedUp).Distinct().Order().ToList();
    }

    private static DateTimeOffset Instant(DateOnly day)
    {
        var local = day.ToDateTime(TimeOnly.MinValue);
        return new DateTimeOffset(local, Oslo.GetUtcOffset(local));
    }
}

/// <summary>Files last month's summaries every morning; a customer that has its summary is skipped, so a later round adds only the missing ones.</summary>
public sealed class CustomerMonthReportJob(IServiceScopeFactory scopes, ILogger<CustomerMonthReportJob> logger)
{
    public const string JobId = "reports-customer-months";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var reports = scope.ServiceProvider.GetRequiredService<CustomerMonthReports>();
        var run = await reports.FileMonthAsync(reports.PreviousMonth(), cancellationToken);
        logger.LogInformation("Monthly summaries of {Month}: {Candidates} customers, filed {Filed}, filed before {Before}, failed {Failed}",
            run.Month, run.Candidates, run.Filed, run.FiledBefore, run.Failed);
    }
}
