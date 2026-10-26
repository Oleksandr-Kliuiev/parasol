using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace Crm.Integrations.Core;

/// <summary>
/// How long the last complete read of a job counts as fresh (DEV-17), in minutes. The connections page and monitoring call a
/// job late after it, and a core module that shows what a job read says so too (<see cref="SyncCompletenessReader"/>).
/// </summary>
public static class FreshnessLimits
{
    /// <summary>
    /// The recurring jobs of Crm.Worker/Program.cs whose freshness follows their schedule (DEV-19), with the setting that holds
    /// the cron and the default of its options class, which this project cannot reference (a unit test compares the two). A
    /// job on a fixed schedule has no setting. The open and recent ticket reads and the invoice read have limits of their own.
    /// </summary>
    private static readonly Dictionary<string, (string? Key, string Default)> Schedules = new(StringComparer.Ordinal)
    {
        ["atera-customers"] = ("Integrations:Atera:CustomerSyncCron", "10,40 * * * *"),
        ["atera-contacts"] = ("Integrations:Atera:ContactSyncCron", "20 * * * *"),
        ["atera-work-hours"] = ("Integrations:Atera:WorkHoursSyncCron", "*/30 * * * *"),
        ["atera-agents"] = ("Integrations:Atera:AgentSyncCron", "30 1 * * *"),
        ["atera-patches"] = ("Integrations:Atera:PatchSyncCron", "15 2 * * *"),
        ["atera-alerts"] = ("Integrations:Atera:AlertSyncCron", "5,35 * * * *"),
        ["atera-ticket-conversations"] = ("Integrations:Atera:TicketConversationSyncCron", "*/5 * * * *"),
        ["poweroffice-customers"] = ("Integrations:PowerOffice:CustomerSyncCron", "*/15 * * * *"),
        ["poweroffice-contact-persons"] = ("Integrations:PowerOffice:ContactPersonSyncCron", "5,35 * * * *"),
        ["poweroffice-products"] = ("Integrations:PowerOffice:ProductSyncCron", "30 1 * * *"),
        ["poweroffice-customer-ledger"] = ("Integrations:PowerOffice:CustomerLedgerSyncCron", "35 * * * *"),
        ["poweroffice-invoice-pdfs"] = ("Integrations:PowerOffice:InvoicePdfSyncCron", "45 2 * * *"),
        ["partnercenter-customers"] = ("Integrations:PartnerCenter:CustomerSyncCron", "40 2 * * *"),
        ["partnercenter-subscriptions"] = ("Integrations:PartnerCenter:SubscriptionSyncCron", "15 */4 * * *"),
        ["partnercenter-licenses"] = ("Integrations:PartnerCenter:LicenseSyncCron", "50 2 * * *"),
        ["partnercenter-billing"] = ("Integrations:PartnerCenter:BillingSyncCron", "20 4 * * *"),
        ["entra-user-sync"] = ("Integrations:MicrosoftGraph:UserSyncCron", "15 * * * *"),
        ["entra-role-sync"] = ("Integrations:MicrosoftGraph:RoleSyncCron", "*/2 * * * *"),
        ["brreg-registry-check"] = (null, "0 2 * * *"),
    };

    /// <summary>The jobs whose limit follows their schedule.</summary>
    public static IReadOnlyCollection<string> ScheduledJobs => Schedules.Keys;

    /// <summary>
    /// <c>Monitoring:Freshness:{job}</c> when it is set; else the specification's limit (open and recent tickets 15, invoices
    /// 90); else the job's schedule: the longest gap between two runs plus half a gap and a quarter of an hour, so a daily job
    /// is not late at 24 hours and a half-hourly one is late after an hour; else <c>Monitoring:FreshnessMinutes</c> (a day).
    /// </summary>
    public static int Minutes(IConfiguration configuration, string job) => Math.Clamp(configuration.GetValue<int?>("Monitoring:Freshness:" + job) ?? job switch
    {
        "atera-tickets-recent" or "atera-tickets" => 15,
        "poweroffice-invoices" => 90,
        _ when Schedules.TryGetValue(job, out var schedule) =>
            CronCadence.FreshnessMinutes(schedule.Key is null ? null : configuration[schedule.Key], schedule.Default)
            ?? configuration.GetValue("Monitoring:FreshnessMinutes", 1440),
        _ => configuration.GetValue("Monitoring:FreshnessMinutes", 1440),
    }, 1, 525600);
}

/// <summary>Reads the spacing of runs out of a five-field cron expression, for the schedules this project uses (minute and hour lists, ranges and steps).</summary>
public static class CronCadence
{
    /// <summary>
    /// Minutes after which a job on <paramref name="cron"/> (or <paramref name="fallback"/> when empty) is overdue, or null when
    /// the expression restricts days or months, which this reading does not follow.
    /// </summary>
    public static int? FreshnessMinutes(string? cron, string fallback)
    {
        var gap = LongestGapMinutes(string.IsNullOrWhiteSpace(cron) ? fallback : cron);
        return gap is { } minutes ? minutes + minutes / 2 + 15 : null;
    }

    /// <summary>The longest time between two runs within a day, wrapping over midnight; null when days or months are restricted or the text is not understood.</summary>
    public static int? LongestGapMinutes(string cron)
    {
        var fields = cron.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length != 5 || fields[2] != "*" || fields[3] != "*" || fields[4] != "*")
        {
            return null;
        }

        var minutes = Expand(fields[0], 0, 59);
        var hours = Expand(fields[1], 0, 23);
        if (minutes is null || hours is null)
        {
            return null;
        }

        var times = hours.SelectMany(h => minutes.Select(m => h * 60 + m)).Order().ToList();
        if (times.Count == 0)
        {
            return null;
        }

        var gap = 1440 - times[^1] + times[0];
        for (var i = 1; i < times.Count; i++)
        {
            gap = Math.Max(gap, times[i] - times[i - 1]);
        }

        return gap;
    }

    private static List<int>? Expand(string field, int min, int max)
    {
        var values = new SortedSet<int>();
        foreach (var part in field.Split(','))
        {
            var step = 1;
            var range = part;
            var slash = part.IndexOf('/', StringComparison.Ordinal);
            if (slash >= 0)
            {
                if (!int.TryParse(part[(slash + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out step) || step < 1)
                {
                    return null;
                }

                range = part[..slash];
            }

            int from, to;
            if (range == "*")
            {
                (from, to) = (min, max);
            }
            else if (range.Contains('-', StringComparison.Ordinal))
            {
                var bounds = range.Split('-');
                if (bounds.Length != 2 || !int.TryParse(bounds[0], NumberStyles.None, CultureInfo.InvariantCulture, out from) ||
                    !int.TryParse(bounds[1], NumberStyles.None, CultureInfo.InvariantCulture, out to))
                {
                    return null;
                }
            }
            else if (int.TryParse(range, NumberStyles.None, CultureInfo.InvariantCulture, out from))
            {
                to = slash >= 0 ? max : from;
            }
            else
            {
                return null;
            }

            if (from < min || to > max || from > to)
            {
                return null;
            }

            for (var v = from; v <= to; v += step)
            {
                values.Add(v);
            }
        }

        return values.ToList();
    }
}
