namespace Crm.Infrastructure.Persistence;

public static class AuditActions
{
    public const string Create = "Create";
    public const string Update = "Update";
    public const string Delete = "Delete";
    public const string Export = "Export";
    public const string Login = "Login";

    /// <summary>A client application read a financial dataset through the BI API: the dataset and the period, never the rows.</summary>
    public const string Read = "Read";

    /// <summary>A session ended: signed out, ended by the identity provider, or because the account was deactivated. Ids and the reason only.</summary>
    public const string Logout = "Logout";
    public const string Merge = "Merge";
    public const string TriggerJob = "TriggerJob";

    /// <summary>A person sent dead or quarantined outbox messages (or a failed outbound operation) back for delivery (DEV-07).</summary>
    public const string Replay = "Replay";

    /// <summary>A person withdrew a queued outbound operation (DEV-07).</summary>
    public const string Cancel = "Cancel";

    /// <summary>The retention procedure removed the personal part of older entries (DEV-04, written by audit.ApplyRetention).</summary>
    public const string Retention = "Retention";

    /// <summary>
    /// A privacy case replaced or removed a record's personal data (DEV-11): the entry names the case and the fields, never
    /// their values — erasing a person must not copy them into the trail once more.
    /// </summary>
    public const string Erase = "Erase";

    /// <summary>A maintenance decision (DEV-13): read-only on or off, with its reason. The decision itself lives in the document store.</summary>
    public const string Maintenance = "Maintenance";

    /// <summary>An operator applied the restore reconciliation (DEV-13): what it held back is in the stored report it names.</summary>
    public const string Reconcile = "Reconcile";

    /// <summary>A signed-in person signed a record of their own judgement (DEV-22: the Finance sign-off of a parallel pilot month). Ids and hashes only.</summary>
    public const string Sign = "Sign";
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
