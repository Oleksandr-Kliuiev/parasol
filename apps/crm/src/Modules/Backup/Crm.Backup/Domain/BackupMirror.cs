using System.Globalization;
using Crm.Backup.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Backup.Domain;

/// <summary>
/// A customer's backup account at the source (M42): CloudAlly's account of one organization, as the latest complete read reported
/// it. A mirror: the source is the master, nothing here is changed by people, and what a complete read no longer reports is
/// forgotten with its tasks and entities.
/// </summary>
public sealed class BackupAccount : Entity
{
    public const int NameLength = 256;

    private BackupAccount() { }

    public string System { get; private set; } = string.Empty;
    public string ExternalId { get; private set; } = string.Empty;
    public Guid OrganizationId { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string? Email { get; private set; }
    public string? Status { get; private set; }
    public string? Region { get; private set; }
    public DateTimeOffset FirstSeenAt { get; private set; }
    public DateTimeOffset LastSeenAt { get; private set; }
    public List<BackupTask> Tasks { get; private set; } = [];

    public static BackupAccount From(string system, Guid organizationId, ExternalBackupAccount source, DateTimeOffset now)
    {
        var account = new BackupAccount { System = system, ExternalId = source.ExternalId, FirstSeenAt = now };
        account.Apply(organizationId, source, now);
        return account;
    }

    public void Apply(Guid organizationId, ExternalBackupAccount s, DateTimeOffset now)
    {
        OrganizationId = organizationId;
        Name = Text.Fit(s.Name, NameLength) ?? s.ExternalId;
        Email = Text.Fit(s.Email, NameLength);
        Status = Text.Code(s.Status);
        Region = Text.Code(s.Region);
        LastSeenAt = now;
    }
}

/// <summary>One service of an account (its mailboxes, its OneDrives, its sites, its teams) as the source backs it up.</summary>
public sealed class BackupTask : Entity
{
    public const int NextBackupLength = 128;

    private BackupTask() { }

    public Guid AccountId { get; private set; }
    public string ExternalId { get; private set; } = string.Empty;
    public BackupService Service { get; private set; }
    public string Source { get; private set; } = string.Empty;
    public string? Alias { get; private set; }
    public string? Status { get; private set; }
    public bool Running { get; private set; }
    public DateTimeOffset? LastBackupAt { get; private set; }
    public string? NextBackup { get; private set; }
    public int? EntityCount { get; private set; }
    public int? BilledEntities { get; private set; }
    public long? SizeBytes { get; private set; }
    public DateTimeOffset FirstSeenAt { get; private set; }
    public DateTimeOffset LastSeenAt { get; private set; }
    public List<BackupEntity> Entities { get; private set; } = [];

    /// <summary>The task's scheduled backups are stopped until someone activates it again.</summary>
    public bool IsPaused => BackupStatuses.IsPaused(Status);

    public static BackupTask From(Guid accountId, ExternalBackupTask source, DateTimeOffset now)
    {
        var task = new BackupTask { AccountId = accountId, ExternalId = source.ExternalId, FirstSeenAt = now };
        task.Apply(source, now);
        return task;
    }

    public void Apply(ExternalBackupTask s, DateTimeOffset now)
    {
        Service = s.Service;
        Source = Text.Code(s.Source) ?? "?";
        Alias = Text.Fit(s.Alias, BackupAccount.NameLength);
        Status = Text.Code(s.Status);
        Running = s.Running;
        LastBackupAt = s.LastBackupAt;
        NextBackup = Text.Fit(s.NextBackup, NextBackupLength);
        EntityCount = s.EntityCount;
        BilledEntities = s.BilledEntities;
        SizeBytes = s.SizeBytes;
        LastSeenAt = now;
    }
}

/// <summary>
/// A mailbox, OneDrive, site or team inside a task, with its last backup. Its name and the person's name are personal data of the
/// customer's staff, kept only while the source reports the entity (04 §9).
/// </summary>
public sealed class BackupEntity : Entity
{
    public const int ErrorLength = 512;
    public const int LinkLength = 512;

    private BackupEntity() { }

    public Guid TaskId { get; private set; }
    public string ExternalId { get; private set; } = string.Empty;
    public string Name { get; private set; } = string.Empty;
    public string? FullName { get; private set; }
    public string? ExtId { get; private set; }
    public string? Status { get; private set; }
    public bool Running { get; private set; }
    public DateTimeOffset? LastBackupAt { get; private set; }
    public DateTimeOffset? LastAttemptAt { get; private set; }
    public string? Error { get; private set; }

    /// <summary>The source's help page for the error; only an https address is kept.</summary>
    public string? ErrorLink { get; private set; }

    /// <summary>Whether Microsoft licenses the mailbox, as the source reports it (LICENSED, UNLICENSED, NA).</summary>
    public string? Licensing { get; private set; }

    public long? SizeBytes { get; private set; }
    public DateTimeOffset FirstSeenAt { get; private set; }
    public DateTimeOffset LastSeenAt { get; private set; }

    public static BackupEntity From(Guid taskId, ExternalBackupEntity source, DateTimeOffset now)
    {
        var entity = new BackupEntity { TaskId = taskId, ExternalId = source.ExternalId, FirstSeenAt = now };
        entity.Apply(source, now);
        return entity;
    }

    public void Apply(ExternalBackupEntity s, DateTimeOffset now)
    {
        Name = Text.Fit(s.Name, BackupAccount.NameLength) ?? s.ExternalId;
        FullName = Text.Fit(s.FullName, BackupAccount.NameLength);
        ExtId = Text.Fit(s.ExtId, BackupAccount.NameLength);
        Status = Text.Code(s.Status);
        Running = s.Running;
        LastBackupAt = s.LastBackupAt;
        LastAttemptAt = s.LastAttemptAt;
        Error = Text.Fit(s.Error, ErrorLength);
        ErrorLink = Uri.TryCreate(s.ErrorLink, UriKind.Absolute, out var link) && link.Scheme == Uri.UriSchemeHttps && s.ErrorLink!.Length <= LinkLength
            ? s.ErrorLink
            : null;
        Licensing = Text.Code(s.Licensing);
        SizeBytes = s.SizeBytes;
        LastSeenAt = now;
    }

    /// <summary>
    /// What a read of the task alone says, after an action: the state, whether a backup runs and a newer last backup. The last
    /// attempt, the error and the licensing come only with the status list of a complete read, so they stay as they were.
    /// </summary>
    public void ApplyLive(ExternalBackupEntity s, DateTimeOffset now)
    {
        Status = Text.Code(s.Status);
        Running = s.Running;
        if (s.LastBackupAt is { } last && (LastBackupAt is not { } stored || last > stored))
        {
            LastBackupAt = last;
        }

        LastSeenAt = now;
    }
}

/// <summary>
/// One line of what the source billed the partner for an account, as read on a day (M42): cost data, read by finance only. The key
/// <c>{system}:{account}:{day}:{type}:{source}:{service}</c> makes a second read of the same day a replacement, never a second line.
/// </summary>
public sealed class BackupBillLine : Entity
{
    public const int KeyLength = 400;

    private BackupBillLine() { }

    public string LineKey { get; private set; } = string.Empty;
    public string System { get; private set; } = string.Empty;
    public string AccountExternalId { get; private set; } = string.Empty;
    public Guid? OrganizationId { get; private set; }
    public DateOnly Day { get; private set; }
    public string Type { get; private set; } = string.Empty;
    public string Source { get; private set; } = string.Empty;
    public string? Service { get; private set; }
    public int? Accounts { get; private set; }
    public int? Seats { get; private set; }
    public decimal? Price { get; private set; }
    public decimal? Total { get; private set; }
    public string? Currency { get; private set; }
    public string? PaymentType { get; private set; }
    public DateTimeOffset? NextPaymentAt { get; private set; }
    public DateTimeOffset ReadAt { get; private set; }

    public static string KeyOf(string system, DateOnly day, ExternalBackupBillLine line) => string.Create(CultureInfo.InvariantCulture,
        $"{system}:{line.AccountExternalId}:{day:yyyy-MM-dd}:{line.Type}:{line.Source}:{line.Service}");

    public static BackupBillLine From(string system, DateOnly day, ExternalBackupBillLine line, DateTimeOffset now)
    {
        var bill = new BackupBillLine { LineKey = KeyOf(system, day, line), System = system, Day = day };
        bill.Apply(line, now);
        return bill;
    }

    public void Apply(ExternalBackupBillLine line, DateTimeOffset now)
    {
        AccountExternalId = line.AccountExternalId;
        OrganizationId = line.OrganizationId;
        Type = Text.Code(line.Type) ?? "?";
        Source = Text.Code(line.Source) ?? "?";
        Service = Text.Fit(line.Service, BackupAccount.NameLength);
        Accounts = line.Accounts;
        Seats = line.Seats;
        Price = line.Price is { } price ? decimal.Round(price, 4) : null;
        Total = line.Total is { } total ? decimal.Round(total, 2) : null;
        Currency = Text.Fit(line.Currency?.ToUpperInvariant(), 3);
        PaymentType = Text.Code(line.PaymentType);
        NextPaymentAt = line.NextPaymentAt;
        ReadAt = now;
    }
}

/// <summary>The source's status words that mean something to the CRM (CloudAlly's task and entity statuses).</summary>
public static class BackupStatuses
{
    public static bool IsPaused(string? status) => string.Equals(status, "PAUSED", StringComparison.OrdinalIgnoreCase);

    /// <summary>Known to the source but not backed up: a user someone has to add.</summary>
    public static bool IsNotActive(string? status) => string.Equals(status, "NOTACTIVE", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Not this task's to watch: backed up in another task, archived (gone from the tenant, the backup kept) or skipped by the
    /// source. Such entities count neither as backed up nor as missing.
    /// </summary>
    public static bool IsAside(string? status) => status?.ToUpperInvariant() is "IN_ANOTHER" or "ARCHIVED" or "SKIPPED" or "ON_PREMISE";
}

internal static class Text
{
    public const int CodeLength = 64;

    public static string? Fit(string? value, int length)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim();
        return trimmed.Length <= length ? trimmed : trimmed[..length];
    }

    /// <summary>A word of the source's vocabulary (a status, a region), upper case so SQL and code compare it alike.</summary>
    public static string? Code(string? value) => Fit(value?.ToUpperInvariant(), CodeLength);
}
