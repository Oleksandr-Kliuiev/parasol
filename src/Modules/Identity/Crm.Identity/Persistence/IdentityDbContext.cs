using Crm.Identity.Domain;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Identity.Persistence;

public sealed class IdentityDbContext(DbContextOptions<IdentityDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "identity";

    public override string Schema => SchemaName;

    public DbSet<User> Users => Set<User>();

    public DbSet<TechnicianMapping> TechnicianMappings => Set<TechnicianMapping>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<User>(b =>
        {
            b.ToTable("Users");
            b.ConfigureAuditable();
            b.Property(x => x.TenantId).HasMaxLength(64);
            b.Property(x => x.ObjectId).HasMaxLength(64);
            b.Property(x => x.UserPrincipalName).HasMaxLength(256);
            b.Property(x => x.DisplayName).HasMaxLength(256);
            b.Property(x => x.Email).HasMaxLength(256);
            b.Property(x => x.Department).HasMaxLength(128);
            b.Property(x => x.JobTitle).HasMaxLength(128);
            b.Property(x => x.PreferredLanguage).HasMaxLength(8);
            b.HasIndex(x => new { x.TenantId, x.ObjectId }).IsUnique();
        });

        modelBuilder.Entity<TechnicianMapping>(b =>
        {
            b.ToTable("TechnicianMappings");
            b.ConfigureAuditable();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.Email).HasMaxLength(256);
            b.Property(x => x.Name).HasMaxLength(256);
            b.Property(x => x.Method).HasConversion<string>().HasMaxLength(16);
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
        });
    }
}

internal sealed class IdentityDesignTimeFactory() : ModuleDesignTimeFactory<IdentityDbContext>(IdentityDbContext.SchemaName);
