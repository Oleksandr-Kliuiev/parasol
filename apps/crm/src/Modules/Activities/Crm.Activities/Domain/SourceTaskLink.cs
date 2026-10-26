using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Activities.Contracts;
using Crm.Service.Contracts;

namespace Crm.Activities.Domain;

/// <summary>
/// Permanent receipt: a removed Task must never free its source for accidental recreation. The columns keep the names of their first
/// use (WorkspaceId, ClientId, ObservationId); the properties say what they hold now. A receipt of a system the CRM no longer reads
/// stays as history and does nothing: no source button, no source read, no new task for it.
/// </summary>
public sealed class SourceTaskLink
{
    public required string SourceKey { get; init; }
    public Guid ActivityId { get; init; }
    public required string System { get; init; }
    public required string SourceKind { get; init; }
    public required string ExternalCustomerId { get; init; }
    public required string ExternalId { get; init; }
    public required string TargetKind { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public Guid CreatedBy { get; init; }
    public SourceTaskIdentity Source => new(System, SourceKind, ExternalCustomerId, ExternalId, TargetKind);
}

internal static class SourceTaskIdentityRules
{
    /// <summary>
    /// The systems whose items become tasks today, spelled as their mirrors spell them (M38: Atera alerts; M40: the coverage gaps
    /// the CRM itself finds; M41: Huntress's incidents, escalations and platform actions).
    /// </summary>
    internal static readonly FrozenSet<string> SupportedSystems = new[] { "atera", "huntress", CoverageGaps.System }.ToFrozenSet(StringComparer.Ordinal);

    internal const string AlertKind = "alert";
    internal const string TaskTarget = "Task";

    /// <summary>A task subject is the activity's subject column.</summary>
    internal const int SubjectLength = 256;

    internal static bool IsSupported(string? system) => system is not null && SupportedSystems.Contains(system);

    internal static bool IsValid(SourceTaskIdentity? source) => IsValid(source, SupportedSystems);

    /// <summary>A supported system, an alert made into a task, and both ids plain, bounded and case-exact.</summary>
    internal static bool IsValid(SourceTaskIdentity? source, IReadOnlySet<string> systems) => source is not null
        && systems.Contains(source.System) && source.SourceKind == AlertKind && source.TargetKind == TaskTarget
        && Id(source.ExternalCustomerId, 128) && Id(source.ExternalId, 256);

    private static bool Id(string? value, int maximum) => value is not null && value.Length <= maximum
        && Regex.IsMatch(value, @"\A[A-Za-z0-9._:-]+\z", RegexOptions.CultureInvariant);

    /// <summary>The source of an alert as the receipt names it: never the CRM alert id, which a rebuilt mirror would not keep.</summary>
    internal static SourceTaskIdentity ForAlert(string system, string externalCustomerId, string externalId) =>
        new(system, AlertKind, externalCustomerId, externalId, TaskTarget);

    internal static string Key(SourceTaskIdentity source) => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
        new[] { "SourceTaskV1", source.System, source.SourceKind, source.ExternalCustomerId, source.ExternalId, source.TargetKind })));

    /// <summary>The subject the employee confirmed: trimmed, not empty, within the column and free of control characters.</summary>
    internal static string? Subject(string? subject) => subject?.Trim() is { Length: > 0 and <= SubjectLength } trimmed
        && !trimmed.Any(char.IsControl) ? trimmed : null;

    /// <summary>The subject a dialog offers for an alert: its title on one line, cut to the column at a word where one is near.</summary>
    internal static string SuggestedSubject(string title)
    {
        var line = string.Join(' ', new string([.. title.Select(c => char.IsControl(c) ? ' ' : c)])
            .Split(' ', StringSplitOptions.RemoveEmptyEntries));
        if (line.Length <= SubjectLength) return line;
        var cut = line[..SubjectLength];
        var space = cut.LastIndexOf(' ');
        return (space >= SubjectLength - 40 ? cut[..space] : cut).TrimEnd();
    }
}
