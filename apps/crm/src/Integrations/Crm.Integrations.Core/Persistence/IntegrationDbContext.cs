using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Persistence;

public enum SyncRunStatus
{
    Running,
    Succeeded,
    Failed,

    /// <summary>The integration was paused when the job fell due (runbook 05), so nothing was read or written.</summary>
    Skipped,
}

/// <summary>
/// A pause on one external system (runbook 05): jobs and outbound operations of that system are held without a deploy,
/// which is what an incident needs — the configuration flags require a restart.
/// </summary>
public sealed class IntegrationSwitch
{
    public required string System { get; init; }
    public bool IsPaused { get; set; }
    public string? Reason { get; set; }
    public string? PausedBy { get; set; }
    public DateTimeOffset? PausedAt { get; set; }
}

/// <summary>One execution of a synchronization job (docs/03-architecture.md §7.2, <c>integration.SyncRun</c>).</summary>
public sealed class SyncRun
{
    public Guid Id { get; init; }
    public required string System { get; init; }
    public required string Job { get; init; }
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? FinishedAt { get; set; }
    public SyncRunStatus Status { get; set; }
    public int Read { get; set; }
    public int Changed { get; set; }
    public int Failed { get; set; }
    public string? Message { get; set; }
}

/// <summary>Position of an incremental synchronization, e.g. a Graph delta link or a lastChanged timestamp.</summary>
public sealed class SyncCursor
{
    public required string System { get; init; }
    public required string Stream { get; init; }
    public string? Value { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public enum LinkMethod
{
    /// <summary>Linked automatically by an unambiguous key (org number, e-mail).</summary>
    Automatic,

    /// <summary>Linked by an administrator on the mapping screen.</summary>
    Manual,

    /// <summary>The CRM record was created from the external record.</summary>
    Imported,

    /// <summary>The external record was created from the CRM record.</summary>
    Exported,
}

/// <summary>
/// Link between a CRM entity and a record in an external system (<c>integration.ExternalLinks</c>).
/// One CRM entity has at most one record per system and external type, and vice versa.
/// </summary>
public sealed class ExternalLink
{
    public Guid Id { get; init; }
    public required string EntityType { get; init; }
    public Guid EntityId { get; set; }
    public required string System { get; init; }
    public required string ExternalType { get; init; }
    public required string ExternalId { get; init; }
    public LinkMethod Method { get; init; }
    public DateTimeOffset LinkedAt { get; init; }
    public Guid? LinkedBy { get; init; }

    /// <summary>Set when an organization merge moved the link, so undoing the merge can move it back.</summary>
    public Guid? MovedByMergeId { get; set; }
    public Guid? PreviousEntityId { get; set; }
}

/// <summary>
/// Last known state of an external record (<c>integration.ExternalRecords</c>): the payload for mapping and change
/// detection, plus normalized keys used for matching.
/// </summary>
public sealed class ExternalRecord
{
    public Guid Id { get; init; }
    public required string System { get; init; }
    public required string ExternalType { get; init; }
    public required string ExternalId { get; init; }

    /// <summary>For child records (contact persons): the external id of the parent customer.</summary>
    public string? ParentExternalId { get; set; }

    public required string DisplayName { get; set; }
    public string? OrgNumber { get; set; }
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public string? Domain { get; set; }
    public required string Payload { get; set; }
    public required string Hash { get; set; }
    public DateTimeOffset FirstSeenAt { get; init; }
    public DateTimeOffset LastSeenAt { get; set; }
    public DateTimeOffset? ExternalChangedAt { get; set; }

    /// <summary>Archived, deleted or no longer returned by a full scan.</summary>
    public bool IsGone { get; set; }
}

public enum OutboundStatus
{
    Pending,
    Succeeded,
    Failed,
    DeadLetter,
    Cancelled,
}

/// <summary>A change to push to an external system, processed with retries (<c>integration.OutboundOperations</c>).</summary>
public sealed class OutboundOperation
{
    public const int MaxAttempts = 10;

    public Guid Id { get; init; }
    public required string System { get; init; }
    public required string Operation { get; init; }
    public required string EntityType { get; init; }
    public Guid EntityId { get; init; }

    /// <summary>Unique; prevents the same logical change from being queued twice.</summary>
    public required string IdempotencyKey { get; init; }

    public OutboundStatus Status { get; set; }
    public int Attempts { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public Guid? RequestedBy { get; init; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }

    /// <summary>The token of the run holding the lease; only that run records the outcome (DEV-07).</summary>
    public Guid? LeaseOwner { get; set; }

    public DateTimeOffset? CompletedAt { get; set; }
    public string? LastError { get; set; }
    public string? Result { get; set; }
}

public sealed class IntegrationDbContext(DbContextOptions<IntegrationDbContext> options) : ModuleDbContext(options)
{
    internal string? ExclusiveSyncResource { get; set; }

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        base.OnConfiguring(optionsBuilder);
        optionsBuilder.AddInterceptors(SyncExclusiveCommandInterceptor.Instance);
    }

    public const string SchemaName = "integration";

    public override string Schema => SchemaName;

    public DbSet<SyncRun> SyncRuns => Set<SyncRun>();

    public DbSet<IntegrationSwitch> IntegrationSwitches => Set<IntegrationSwitch>();

    public DbSet<SyncCursor> SyncCursors => Set<SyncCursor>();

    public DbSet<ExternalLink> ExternalLinks => Set<ExternalLink>();

    public DbSet<ExternalRecord> ExternalRecords => Set<ExternalRecord>();

    public DbSet<OutboundOperation> OutboundOperations => Set<OutboundOperation>();

    public DbSet<WorkerHeartbeat> WorkerHeartbeats => Set<WorkerHeartbeat>();

    public DbSet<SyncSuccess> SyncSuccesses => Set<SyncSuccess>();

    public DbSet<ExceptionTriage> ExceptionTriages => Set<ExceptionTriage>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<SyncSuccess>(b =>
        {
            b.ToTable("SyncSuccesses");
            b.HasKey(x => new { x.System, x.Job });
            b.Property(x => x.System).HasMaxLength(64);
            b.Property(x => x.Job).HasMaxLength(128);
        });
        modelBuilder.Entity<ExceptionTriage>(b =>
        {
            b.ToTable("ExceptionTriages");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Key).HasMaxLength(256);
            b.Property(x => x.Category).HasMaxLength(32);
            b.Property(x => x.Source).HasMaxLength(128);
            b.Property(x => x.Kind).HasMaxLength(64);
            b.Property(x => x.RequiredPermission).HasMaxLength(128);
            b.HasIndex(x => x.Key).IsUnique();
            b.Property(x => x.Status).HasMaxLength(16);
            b.Property(x => x.Comment).HasMaxLength(2000);
            b.Property(x => x.RowVersion).IsRowVersion();
            b.HasIndex(x => new { x.Status, x.UpdatedAt });
        });
        modelBuilder.Entity<SyncRun>(b =>
        {
            b.ToTable("SyncRuns");
            b.HasKey(x => x.Id);
            b.Property(x => x.System).HasMaxLength(64);
            b.Property(x => x.Job).HasMaxLength(128);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Message).HasMaxLength(4000);
            b.HasIndex(x => new { x.System, x.Job, x.StartedAt });
        });

        modelBuilder.Entity<WorkerHeartbeat>(b =>
        {
            b.ToTable("WorkerHeartbeats");
            b.HasKey(x => new { x.Component, x.Instance });
            b.Property(x => x.Component).HasMaxLength(32);
            b.Property(x => x.Instance).HasMaxLength(128);
            b.Property(x => x.Detail).HasMaxLength(256);
        });

        modelBuilder.Entity<IntegrationSwitch>(b =>
        {
            b.ToTable("IntegrationSwitches");
            b.HasKey(x => x.System);
            b.Property(x => x.System).HasMaxLength(64);
            b.Property(x => x.Reason).HasMaxLength(512);
            b.Property(x => x.PausedBy).HasMaxLength(256);
        });

        modelBuilder.Entity<ExternalLink>(b =>
        {
            b.ToTable("ExternalLinks");
            b.HasKey(x => x.Id);
            b.Property(x => x.EntityType).HasMaxLength(64);
            b.Property(x => x.System).HasMaxLength(64);
            b.Property(x => x.ExternalType).HasMaxLength(64);
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.Method).HasConversion<string>().HasMaxLength(16);
            b.HasIndex(x => new { x.System, x.ExternalType, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.EntityType, x.EntityId, x.System, x.ExternalType }).IsUnique();
            b.HasIndex(x => x.MovedByMergeId).HasFilter("[MovedByMergeId] IS NOT NULL");
        });

        modelBuilder.Entity<ExternalRecord>(b =>
        {
            b.ToTable("ExternalRecords");
            b.HasKey(x => x.Id);
            b.Property(x => x.System).HasMaxLength(64);
            b.Property(x => x.ExternalType).HasMaxLength(64);
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.ParentExternalId).HasMaxLength(128);
            b.Property(x => x.DisplayName).HasMaxLength(256);
            b.Property(x => x.OrgNumber).HasMaxLength(16);
            b.Property(x => x.Email).HasMaxLength(256);
            b.Property(x => x.Phone).HasMaxLength(32);
            b.Property(x => x.Domain).HasMaxLength(256);
            b.Property(x => x.Hash).HasMaxLength(64);
            b.HasIndex(x => new { x.System, x.ExternalType, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.System, x.ExternalType, x.OrgNumber });
            b.HasIndex(x => new { x.System, x.ExternalType, x.Email });
            b.HasIndex(x => new { x.System, x.ExternalType, x.ParentExternalId });
        });

        modelBuilder.Entity<OutboundOperation>(b =>
        {
            b.ToTable("OutboundOperations");
            b.HasKey(x => x.Id);
            b.Property(x => x.System).HasMaxLength(64);
            b.Property(x => x.Operation).HasMaxLength(64);
            b.Property(x => x.EntityType).HasMaxLength(64);
            b.Property(x => x.IdempotencyKey).HasMaxLength(256);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.LastError).HasMaxLength(4000);
            b.Property(x => x.Result).HasMaxLength(4000);
            b.HasIndex(x => x.IdempotencyKey).IsUnique();
            b.HasIndex(x => new { x.Status, x.NextAttemptAt });
            b.HasIndex(x => new { x.EntityType, x.EntityId });
        });

        modelBuilder.Entity<SyncCursor>(b =>
        {
            b.ToTable("SyncCursors");
            b.HasKey(x => new { x.System, x.Stream });
            b.Property(x => x.System).HasMaxLength(64);
            b.Property(x => x.Stream).HasMaxLength(128);
        });
    }
}

internal sealed class IntegrationDesignTimeFactory() : ModuleDesignTimeFactory<IntegrationDbContext>(IntegrationDbContext.SchemaName);
