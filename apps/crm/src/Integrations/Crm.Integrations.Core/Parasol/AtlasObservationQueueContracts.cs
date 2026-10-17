using System.Text.RegularExpressions;

namespace Crm.Integrations.Core.Parasol;

public enum AtlasQueueSeverity { ALL, URGENT, INFO, LOW, MEDIUM, HIGH, CRITICAL }
public enum AtlasQueueStatus { ACTIVE, OPEN, ACKNOWLEDGED, RESOLVED, SUPPRESSED }

public sealed record AtlasObservationSelection(AtlasQueueSeverity Severity, AtlasQueueStatus Status, string? DeviceId = null)
{
    internal string[] Severities => Severity switch
    {
        AtlasQueueSeverity.ALL => AtlasProjectionJson.Severities,
        AtlasQueueSeverity.URGENT => ["HIGH", "CRITICAL"],
        _ => [Severity.ToString()],
    };
    internal string[] Statuses => Status == AtlasQueueStatus.ACTIVE ? ["OPEN", "ACKNOWLEDGED"] : [Status.ToString()];
    internal string AtlasSeverities => string.Join(',', Severities);
    internal string AtlasStatuses => string.Join(',', Statuses);
    internal bool IsValid => Enum.IsDefined(Severity) && Enum.IsDefined(Status) && IsDeviceIdValid(DeviceId);
    private static bool IsDeviceIdValid(string? value) => value is null || value.Length <= 256
        && !string.IsNullOrWhiteSpace(value)
        && Regex.IsMatch(value, @"\A(?:[^\p{Cc}\p{Cs}]|[\uD800-\uDBFF][\uDC00-\uDFFF])+\z", RegexOptions.CultureInvariant);

    internal static AtlasObservationSelection? Parse(string? severity, string? status, string? deviceId = null) =>
        Enum.TryParse<AtlasQueueSeverity>(severity ?? "ALL", out var s) && Enum.IsDefined(s) && s.ToString() == (severity ?? "ALL")
        && Enum.TryParse<AtlasQueueStatus>(status ?? "ACTIVE", out var t) && Enum.IsDefined(t) && t.ToString() == (status ?? "ACTIVE")
        && IsDeviceIdValid(deviceId) ? new(s, t, deviceId) : null;
}

public sealed record AtlasObservationQueueView(Guid CustomerId, string Status, AtlasObservationQueue? Queue = null);
public sealed record AtlasObservationQueue(string Mode, DateTimeOffset GeneratedAt, DateTimeOffset RetrievedAt,
    string Severity, string Status, int Total, IReadOnlyDictionary<string, int> SeverityCounts,
    IReadOnlyList<AtlasObservationView> Items, IReadOnlyList<AtlasDeviceView> Devices,
    IReadOnlyList<AtlasResourceSummary> Resources, string? NextCursor, string? DeviceId = null);

internal sealed record AtlasObservationQueuePage(int Total, IReadOnlyDictionary<string, int> SeverityCounts,
    IReadOnlyList<AtlasObservationView> Items, string? NextCursor);
