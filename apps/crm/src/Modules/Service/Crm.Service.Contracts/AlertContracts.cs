namespace Crm.Service.Contracts;

/// <summary>Where an alert is: open in its source, open and seen by someone in the CRM, or no longer reported open.</summary>
public enum AlertState
{
    Open,
    Acknowledged,
    Resolved,
}

/// <summary>What watches the customer: device monitoring (Atera), security (Huntress) or backup (CloudAlly).</summary>
public enum AlertKind
{
    Monitoring,
    Security,
    Backup,
}

/// <summary>
/// An open alert as read from its source, with the CRM organization its customer is linked to. <paramref name="Url"/> comes from
/// the integration's configuration only, never from a guess about the provider's addresses. <paramref name="DeviceExternalId"/> and
/// <paramref name="DeviceAlternateId"/> name the source's agent exactly when the source says which (M40). With
/// <paramref name="ConfirmClose"/> a critical alert that the source closes waits for a person to confirm it (M41: an urgent Huntress
/// incident) instead of closing by itself.
/// </summary>
public sealed record ExternalAlert(
    string ExternalId,
    Guid OrganizationId,
    AlertSeverity Severity,
    string Title,
    string? DeviceName,
    DateTimeOffset CreatedAt,
    string? ExternalCustomerId = null,
    string? Url = null,
    string? DeviceExternalId = null,
    string? DeviceAlternateId = null,
    bool ConfirmClose = false);

/// <summary>
/// One read of the open alerts of a source (<paramref name="System"/> and <paramref name="Kind"/>). <paramref name="Alerts"/> are
/// those whose customer is linked to an organization; <paramref name="OpenExternalIds"/> are all the source reported open, linked
/// or not, so an alert whose customer lost its link is not taken for resolved. <paramref name="IsComplete"/> is true only when
/// every page was read: a failed or partial read proves nothing about what it did not list, so applying it changes nothing.
/// </summary>
public sealed record AlertSnapshot(
    string System,
    AlertKind Kind,
    IReadOnlyCollection<ExternalAlert> Alerts,
    IReadOnlyCollection<string> OpenExternalIds,
    bool IsComplete);

/// <summary>
/// What applying a snapshot changed. A refreshed last-seen time alone is not a change. <paramref name="AwaitingConfirmation"/> counts
/// the critical alerts the source closed that now wait for a person (M41).
/// </summary>
public sealed record AlertSnapshotResult(bool Applied, int Opened, int Reopened, int Updated, int Resolved, int AwaitingConfirmation = 0)
{
    /// <summary>An incomplete snapshot: nothing was read into the mirror and nothing was resolved.</summary>
    public static AlertSnapshotResult NotApplied { get; } = new(false, 0, 0, 0, 0);

    public int Changed => Opened + Reopened + Updated + Resolved + AwaitingConfirmation;
}

/// <summary>
/// A stored alert for other modules (a task made from it, My day). The id stays the same from one read to the next;
/// <paramref name="ResolvedAt"/> is when a complete read no longer listed it. A coverage gap (M40) names its <paramref name="Rule"/>
/// and its <paramref name="Facts"/> as one JSON object (<see cref="CoverageGaps.ReadFacts"/>). <paramref name="SourceClosedAt"/> is
/// when the source closed a critical alert that waits for a person to confirm it (M41).
/// </summary>
public sealed record AlertRef(
    Guid Id,
    Guid OrganizationId,
    string System,
    AlertKind Kind,
    string ExternalId,
    string? ExternalCustomerId,
    string Title,
    AlertSeverity Severity,
    AlertState State,
    string? DeviceName,
    Guid? DeviceId,
    DateTimeOffset CreatedAtSource,
    string? Url,
    DateTimeOffset? ResolvedAt = null,
    string? Rule = null,
    string? Facts = null,
    DateTimeOffset? SourceClosedAt = null);
