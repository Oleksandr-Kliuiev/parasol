namespace Crm.Infrastructure.Persistence;

public static class AuditActions
{
    public const string Create = "Create";
    public const string Update = "Update";
    public const string Delete = "Delete";
    public const string Export = "Export";
    public const string Login = "Login";
    public const string Merge = "Merge";
    public const string TriggerJob = "TriggerJob";

    /// <summary>A person sent dead or quarantined outbox messages (or a failed outbound operation) back for delivery (DEV-07).</summary>
    public const string Replay = "Replay";

    /// <summary>A person withdrew a queued outbound operation (DEV-07).</summary>
    public const string Cancel = "Cancel";

    /// <summary>The retention procedure removed the personal part of older entries (DEV-04, written by audit.ApplyRetention).</summary>
    public const string Retention = "Retention";
}

/// <summary>
/// Row of <c>audit.AuditEntries</c>. The table is owned (migrated) by the Audit module; every module context maps it
/// with ExcludeFromMigrations so audit rows are written in the same transaction as the change.
/// </summary>
public sealed class AuditEntry
{
    public long Id { get; init; }
    public DateTimeOffset At { get; init; }
    public Guid? UserId { get; init; }
    public string? UserName { get; init; }
    public required string Action { get; init; }
    public required string Module { get; init; }
    public required string EntityType { get; init; }
    public Guid EntityId { get; init; }
    public string? Changes { get; init; }
    public string? CorrelationId { get; init; }
    public string? IpAddress { get; init; }
}
