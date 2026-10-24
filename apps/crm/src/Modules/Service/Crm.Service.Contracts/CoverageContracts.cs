using System.Text.Json;

namespace Crm.Service.Contracts;

/// <summary>
/// A rule that finds a gap in what watches the customers (M40): an Atera agent that has gone silent now; from M41 a machine with
/// Atera but without Huntress (or the other way round) and Defender switched off; from M42 a backup that failed, is older than
/// 26 hours or paused, and a licensed user who is not backed up. A rule is checked only after a complete read of its
/// <see cref="System"/>, so a read that failed or stopped part-way finds nothing and closes nothing. A module that keeps the data a
/// rule needs registers the rule; the Service module stores what it finds as alerts of <see cref="CoverageGaps.System"/>.
/// </summary>
public interface ICoverageRule
{
    /// <summary>A stable code, the first part of each gap's id and the key of its setting: <c>atera.agent-silent</c>.</summary>
    string Code { get; }

    /// <summary>The source whose complete read lets the rule check, as its mirrors spell it (<c>atera</c>).</summary>
    string System { get; }

    /// <summary>What a gap leaves unwatched: device monitoring, security or backup.</summary>
    AlertKind Kind { get; }

    /// <summary>The limit a person may set (days an agent may be silent), or null for a rule without one.</summary>
    CoverageThreshold? Threshold { get; }

    /// <summary>
    /// Everything the rule finds now among the organizations the read covered, one finding per subject; an empty list is a clean
    /// check. The rule reads stored data only: it never calls a provider.
    /// </summary>
    Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken);
}

/// <summary>
/// Checks the coverage rules of a source after a complete read of it that covered <c>organizations</c> (M40): what they find opens
/// or keeps a gap alert, and a gap no longer found closes after <see cref="CoverageGaps.CleanChecksToClose"/> clean checks in a row.
/// The reader of the source calls it at the end of its complete read; a failed or partial read never does.
/// </summary>
public interface ICoverageCheck
{
    Task<CoverageCheckResult> CheckAsync(string system, IReadOnlyCollection<Guid> organizations, CancellationToken cancellationToken);
}

public enum CoverageUnit
{
    Days,
    Hours,
}

/// <summary>A rule's limit: its value until a person sets another, and the range a person may choose from.</summary>
public sealed record CoverageThreshold(int Default, int Min, int Max, CoverageUnit Unit);

/// <summary>
/// One check of a rule: its time, the limit in force (null for a rule without one) and the organizations the complete read covered.
/// A gap of an organization outside them is not found, so it closes like any gap that is gone.
/// </summary>
public sealed record CoverageCheck(DateTimeOffset Now, int? Threshold, IReadOnlyCollection<Guid> Organizations);

/// <summary>
/// One gap a rule found. <paramref name="Subject"/> is what it is about (a device id), unique within the rule. <paramref name="Facts"/>
/// are plain values the interface words in the reader's language (times as ISO 8601 text); <paramref name="Title"/> is the English
/// sentence kept for readers that do not know the rule.
/// </summary>
public sealed record CoverageFinding(
    string Subject,
    Guid OrganizationId,
    AlertSeverity Severity,
    string Title,
    string? DeviceName,
    Guid? DeviceId,
    IReadOnlyDictionary<string, string> Facts);

/// <summary>What one check of a source's rules changed.</summary>
public sealed record CoverageCheckResult(int Rules, int Found, int Opened, int Reopened, int Resolved)
{
    public static CoverageCheckResult None { get; } = new(0, 0, 0, 0, 0);

    public static CoverageCheckResult operator +(CoverageCheckResult a, CoverageCheckResult b) =>
        new(a.Rules + b.Rules, a.Found + b.Found, a.Opened + b.Opened, a.Reopened + b.Reopened, a.Resolved + b.Resolved);
}

/// <summary>The alerts the CRM itself raises (M40): coverage gaps. They carry this system, so no source's read ever touches them.</summary>
public static class CoverageGaps
{
    public const string System = "parasoll";

    /// <summary>A gap closes after this many complete checks in a row that no longer find it.</summary>
    public const int CleanChecksToClose = 2;

    /// <summary>A gap's stored facts as plain values; none for an alert a source reported, or facts that cannot be read.</summary>
    public static IReadOnlyDictionary<string, string>? ReadFacts(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
