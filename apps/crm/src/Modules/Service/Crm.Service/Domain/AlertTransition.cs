using Crm.SharedKernel.Domain;

namespace Crm.Service.Domain;

/// <summary>What a person did to an alert in Parasoll (M40).</summary>
public enum AlertTransitionKind
{
    /// <summary>Hidden until a date, with a reason; the source still shows the alert open.</summary>
    Hidden,

    /// <summary>Shown again before the date it was hidden until.</summary>
    Shown,

    /// <summary>The source closed an urgent alert, and a person confirmed the closing here (M41).</summary>
    Confirmed,
}

/// <summary>
/// One change a person made to an alert's status in Parasoll (M40): the history the alert's panel shows and the audit trail of
/// the change. Rows are only added; they go with their alert when retention removes it.
/// </summary>
public sealed class AlertTransition : AuditableEntity
{
    private AlertTransition() { }

    public Guid AlertId { get; private set; }
    public AlertTransitionKind Kind { get; private set; }

    /// <summary>The time a hidden alert comes back by itself.</summary>
    public DateTimeOffset? Until { get; private set; }

    public string? Reason { get; private set; }

    public static AlertTransition Hidden(Guid alertId, DateTimeOffset until, string reason) =>
        new() { AlertId = alertId, Kind = AlertTransitionKind.Hidden, Until = until, Reason = reason };

    public static AlertTransition Shown(Guid alertId) => new() { AlertId = alertId, Kind = AlertTransitionKind.Shown };

    public static AlertTransition Confirmed(Guid alertId) => new() { AlertId = alertId, Kind = AlertTransitionKind.Confirmed };
}
