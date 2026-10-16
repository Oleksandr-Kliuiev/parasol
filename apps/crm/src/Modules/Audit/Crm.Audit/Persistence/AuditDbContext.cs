using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Audit.Persistence;

/// <summary>Owns the <c>audit.AuditEntries</c> table; other modules write to it within their own transactions.</summary>
public sealed class AuditDbContext(DbContextOptions<AuditDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "audit";

    public override string Schema => SchemaName;

    protected override bool OwnsAuditTable => true;

    public DbSet<AuditIntegrityCheckpoint> IntegrityCheckpoints => Set<AuditIntegrityCheckpoint>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AuditIntegrityCheckpoint>(b =>
        {
            b.ToTable("IntegrityCheckpoints");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).UseIdentityColumn();
            b.Property(x => x.PreviousHash).HasMaxLength(64).IsFixedLength();
            b.Property(x => x.ChainHash).HasMaxLength(64).IsFixedLength();
            b.HasIndex(x => x.ToId).IsUnique();
        });
    }
}

internal sealed class AuditDesignTimeFactory() : ModuleDesignTimeFactory<AuditDbContext>(AuditDbContext.SchemaName);
