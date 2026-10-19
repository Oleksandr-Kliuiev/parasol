namespace Crm.TimeTracking.Domain;

/// <summary>
/// Permanent admission receipt for one employee's explicit create intent. It is committed with the financial row,
/// carries no work text, and survives deletion of the row so an uncertain response cannot create the work again.
/// </summary>
public sealed class TimeEntryCreateReceipt
{
    public Guid ClientRequestId { get; init; }
    public Guid RequestedBy { get; init; }
    public string IntentHash { get; init; } = string.Empty;
    public Guid TimeEntryId { get; init; }
    public DateTimeOffset AcceptedAt { get; init; }
}
