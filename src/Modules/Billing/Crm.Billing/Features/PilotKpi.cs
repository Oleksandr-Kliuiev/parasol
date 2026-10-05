using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Contracts.Contracts;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

/// <summary>
/// What a billing run looked like as a process (DEV-22): how long it took, how much of it was hand work and what was left
/// open. <see cref="CollectedAt"/> is the last collect (a re-collect moves it), so the hours are from the last collect, not from the
/// first. Lines and shares count the lines of bases that were not cancelled.
/// </summary>
public sealed record PilotRunKpi(
    Guid RunId,
    DateOnly PeriodStart,
    BillingRunKind Kind,
    BillingRunStatus Status,
    DateTimeOffset? CollectedAt,
    DateTimeOffset? ApprovedAt,
    DateTimeOffset? ExportedAt,
    DateTimeOffset? ClosedAt,
    double? HoursCollectedToClosed,
    double? HoursCollectedToExported,
    int Bases,
    int BasesCancelled,
    int BasesFailed,
    int BasesReconciliationRequired,
    int BasesWithAnomalies,
    int AnomalyEntries,
    int Lines,
    int ManualLines,
    double? ManualShare,
    int UnresolvedConflicts);

public sealed record PilotKpiTotals(
    int Runs,
    int ClosedRuns,
    double? AverageHoursCollectedToClosed,
    int Lines,
    int ManualLines,
    double? ManualShare,
    int AnomalyEntries,
    int UnresolvedConflicts,
    int BasesFailed,
    int BasesReconciliationRequired);

/// <summary>A figure the pilot asked for that the data cannot give honestly, with the reason — never a made-up number.</summary>
public sealed record PilotNotMeasured(string Kpi, string Reason);

public sealed record PilotKpiReport(
    DateOnly From,
    DateOnly To,
    DateOnly AsOf,
    IReadOnlyList<PilotRunKpi> Runs,
    PilotKpiTotals Totals,
    int OverdueUnacknowledgedReminders,
    IReadOnlyList<PilotNotMeasured> NotMeasured);

internal sealed class PilotKpiService(BillingDbContext db, IContractsApi contracts, TimeProvider time)
{
    public const int MaxMonths = 36;
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public static readonly IReadOnlyList<PilotNotMeasured> NotMeasuredKpis =
    [
        new("timeToFirstSuccessfulScenarioPerUser",
            "The CRM does not record that a user completed a scenario; sessions and audit rows say that someone signed in or changed something, not that a scenario succeeded."),
        new("missedRenewals",
            "A contract that ends without a renewal is not marked as missed anywhere; only the overdue reminders below are counted."),
        new("exceptionAgeOfResolvedItems",
            "Anomalies are recomputed at every collect and a resolved conflict is overwritten; there is no timestamp of when an exception was first seen or resolved."),
        new("loginsByRole",
            "A login row in the audit trail names the user and the time but not the role, and the audit module offers no contract to other modules; counting logins per role would need a join this module may not make."),
    ];

    public async Task<Result<PilotKpiReport>> ReportAsync(DateOnly? from, DateOnly? to, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
        var last = to ?? today;
        var first = from ?? new DateOnly(last.Year, last.Month, 1).AddMonths(-11);
        if (first > last)
        {
            return Error.Validation("BIL_PILOT_KPI_RANGE", "'from' is after 'to'.");
        }

        if ((last.Year - first.Year) * 12 + last.Month - first.Month + 1 > MaxMonths)
        {
            return Error.Validation("BIL_PILOT_KPI_RANGE", $"Ask for at most {MaxMonths} months at a time.", new Dictionary<string, object?> { ["maxMonths"] = MaxMonths });
        }

        var runs = await db.BillingRuns.AsNoTracking()
            .Where(r => r.PeriodStart >= first && r.PeriodStart <= last)
            .OrderBy(r => r.PeriodStart).ThenBy(r => r.Id)
            .Select(r => new { r.Id, r.PeriodStart, r.Kind, r.Status, r.CollectedAt, r.ApprovedAt, r.ExportedAt, r.ClosedAt })
            .ToListAsync(ct);
        var runIds = runs.Select(r => r.Id).ToList();

        var bases = (await db.BillingBases.AsNoTracking()
                .Where(b => runIds.Contains(b.RunId))
                .GroupBy(b => b.RunId)
                .Select(g => new
                {
                    RunId = g.Key,
                    Total = g.Count(),
                    Cancelled = g.Count(b => b.Status == BillingBasisStatus.Cancelled),
                    Failed = g.Count(b => b.Status == BillingBasisStatus.Failed),
                    Reconciliation = g.Count(b => b.Status == BillingBasisStatus.ReconciliationRequired),
                    WithAnomalies = g.Count(b => b.AnomaliesJson != null),
                })
                .ToListAsync(ct))
            .ToDictionary(x => x.RunId);

        var lines = (await (
                    from line in db.BillingLines.AsNoTracking()
                    join basis in db.BillingBases.AsNoTracking() on line.BasisId equals basis.Id
                    where runIds.Contains(basis.RunId) && basis.Status != BillingBasisStatus.Cancelled
                    group line by basis.RunId into g
                    select new
                    {
                        RunId = g.Key,
                        Total = g.Count(),
                        Manual = g.Count(l => l.ManuallyAdjusted || l.Origin == BillingLineOrigin.Manual || l.Decision != BillingLineDecision.None),
                        Conflicts = g.Count(l => l.Conflict != BillingLineConflict.None),
                    })
                .ToListAsync(ct))
            .ToDictionary(x => x.RunId);

        // Only the bases that carry anomalies are read, to count the entries in their JSON; nothing is cut off.
        var anomalyEntries = new Dictionary<Guid, int>();
        var flagged = await db.BillingBases.AsNoTracking()
            .Where(b => runIds.Contains(b.RunId) && b.AnomaliesJson != null)
            .Select(b => new { b.RunId, b.AnomaliesJson })
            .ToListAsync(ct);
        foreach (var row in flagged)
        {
            var count = (JsonSerializer.Deserialize<List<BillingAnomaly>>(row.AnomaliesJson!) ?? []).Count;
            anomalyEntries[row.RunId] = anomalyEntries.GetValueOrDefault(row.RunId) + count;
        }

        var items = runs.Select(r =>
        {
            var b = bases.GetValueOrDefault(r.Id);
            var l = lines.GetValueOrDefault(r.Id);
            return new PilotRunKpi(
                r.Id, r.PeriodStart, r.Kind, r.Status, r.CollectedAt, r.ApprovedAt, r.ExportedAt, r.ClosedAt,
                Hours(r.CollectedAt, r.ClosedAt), Hours(r.CollectedAt, r.ExportedAt),
                b?.Total ?? 0, b?.Cancelled ?? 0, b?.Failed ?? 0, b?.Reconciliation ?? 0, b?.WithAnomalies ?? 0, anomalyEntries.GetValueOrDefault(r.Id),
                l?.Total ?? 0, l?.Manual ?? 0, Share(l?.Manual ?? 0, l?.Total ?? 0), l?.Conflicts ?? 0);
        }).ToList();

        var totalLines = items.Sum(i => i.Lines);
        var totalManual = items.Sum(i => i.ManualLines);
        var closedHours = items.Where(i => i.HoursCollectedToClosed is not null).Select(i => i.HoursCollectedToClosed!.Value).ToList();
        var totals = new PilotKpiTotals(
            items.Count, items.Count(i => i.Status == BillingRunStatus.Closed),
            closedHours.Count == 0 ? null : Math.Round(closedHours.Average(), 1),
            totalLines, totalManual, Share(totalManual, totalLines), items.Sum(i => i.AnomalyEntries), items.Sum(i => i.UnresolvedConflicts),
            items.Sum(i => i.BasesFailed), items.Sum(i => i.BasesReconciliationRequired));

        var overdue = await contracts.CountOverdueRemindersAsync(today, ct);
        return new PilotKpiReport(first, last, today, items, totals, overdue, NotMeasuredKpis);
    }

    private static double? Hours(DateTimeOffset? from, DateTimeOffset? to) =>
        from is { } start && to is { } end && end >= start ? Math.Round((end - start).TotalHours, 1) : null;

    private static double? Share(int part, int whole) =>
        whole == 0 ? null : Math.Round(part / (double)whole, 4);
}
