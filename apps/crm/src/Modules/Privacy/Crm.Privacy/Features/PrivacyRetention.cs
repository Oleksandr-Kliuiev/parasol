using System.Text.Json;
using Crm.Privacy.Contracts;
using Crm.Privacy.Domain;
using Crm.Privacy.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Privacy.Features;

/// <summary>Configuration of the privacy module (section <c>Privacy</c>).</summary>
public sealed class PrivacyOptions
{
    public const string SectionName = "Privacy";

    public RetentionOptions Retention { get; set; } = new();
}

public sealed class RetentionOptions
{
    /// <summary>
    /// DryRun until EXT-07: the approved matrix of retention periods is attached and the database administrator has written its
    /// periods into privacy.RetentionPolicies. Even in Apply mode a class without an approved policy is only counted.
    /// </summary>
    public RetentionMode Mode { get; set; } = RetentionMode.DryRun;

    public string Cron { get; set; } = "30 3 * * *";

    /// <summary>Records removed per class per batch, and batches per class per night: a backlog is worked off over nights.</summary>
    public int BatchSize { get; set; } = 500;

    public int MaxBatchesPerRun { get; set; } = 20;

    /// <summary>
    /// Periods docs/04 §8 proposes, in days, shown by the dry run as proposals — never applied. Approval is the data owner's
    /// (DEC-03, EXT-07).
    /// </summary>
    public Dictionary<string, int> ProposedDays { get; set; } = new(StringComparer.Ordinal)
    {
        ["customers.former-contacts"] = 3 * 365,
        ["sales.unconverted-leads"] = 2 * 365,
        ["service.tickets"] = 3 * 365,
        ["service.resolved-alerts"] = 365,
        ["integration.external-payloads"] = 90,
        ["integration.sync-runs"] = 180,
        ["integration.vendor-action-texts"] = 90,
        ["identity.sessions"] = 90,
    };
}

public sealed record RetentionClassReport(
    string DataClass, bool Approved, string? Reference, int? Days, bool Proposal, int Due, int Removed, string? Error);

public sealed record RetentionReport(Guid RunId, RetentionMode Mode, DateTimeOffset StartedAt, DateTimeOffset? FinishedAt, bool Failed, IReadOnlyList<RetentionClassReport> Classes);

/// <summary>
/// The nightly retention job (SEC-GDPR-05, DEV-11): per data class, how many records the period makes due and — only in Apply
/// mode and only with a policy the database administrator approved — removing them in bounded batches. A failing class is
/// reported and the others go on; the next night continues. Every run is recorded and logged as PRIVACY_RETENTION lines.
/// </summary>
public sealed class PrivacyRetentionJob(
    PrivacyDbContext db,
    IEnumerable<IRetentionContributor> contributors,
    IOptions<PrivacyOptions> options,
    TimeProvider time,
    ILogger<PrivacyRetentionJob> logger)
{
    public const string JobId = "privacy-retention";

    public async Task<RetentionReport> RunAsync(CancellationToken cancellationToken)
    {
        var settings = options.Value.Retention;
        var run = RetentionRun.Start(settings.Mode, time.GetUtcNow());
        db.RetentionRuns.Add(run);
        await db.SaveChangesAsync(cancellationToken);

        var policies = await db.RetentionPolicies.AsNoTracking().ToDictionaryAsync(p => p.DataClass, StringComparer.Ordinal, cancellationToken);
        var reports = new List<RetentionClassReport>();
        foreach (var contributor in contributors.OrderBy(c => c.DataClass, StringComparer.Ordinal))
        {
            policies.TryGetValue(contributor.DataClass, out var policy);
            int? days = policy?.RetainDays ?? (settings.ProposedDays.TryGetValue(contributor.DataClass, out var proposed) ? proposed : null);
            int due = 0, removed = 0;
            string? error = null;
            if (days is { } period)
            {
                var olderThan = time.GetUtcNow().AddDays(-period);
                try
                {
                    due = await contributor.CountAsync(olderThan, cancellationToken);
                    if (settings.Mode == RetentionMode.Apply && policy is not null)
                    {
                        for (var batch = 0; batch < settings.MaxBatchesPerRun && removed < due; batch++)
                        {
                            var applied = await contributor.ApplyAsync(olderThan, settings.BatchSize, cancellationToken);
                            if (applied == 0)
                            {
                                break;
                            }

                            removed += applied;
                        }
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // The type only: a message can quote the data being removed.
                    error = ex.GetType().Name;
                }
            }

            var report = new RetentionClassReport(contributor.DataClass, policy is not null, policy?.Reference, days, policy is null, due, removed, error);
            reports.Add(report);
            logger.Log(error is null ? LogLevel.Information : LogLevel.Error,
                "PRIVACY_RETENTION {Mode} {DataClass} approved={Approved} days={Days} due={Due} removed={Removed} error={Error}",
                settings.Mode, report.DataClass, report.Approved, report.Days, report.Due, report.Removed, report.Error ?? "-");
        }

        run.Finish(JsonSerializer.Serialize(reports, PrivacyPlan.Json), reports.Any(r => r.Error is not null), time.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
        return ToReport(run, reports);
    }

    public static RetentionReport ToReport(RetentionRun run, IReadOnlyList<RetentionClassReport>? classes = null) => new(
        run.Id, run.Mode, run.StartedAt, run.FinishedAt, run.Failed,
        classes ?? JsonSerializer.Deserialize<List<RetentionClassReport>>(run.ReportJson, PrivacyPlan.Json) ?? []);
}
