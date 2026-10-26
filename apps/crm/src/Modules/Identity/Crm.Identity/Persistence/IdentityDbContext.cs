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

    public DbSet<UserSession> UserSessions => Set<UserSession>();

    public DbSet<DirectoryRoleConfirmation> DirectoryRoleConfirmations => Set<DirectoryRoleConfirmation>();

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
            b.Property(x => x.MyDayLayout).HasMaxLength(16);
            // DEV-10: seven roles at most, comma-separated; existing users start with none until their next confirmation.
            b.Property(x => x.Roles).HasMaxLength(256).HasDefaultValue(string.Empty);
            b.Ignore(x => x.RoleList);
            b.HasIndex(x => new { x.TenantId, x.ObjectId }).IsUnique();
        });

        modelBuilder.Entity<UserSession>(b =>
        {
            b.ToTable("UserSessions");
            // Ids come from the domain (SequentialId): a new session is inserted, never mistaken for an existing row.
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.EndReason).HasMaxLength(32);
            b.HasIndex(x => x.UserId);
            b.Property(x => x.ExternalSessionHash).HasMaxLength(64).IsUnicode(false);
            b.HasIndex(x => x.ExternalSessionHash).HasFilter("[ExternalSessionHash] IS NOT NULL");
        });

        modelBuilder.Entity<DirectoryRoleConfirmation>(b =>
        {
            b.ToTable("DirectoryRoleConfirmations");
            b.HasKey(x => x.TenantId);
            b.Property(x => x.TenantId).HasMaxLength(64);
            // Two overlapping runs: the one that saves second finds the confirmation moved and rolls back with its role changes.
            b.Property(x => x.ConfirmedAt).IsConcurrencyToken();
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
