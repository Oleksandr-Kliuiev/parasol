using Crm.SharedKernel.Domain;

namespace Crm.Privacy.Domain;

/// <summary>
/// An approved retention period for one data class (DEC-03, EXT-07): written by the database administrator with the
/// decision's reference, never by the application. Without one, the nightly job only reports.
/// </summary>
public sealed class RetentionPolicy
{
    public string DataClass { get; init; } = string.Empty;

    public int RetainDays { get; init; }

    public string ApprovedBy { get; init; } = string.Empty;

    public DateTimeOffset ApprovedAt { get; init; }

    public string Reference { get; init; } = string.Empty;
}

public enum RetentionMode
{
    /// <summary>Counts what each period would remove; changes nothing. The default until EXT-07.</summary>
    DryRun,

    /// <summary>Removes, in bounded batches, what an approved policy says is due.</summary>
    Apply,
}

/// <summary>One night of retention: the mode, and per data class what was due and what was done (JSON).</summary>
public sealed class RetentionRun : Entity
{
    private RetentionRun() { }

    public DateTimeOffset StartedAt { get; private set; }

    public DateTimeOffset? FinishedAt { get; private set; }

    public RetentionMode Mode { get; private set; }

    public string ReportJson { get; private set; } = "[]";

    public bool Failed { get; private set; }

    public static RetentionRun Start(RetentionMode mode, DateTimeOffset at) => new() { Mode = mode, StartedAt = at };

    public void Finish(string reportJson, bool failed, DateTimeOffset at)
    {
        ReportJson = reportJson;
        Failed = failed;
        FinishedAt = at;
    }
}
