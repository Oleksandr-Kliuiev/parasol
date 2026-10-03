using Crm.Authorization;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Service.Persistence;
using Crm.SharedKernel.Results;
using Crm.SharedKernel.Time;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

public sealed record SlaTicketRow(
    Guid TicketId,
    long ExternalId,
    string Title,
    string Priority,
    DateTimeOffset CreatedAt,
    int? ResponseMinutes,
    int? ResolutionMinutes,
    int ResponseTarget,
    int ResolutionTarget,
    bool ResponseBreached,
    bool ResolutionBreached,
    bool StillOpen,
    string? Url);

/// <summary>How one customer's tickets did against the promise in their contract (FR-SRV-04).</summary>
public sealed record SlaOrganizationRow(
    Guid OrganizationId,
    string OrganizationName,
    string? ContractNumber,
    string? PolicyName,
    SupportHours? Coverage,
    int Tickets,
    int Resolved,
    int ResponseMeasured,
    int ResponseMet,
    int ResolutionMeasured,
    int ResolutionMet,
    decimal ResponseMetPct,
    decimal ResolutionMetPct,
    int? MedianResponseMinutes,
    IReadOnlyList<SlaTicketRow> Breaches);

public sealed record SlaReport(
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    int Tickets,
    int WithoutSla,
    decimal ResponseMetPct,
    decimal ResolutionMetPct,
    IReadOnlyList<SlaOrganizationRow> Organizations);

/// <summary>
/// Measures response and resolution against the SLA of the customer's contract (BR-SRV-05). The clock only runs inside the
/// agreement's support hours and never on a Norwegian public holiday, so a Friday-evening ticket under 8×5 starts Monday.
/// </summary>
internal sealed class SlaReportService(ServiceDbContext db, IContractsApi contracts, ICustomersApi customers)
{
    /// <summary>At most this many breaching tickets per customer are listed; the rest are counted, not printed.</summary>
    private const int BreachesShown = 10;

    public async Task<Result<SlaReport>> GetAsync(int year, int month, Guid? organizationId, CancellationToken ct)
    {
        if (year is < 2020 or > 2100 || month is < 1 or > 12)
        {
            return Error.Validation("SRV_PERIOD", "Choose a month between 2020 and 2100.");
        }

        var periodStart = new DateOnly(year, month, 1);
        var periodEnd = periodStart.AddMonths(1).AddDays(-1);
        var from = new DateTimeOffset(periodStart.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero);
        var to = new DateTimeOffset(periodEnd.ToDateTime(TimeOnly.MaxValue), TimeSpan.Zero);

        var tickets = await db.Tickets.AsNoTracking()
            .Where(t => t.CreatedAtSource >= from && t.CreatedAtSource <= to &&
                        (organizationId == null || t.OrganizationId == organizationId))
            .Take(5000)
            .ToListAsync(ct);
        if (tickets.Count == 0)
        {
            return new SlaReport(periodStart, periodEnd, 0, 0, 0m, 0m, []);
        }

        var targets = (await contracts.GetSlaTargetsAsync(periodEnd, ct)).ToDictionary(t => t.OrganizationId);
        var names = await customers.GetOrganizationNamesAsync(tickets.ConvertAll(t => t.OrganizationId).Distinct().ToList(), ct);

        var rows = new List<SlaOrganizationRow>();
        var withoutSla = 0;
        foreach (var group in tickets.GroupBy(t => t.OrganizationId))
        {
            if (!targets.TryGetValue(group.Key, out var sla))
            {
                withoutSla += group.Count();
                rows.Add(new SlaOrganizationRow(
                    group.Key, names.GetValueOrDefault(group.Key, "—"), null, null, null,
                    group.Count(), group.Count(t => t.ResolvedAt != null), 0, 0, 0, 0, 0m, 0m, null, []));
                continue;
            }

            rows.Add(Measure(group.Key, names.GetValueOrDefault(group.Key, "—"), [.. group], sla));
        }

        var measuredResponse = rows.Sum(r => r.ResponseMeasured);
        var metResponse = rows.Sum(r => r.ResponseMet);
        var measuredResolution = rows.Sum(r => r.ResolutionMeasured);
        var metResolution = rows.Sum(r => r.ResolutionMet);

        return new SlaReport(
            periodStart,
            periodEnd,
            tickets.Count,
            withoutSla,
            Percent(metResponse, measuredResponse),
            Percent(metResolution, measuredResolution),
            rows.OrderBy(r => r.ResponseMetPct).ThenByDescending(r => r.Tickets).ToList());
    }

    private static SlaOrganizationRow Measure(Guid organizationId, string name, List<Domain.Ticket> tickets, SlaTargets sla)
    {
        var window = WindowOf(sla.Coverage);
        var measured = new List<SlaTicketRow>();
        foreach (var ticket in tickets)
        {
            var target = sla.For(PriorityOf(ticket.Priority));
            var response = ticket.FirstResponseAt is { } responded
                ? BusinessTime.MinutesBetween(ticket.CreatedAtSource, responded, window)
                : (int?)null;
            var resolution = ticket.ResolvedAt is { } resolved
                ? BusinessTime.MinutesBetween(ticket.CreatedAtSource, resolved, window)
                : (int?)null;

            measured.Add(new SlaTicketRow(
                ticket.Id,
                ticket.ExternalId,
                ticket.Title,
                ticket.Priority ?? "—",
                ticket.CreatedAtSource,
                response,
                resolution,
                target.ResponseMinutes,
                target.ResolutionMinutes,
                response is { } r && target.ResponseMinutes > 0 && r > target.ResponseMinutes,
                resolution is { } s && target.ResolutionMinutes > 0 && s > target.ResolutionMinutes,
                ticket.ResolvedAt is null,
                ticket.Url));
        }

        var responseMeasured = measured.Count(m => m.ResponseMinutes is not null && m.ResponseTarget > 0);
        var resolutionMeasured = measured.Count(m => m.ResolutionMinutes is not null && m.ResolutionTarget > 0);
        var responseTimes = measured.Where(m => m.ResponseMinutes is not null).Select(m => m.ResponseMinutes!.Value).Order().ToList();

        return new SlaOrganizationRow(
            organizationId,
            name,
            sla.ContractNumber,
            sla.PolicyName,
            sla.Coverage,
            tickets.Count,
            tickets.Count(t => t.ResolvedAt != null),
            responseMeasured,
            measured.Count(m => m.ResponseMinutes is not null && m.ResponseTarget > 0 && !m.ResponseBreached),
            resolutionMeasured,
            measured.Count(m => m.ResolutionMinutes is not null && m.ResolutionTarget > 0 && !m.ResolutionBreached),
            Percent(measured.Count(m => m.ResponseMinutes is not null && m.ResponseTarget > 0 && !m.ResponseBreached), responseMeasured),
            Percent(measured.Count(m => m.ResolutionMinutes is not null && m.ResolutionTarget > 0 && !m.ResolutionBreached), resolutionMeasured),
            responseTimes.Count > 0 ? responseTimes[responseTimes.Count / 2] : null,
            measured.Where(m => m.ResponseBreached || m.ResolutionBreached)
                .OrderByDescending(m => (m.ResponseMinutes ?? 0) - m.ResponseTarget)
                .Take(BreachesShown)
                .ToList());
    }

    private static SupportWindow WindowOf(SupportHours coverage) => coverage switch
    {
        SupportHours.Always24x7 => SupportWindow.Around,
        SupportHours.Extended12x5 => SupportWindow.Between(7, 19),
        _ => SupportWindow.Between(8, 16),
    };

    /// <summary>Atera's words for urgency mapped to the priorities the SLA policy names (P1 is the most urgent).</summary>
    internal static int PriorityOf(string? priority) => priority?.Trim().ToLowerInvariant() switch
    {
        "critical" or "kritisk" or "p1" => 1,
        "high" or "høy" or "hoy" or "p2" => 2,
        "medium" or "middels" or "p3" => 3,
        _ => 4,
    };

    private static decimal Percent(int met, int measured) => measured == 0 ? 0m : decimal.Round(met * 100m / measured, 1);
}
