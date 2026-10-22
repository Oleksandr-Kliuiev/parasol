using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Service.Domain;

/// <summary>
/// An alert of a monitoring source, mirrored with a lifecycle (M38) so that its id stays the same from one read to the next: a
/// complete read that no longer lists it resolves it, and a later read that lists it again opens it again. The CRM's own status
/// lies over the mirrored state and never writes it (M40): an alert can be hidden in Parasoll until a date, in its
/// <see cref="AlertHold"/>. Not audited: the source is the system of record, and what people do with an alert is kept in
/// <see cref="AlertTransition"/>.
/// </summary>
public sealed class Alert : Entity
{
    public const int TitleLength = 512;
    public const int DeviceNameLength = 256;
    public const int UrlLength = 512;

    private Alert() { }

    public string System { get; private set; } = string.Empty;
    public string ExternalId { get; private set; } = string.Empty;
    public AlertKind Kind { get; private set; }
    public Guid OrganizationId { get; private set; }

    /// <summary>The source's own id of the customer the alert belongs to (an Atera customer id).</summary>
    public string? ExternalCustomerId { get; private set; }

    public AlertSeverity Severity { get; private set; }
    public AlertState State { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public string? DeviceName { get; private set; }

    /// <summary>The CRM device the alert is about, set only when exactly one device of the customer carries its name.</summary>
    public Guid? DeviceId { get; private set; }

    public string? Url { get; private set; }
    public DateTimeOffset CreatedAtSource { get; private set; }

    /// <summary>When a read last listed the alert as open; empty for alerts stored before the lifecycle existed.</summary>
    public DateTimeOffset? LastSeenAt { get; private set; }

    public DateTimeOffset? ResolvedAt { get; private set; }

    /// <summary>
    /// The CRM's own status (M40): hidden in Parasoll until a time; the alert stays as it is in its source and comes back by itself.
    /// Loaded with the alert wherever a read may open it again or a person decides about it. Empty only for an alert an earlier
    /// release stored on this schema (a rollback in between): the next read that lists it, or the first decision about it, adds it.
    /// </summary>
    public AlertHold? Hold { get; private set; }

    /// <summary>Hidden now: the alert is not resolved and the time it was hidden until has not come.</summary>
    public bool IsHidden(DateTimeOffset now) => State != AlertState.Resolved && Hold?.Until > now;

    /// <summary>
    /// The alert's hold, added when an earlier release stored the alert without one. Call it only with the hold loaded: an alert
    /// read without it would get a second one.
    /// </summary>
    public AlertHold EnsureHold() => Hold ??= new AlertHold(Id);

    public static Alert Open(string system, AlertKind kind, ExternalAlert source, Guid? deviceId, DateTimeOffset now)
    {
        var alert = new Alert { System = system, ExternalId = source.ExternalId, State = AlertState.Open };
        alert.Hold = new AlertHold(alert.Id);
        alert.Observe(kind, source, deviceId, now);
        return alert;
    }

    /// <summary>
    /// A read lists the alert as open: its fields follow the source, a resolved alert opens again and an acknowledged one keeps
    /// its acknowledgement. The last-seen time always moves; it alone is not reported as a change.
    /// </summary>
    public AlertChange Observe(AlertKind kind, ExternalAlert source, Guid? deviceId, DateTimeOffset now)
    {
        var before = Signature();
        Kind = kind;
        OrganizationId = source.OrganizationId;
        ExternalCustomerId = source.ExternalCustomerId;
        Severity = source.Severity;
        Title = Cut(source.Title, TitleLength)!;
        DeviceName = Cut(source.DeviceName, DeviceNameLength);
        DeviceId = deviceId;
        // A link that does not fit is left out rather than cut into an address that leads somewhere else.
        Url = source.Url is { Length: <= UrlLength } url ? url : null;
        CreatedAtSource = source.CreatedAt;
        LastSeenAt = now;
        if (State == AlertState.Resolved)
        {
            // A new occurrence: what someone decided about the last one does not hide it.
            State = AlertState.Open;
            ResolvedAt = null;
            Hold?.Clear();
            return AlertChange.Reopened;
        }

        return before == Signature() ? AlertChange.None : AlertChange.Updated;
    }

    /// <summary>Hides the alert in Parasoll until <paramref name="until"/>, with the reason a person gave.</summary>
    public void Hide(DateTimeOffset until, string reason, Guid? by, DateTimeOffset now) => EnsureHold().Set(until, reason, by, now);

    /// <summary>Shows a hidden alert again. Returns false when it was not hidden.</summary>
    public bool Unhide(DateTimeOffset now)
    {
        if (!IsHidden(now))
        {
            return false;
        }

        EnsureHold().Clear();
        return true;
    }

    /// <summary>A complete read no longer lists the alert. Returns false when it was resolved already.</summary>
    public bool Resolve(DateTimeOffset now)
    {
        if (State == AlertState.Resolved)
        {
            return false;
        }

        State = AlertState.Resolved;
        ResolvedAt = now;
        return true;
    }

    private static string? Cut(string? value, int length) => value is { } text && text.Length > length ? text[..length] : value;

    private string Signature() => string.Join('|', Kind, OrganizationId, ExternalCustomerId, Severity, Title, DeviceName, DeviceId, Url,
        CreatedAtSource.ToUnixTimeSeconds());
}

/// <summary>What a read that lists an alert did to it.</summary>
public enum AlertChange
{
    None,
    Updated,
    Reopened,
}
