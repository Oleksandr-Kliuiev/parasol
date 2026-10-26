using System.Globalization;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features.Coverage;

/// <summary>
/// A current device as the coverage rules of M41 read it: its machine, its source, its agent version and when it reached it, what
/// the source says about Defender, and its last contact.
/// </summary>
internal sealed record CoverageDevice(
    Guid Id,
    Guid OrganizationId,
    Guid? MachineId,
    string System,
    string MachineName,
    DeviceType Type,
    string? Platform,
    string? AgentVersion,
    DateTimeOffset? AgentVersionSince,
    string? AntivirusStatus,
    string? AntivirusSubstatus,
    DateTimeOffset? AntivirusReportedAt,
    DateTimeOffset? LastSeenAt,
    DateTimeOffset FirstSeenAt);

/// <summary>The pure part of the M41 rules, apart from the database so the tables of cases can check it.</summary>
internal static class HuntressCoverage
{
    public const string Atera = "atera";
    public const string Huntress = "huntress";

    /// <summary>
    /// Defender's statuses that mean it does not protect the computer, as Huntress words them: <c>Unhealthy</c> (confirmed by public
    /// sources) and <c>Disabled</c>. <c>Healthy</c> protects, <c>Unmanaged</c> means another antivirus is in charge; any other word is not
    /// read as a gap, so a status the reference does not list never raises an alert by guess.
    /// </summary>
    public static readonly string[] DefenderOffStatuses = ["Unhealthy", "Disabled"];

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    /// <summary>
    /// The machines watched by one of the two sources but not by the other: a machine of <paramref name="present"/> without a current
    /// device of <paramref name="missing"/>, once its device of <paramref name="present"/> has been known longer than the grace period
    /// (a new computer gets its second agent within a day or two). Network equipment carries no endpoint agent and is left out.
    /// </summary>
    public static IReadOnlyList<CoverageFinding> Missing(
        IReadOnlyCollection<CoverageDevice> devices, string present, string missing, DateTimeOffset knownBefore, Func<string, DateTimeOffset, string> title)
    {
        var findings = new List<CoverageFinding>();
        foreach (var machine in devices.Where(d => d.MachineId is not null).GroupBy(d => d.MachineId!.Value).OrderBy(g => g.Key))
        {
            if (machine.Any(d => d.System == missing))
            {
                continue;
            }

            var watched = machine.Where(d => d.System == present).OrderBy(d => d.FirstSeenAt).ThenBy(d => d.Id).ToList();
            if (watched.Count == 0 || watched[0].Type == DeviceType.Network || watched[0].FirstSeenAt >= knownBefore)
            {
                continue;
            }

            var lead = watched[0];
            findings.Add(new CoverageFinding(
                machine.Key.ToString("N"),
                lead.OrganizationId,
                lead.Type == DeviceType.Server ? AlertSeverity.Critical : AlertSeverity.Warning,
                title(lead.MachineName, lead.FirstSeenAt),
                lead.MachineName,
                lead.Id,
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["device"] = lead.MachineName,
                    ["since"] = lead.FirstSeenAt.ToString("O", CultureInfo.InvariantCulture),
                }));
        }

        return findings;
    }

    /// <summary>
    /// The agents that stay on an older version of their platform while the newest one runs elsewhere in the account, longer than
    /// the limit (counted from the earliest time a device was read with the newest version). Huntress's API says per organization how
    /// many agents it counts outdated but not which: the newest version the account runs is the only evidence per agent. An agent that
    /// has not called back within the limit is left to the silent-agent rule.
    /// </summary>
    public static IReadOnlyList<CoverageFinding> Outdated(
        IReadOnlyCollection<CoverageDevice> account, IReadOnlyCollection<Guid> organizations, DateTimeOffset now, int days)
    {
        var findings = new List<CoverageFinding>();
        var limit = now.AddDays(-days);
        foreach (var platform in account.Where(d => d.Platform is not null && Version(d.AgentVersion) is not null).GroupBy(d => d.Platform!))
        {
            var newest = platform.Select(d => Version(d.AgentVersion)!).Max(VersionComparer.Instance)!;
            var since = platform.Where(d => VersionComparer.Instance.Compare(Version(d.AgentVersion), newest) == 0 && d.AgentVersionSince is not null)
                .Select(d => d.AgentVersionSince!.Value).DefaultIfEmpty(now).Min();
            if (since > limit)
            {
                continue;
            }

            var newestText = string.Join('.', newest);
            foreach (var device in platform.Where(d => organizations.Contains(d.OrganizationId) && d.LastSeenAt > limit &&
                                                       VersionComparer.Instance.Compare(Version(d.AgentVersion), newest) < 0)
                         .OrderBy(d => d.Id))
            {
                findings.Add(new CoverageFinding(
                    device.Id.ToString("N"),
                    device.OrganizationId,
                    AlertSeverity.Warning,
                    string.Create(CultureInfo.InvariantCulture,
                        $"The Huntress agent on {device.MachineName} runs version {device.AgentVersion}; {newestText} has run on other machines since {Day(since):yyyy-MM-dd}"),
                    device.MachineName,
                    device.Id,
                    new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["device"] = device.MachineName,
                        ["version"] = device.AgentVersion!,
                        ["newest"] = newestText,
                        ["since"] = since.ToString("O", CultureInfo.InvariantCulture),
                    }));
            }
        }

        return findings;
    }

    /// <summary>The Windows agents whose Defender, by Huntress's word, does not protect the computer. A server is critical.</summary>
    public static IReadOnlyList<CoverageFinding> DefenderOff(IReadOnlyCollection<CoverageDevice> devices) =>
        devices.Where(d => (d.Platform is null or "windows") && DefenderOffStatuses.Contains(d.AntivirusStatus, StringComparer.OrdinalIgnoreCase))
            .OrderBy(d => d.Id)
            .Select(d =>
            {
                var facts = new Dictionary<string, string>(StringComparer.Ordinal) { ["device"] = d.MachineName, ["status"] = d.AntivirusStatus! };
                if (d.AntivirusSubstatus is { } substatus)
                {
                    facts["substatus"] = substatus;
                }

                if (d.AntivirusReportedAt is { } reported)
                {
                    facts["reportedAt"] = reported.ToString("O", CultureInfo.InvariantCulture);
                }

                return new CoverageFinding(
                    d.Id.ToString("N"),
                    d.OrganizationId,
                    d.Type == DeviceType.Server ? AlertSeverity.Critical : AlertSeverity.Warning,
                    $"Microsoft Defender does not protect {d.MachineName}: {d.AntivirusStatus}{(d.AntivirusSubstatus is { } detail ? $" ({detail})" : string.Empty)}",
                    d.MachineName,
                    d.Id,
                    facts);
            }).ToList();

    /// <summary>A version as its numbers (<c>0.13.140</c>); null when it is not one (a build tag), so it is never compared by guess.</summary>
    public static int[]? Version(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var parts = text.Trim().TrimStart('v', 'V').Split('.');
        var numbers = new int[parts.Length];
        for (var i = 0; i < parts.Length; i++)
        {
            if (!int.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out numbers[i]))
            {
                return null;
            }
        }

        return numbers;
    }

    public static DateTimeOffset Day(DateTimeOffset at) => TimeZoneInfo.ConvertTime(at, Oslo);

    /// <summary>Compares versions number by number; a missing number counts as zero (<c>1.2</c> equals <c>1.2.0</c>).</summary>
    private sealed class VersionComparer : IComparer<int[]?>
    {
        public static readonly VersionComparer Instance = new();

        public int Compare(int[]? x, int[]? y)
        {
            if (x is null || y is null)
            {
                return x is null ? (y is null ? 0 : -1) : 1;
            }

            for (var i = 0; i < Math.Max(x.Length, y.Length); i++)
            {
                var a = i < x.Length ? x[i] : 0;
                var b = i < y.Length ? y[i] : 0;
                if (a != b)
                {
                    return a.CompareTo(b);
                }
            }

            return 0;
        }
    }
}

/// <summary>What the M41 rules read: the current devices of the organizations a complete read covered, or of the whole account.</summary>
internal static class CoverageDevices
{
    public static async Task<List<CoverageDevice>> ReadAsync(ServiceDbContext db, IReadOnlyCollection<Guid>? organizations, string[] systems, CancellationToken ct)
    {
        var devices = db.Devices.AsNoTracking().Where(d => d.RemovedAt == null && systems.Contains(d.System));
        if (organizations is not null)
        {
            var ids = organizations.Distinct().ToList();
            devices = devices.Where(d => ids.Contains(d.OrganizationId));
        }

        return await devices.OrderBy(d => d.Id)
            .Select(d => new CoverageDevice(d.Id, d.OrganizationId, d.MachineId, d.System, d.MachineName, d.Type, d.Platform, d.AgentVersion,
                d.AgentVersionSince, d.AntivirusStatus, d.AntivirusSubstatus, d.AntivirusReportedAt, d.LastSeenAt, d.FirstSeenAt))
            .ToListAsync(ct);
    }
}

/// <summary>
/// A machine Atera watches but Huntress does not (M41): checked after a complete read of Huntress's agents, for the customers it
/// covered (those linked to a Huntress organization), once the machine's Atera agent is older than the grace period. A server is
/// critical, any other computer a warning.
/// </summary>
internal sealed class HuntressAgentMissingRule(ServiceDbContext db) : ICoverageRule
{
    public const string RuleCode = "huntress.agent-missing";

    public string Code => RuleCode;
    public string System => HuntressCoverage.Huntress;
    public AlertKind Kind => AlertKind.Security;
    public CoverageThreshold? Threshold { get; } = new(2, 1, 30, CoverageUnit.Days);

    public async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken)
    {
        if (check.Organizations.Count == 0)
        {
            return [];
        }

        var devices = await CoverageDevices.ReadAsync(db, check.Organizations, [HuntressCoverage.Atera, HuntressCoverage.Huntress], cancellationToken);
        return HuntressCoverage.Missing(devices, HuntressCoverage.Atera, HuntressCoverage.Huntress, check.Now.AddDays(-(check.Threshold ?? Threshold!.Default)),
            (name, since) => string.Create(CultureInfo.InvariantCulture,
                $"{name} has had the Atera agent since {HuntressCoverage.Day(since):yyyy-MM-dd} but no Huntress agent"));
    }
}

/// <summary>
/// A machine Huntress watches but Atera does not (M41): checked after a complete read of Atera's agents, for the customers it covered
/// (those linked to an Atera customer), once the machine's Huntress agent is older than the grace period.
/// </summary>
internal sealed class AteraAgentMissingRule(ServiceDbContext db) : ICoverageRule
{
    public const string RuleCode = "atera.agent-missing";

    public string Code => RuleCode;
    public string System => HuntressCoverage.Atera;
    public AlertKind Kind => AlertKind.Monitoring;
    public CoverageThreshold? Threshold { get; } = new(2, 1, 30, CoverageUnit.Days);

    public async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken)
    {
        if (check.Organizations.Count == 0)
        {
            return [];
        }

        var devices = await CoverageDevices.ReadAsync(db, check.Organizations, [HuntressCoverage.Atera, HuntressCoverage.Huntress], cancellationToken);
        return HuntressCoverage.Missing(devices, HuntressCoverage.Huntress, HuntressCoverage.Atera, check.Now.AddDays(-(check.Threshold ?? Threshold!.Default)),
            (name, since) => string.Create(CultureInfo.InvariantCulture,
                $"{name} has had the Huntress agent since {HuntressCoverage.Day(since):yyyy-MM-dd} but no Atera agent"));
    }
}

/// <summary>
/// A Huntress agent that has not called back for longer than the limit (M41, 7 days unless a person sets another): the computer is
/// not watched for threats. Only agents that called back once count. A silent server is critical, any other computer a warning.
/// </summary>
internal sealed class HuntressAgentSilentRule(ServiceDbContext db) : ICoverageRule
{
    public const string RuleCode = "huntress.agent-silent";

    public string Code => RuleCode;
    public string System => HuntressCoverage.Huntress;
    public AlertKind Kind => AlertKind.Security;
    public CoverageThreshold? Threshold { get; } = new(7, 1, 90, CoverageUnit.Days);

    public async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken)
    {
        var silentSince = check.Now.AddDays(-(check.Threshold ?? Threshold!.Default));
        var devices = await CoverageDevices.ReadAsync(db, check.Organizations, [HuntressCoverage.Huntress], cancellationToken);
        return devices.Where(d => d.LastSeenAt is { } seen && seen < silentSince).Select(d => new CoverageFinding(
            d.Id.ToString("N"),
            d.OrganizationId,
            d.Type == DeviceType.Server ? AlertSeverity.Critical : AlertSeverity.Warning,
            string.Create(CultureInfo.InvariantCulture,
                $"The Huntress agent on {d.MachineName} has not called back since {HuntressCoverage.Day(d.LastSeenAt!.Value):yyyy-MM-dd}"),
            d.MachineName,
            d.Id,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["device"] = d.MachineName,
                ["lastSeenAt"] = d.LastSeenAt!.Value.ToString("O", CultureInfo.InvariantCulture),
            })).ToList();
    }
}

/// <summary>
/// A Huntress agent that stays on an older version than the newest its platform runs in the account, longer than the limit (M41,
/// 14 days unless a person sets another). See <see cref="HuntressCoverage.Outdated"/> for what counts.
/// </summary>
internal sealed class HuntressAgentOutdatedRule(ServiceDbContext db) : ICoverageRule
{
    public const string RuleCode = "huntress.agent-outdated";

    public string Code => RuleCode;
    public string System => HuntressCoverage.Huntress;
    public AlertKind Kind => AlertKind.Security;
    public CoverageThreshold? Threshold { get; } = new(14, 1, 90, CoverageUnit.Days);

    public async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken)
    {
        if (check.Organizations.Count == 0)
        {
            return [];
        }

        // The newest version is the account's, so every current Huntress agent is read; findings stay within the covered customers.
        var account = await CoverageDevices.ReadAsync(db, null, [HuntressCoverage.Huntress], cancellationToken);
        return HuntressCoverage.Outdated(account, check.Organizations, check.Now, check.Threshold ?? Threshold!.Default);
    }
}

/// <summary>
/// Microsoft Defender does not protect a Windows computer, by Huntress's word (M41): its Managed Antivirus status is
/// <c>Unhealthy</c> or <c>Disabled</c>. Checked after every complete read of Huntress's agents; a server is critical.
/// </summary>
internal sealed class DefenderOffRule(ServiceDbContext db) : ICoverageRule
{
    public const string RuleCode = "huntress.defender-off";

    public string Code => RuleCode;
    public string System => HuntressCoverage.Huntress;
    public AlertKind Kind => AlertKind.Security;
    public CoverageThreshold? Threshold => null;

    public async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken)
    {
        if (check.Organizations.Count == 0)
        {
            return [];
        }

        return HuntressCoverage.DefenderOff(await CoverageDevices.ReadAsync(db, check.Organizations, [HuntressCoverage.Huntress], cancellationToken));
    }
}
