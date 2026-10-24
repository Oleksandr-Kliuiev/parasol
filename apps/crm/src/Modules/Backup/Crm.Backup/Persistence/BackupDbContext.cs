using Crm.Backup.Domain;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Backup.Persistence;

/// <summary>
/// The backup module's schema (M40.S, filled in M42): the customers' backup accounts at CloudAlly, their tasks, the mailboxes,
/// OneDrives, sites and teams in them, and what CloudAlly bills per account. A mirror of the source, written by its reads only.
/// </summary>
public sealed class BackupDbContext(DbContextOptions<BackupDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "backup";

    public override string Schema => SchemaName;

    public DbSet<BackupAccount> Accounts => Set<BackupAccount>();

    public DbSet<BackupTask> Tasks => Set<BackupTask>();

    public DbSet<BackupEntity> Entities => Set<BackupEntity>();

    public DbSet<BackupBillLine> BillLines => Set<BackupBillLine>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<BackupAccount>(b =>
        {
            b.ToTable("Accounts");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.Name).HasMaxLength(BackupAccount.NameLength);
            b.Property(x => x.Email).HasMaxLength(BackupAccount.NameLength);
            b.Property(x => x.Status).HasMaxLength(Text.CodeLength);
            b.Property(x => x.Region).HasMaxLength(Text.CodeLength);
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
            b.HasIndex(x => x.OrganizationId);
            b.HasMany(x => x.Tasks).WithOne().HasForeignKey(x => x.AccountId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<BackupTask>(b =>
        {
            b.ToTable("Tasks");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.Service).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Source).HasMaxLength(Text.CodeLength);
            b.Property(x => x.Alias).HasMaxLength(BackupAccount.NameLength);
            b.Property(x => x.Status).HasMaxLength(Text.CodeLength);
            b.Property(x => x.NextBackup).HasMaxLength(BackupTask.NextBackupLength);
            b.Ignore(x => x.IsPaused);
            // A task id is the source's own; the account it hangs off says which source.
            b.HasIndex(x => new { x.AccountId, x.ExternalId }).IsUnique();
            b.HasIndex(x => x.ExternalId);
            b.HasMany(x => x.Entities).WithOne().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<BackupEntity>(b =>
        {
            b.ToTable("Entities");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.Name).HasMaxLength(BackupAccount.NameLength);
            b.Property(x => x.FullName).HasMaxLength(BackupAccount.NameLength);
            b.Property(x => x.ExtId).HasMaxLength(BackupAccount.NameLength);
            b.Property(x => x.Status).HasMaxLength(Text.CodeLength);
            b.Property(x => x.Error).HasMaxLength(BackupEntity.ErrorLength);
            b.Property(x => x.ErrorLink).HasMaxLength(BackupEntity.LinkLength);
            b.Property(x => x.Licensing).HasMaxLength(Text.CodeLength);
            b.HasIndex(x => new { x.TaskId, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.TaskId, x.Name });
        });

        modelBuilder.Entity<BackupBillLine>(b =>
        {
            b.ToTable("BillLines");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.LineKey).HasMaxLength(BackupBillLine.KeyLength);
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.AccountExternalId).HasMaxLength(128);
            b.Property(x => x.Type).HasMaxLength(Text.CodeLength);
            b.Property(x => x.Source).HasMaxLength(Text.CodeLength);
            b.Property(x => x.Service).HasMaxLength(BackupAccount.NameLength);
            b.Property(x => x.Price).HasPrecision(18, 4);
            b.Property(x => x.Total).HasPrecision(18, 2);
            b.Property(x => x.Currency).HasMaxLength(3);
            b.Property(x => x.PaymentType).HasMaxLength(Text.CodeLength);
            b.HasIndex(x => x.LineKey).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.Day });
        });
    }
}

internal sealed class BackupDesignTimeFactory() : ModuleDesignTimeFactory<BackupDbContext>(BackupDbContext.SchemaName);
