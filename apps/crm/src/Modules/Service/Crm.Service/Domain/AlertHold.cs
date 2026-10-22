using Crm.SharedKernel.Domain;

namespace Crm.Service.Domain;

/// <summary>
/// The CRM's own status of one alert (M40): hidden in Parasoll until a time, with the reason a person gave. A row of its own,
/// created with the alert and sharing its id: every read of the source moves the alert's last-seen time and with it the alert's
/// row version, so a person's decision is checked against this row's version, which only a decision or the alert opening again
/// changes. What people did is kept in <see cref="AlertTransition"/>.
/// </summary>
public sealed class AlertHold : Entity
{
    public const int ReasonLength = 500;

    private AlertHold() { }

    internal AlertHold(Guid alertId) : base(alertId) { }

    /// <summary>Hidden until this time; empty while nobody has hidden the alert, or since it was shown again.</summary>
    public DateTimeOffset? Until { get; private set; }

    public string? Reason { get; private set; }
    public Guid? By { get; private set; }
    public DateTimeOffset? At { get; private set; }

    internal void Set(DateTimeOffset until, string reason, Guid? by, DateTimeOffset now)
    {
        Until = until;
        Reason = reason.Length > ReasonLength ? reason[..ReasonLength] : reason;
        By = by;
        At = now;
    }

    internal void Clear()
    {
        Until = null;
        Reason = null;
        By = null;
        At = null;
    }
}
