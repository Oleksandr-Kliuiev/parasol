using System.Globalization;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features.Coverage;

/// <summary>
/// An Atera agent that has not reported for longer than the limit (M40, 7 days unless a person sets another): the computer it
/// watches is not watched. Only current agents of the organizations the read covered count, and only those that reported once:
/// an agent without a last contact says nothing about how long it has been silent. A silent server is critical, any other
/// computer a warning. The gap began when the silence passed the limit: the last contact plus the limit.
/// </summary>
internal sealed class AteraAgentSilentRule(ServiceDbContext db) : ICoverageRule
{
    public const string RuleCode = "atera.agent-silent";
    private const string Source = "atera";

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public string Code => RuleCode;
    public string System => Source;
    public AlertKind Kind => AlertKind.Monitoring;
    public CoverageThreshold? Threshold { get; } = new(7, 1, 90, CoverageUnit.Days);

    public async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken)
    {
        var days = check.Threshold ?? Threshold!.Default;
        var silentSince = check.Now.AddDays(-days);
        var organizations = check.Organizations.Distinct().ToList();
        if (organizations.Count == 0)
        {
            return [];
        }

        var silent = await db.Devices.AsNoTracking()
            .Where(d => d.System == Source && d.RemovedAt == null && d.LastSeenAt != null && d.LastSeenAt < silentSince
                && organizations.Contains(d.OrganizationId))
            .OrderBy(d => d.Id)
            .Select(d => new { d.Id, d.OrganizationId, d.MachineName, d.Type, LastSeenAt = d.LastSeenAt!.Value })
            .ToListAsync(cancellationToken);
        return silent.Select(d => new CoverageFinding(
            d.Id.ToString("N"),
            d.OrganizationId,
            d.Type == DeviceType.Server ? AlertSeverity.Critical : AlertSeverity.Warning,
            string.Create(CultureInfo.InvariantCulture,
                $"The Atera agent on {d.MachineName} has not reported since {TimeZoneInfo.ConvertTime(d.LastSeenAt, Oslo):yyyy-MM-dd}"),
            d.MachineName,
            d.Id,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["device"] = d.MachineName,
                ["lastSeenAt"] = d.LastSeenAt.ToString("O", CultureInfo.InvariantCulture),
            },
            d.LastSeenAt.AddDays(days))).ToList();
    }
}
