using Crm.Infrastructure.Persistence;
using Crm.Notifications.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Notifications.Persistence;

public sealed class NotificationsDbContext(DbContextOptions<NotificationsDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "notifications";

    public override string Schema => SchemaName;

    public DbSet<Notification> Notifications => Set<Notification>();

    public DbSet<NotificationPreference> Preferences => Set<NotificationPreference>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Notification>(b =>
        {
            b.ToTable("Notifications");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(40);
            b.Property(x => x.DedupeKey).HasMaxLength(200);
            b.Property(x => x.Link).HasMaxLength(512);
            b.Property(x => x.EmailStatus).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.EmailError).HasMaxLength(512);
            b.HasIndex(x => x.DedupeKey).IsUnique();
            b.HasIndex(x => new { x.RecipientId, x.ReadAt });
            b.HasIndex(x => x.EmailStatus);
            b.Ignore(x => x.Parameters);
        });

        modelBuilder.Entity<NotificationPreference>(b =>
        {
            b.ToTable("NotificationPreferences");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.MutedKindsJson).HasMaxLength(512);
            b.HasIndex(x => x.UserId).IsUnique();
            b.Ignore(x => x.MutedKinds);
        });
    }
}

internal sealed class NotificationsDesignTimeFactory() : ModuleDesignTimeFactory<NotificationsDbContext>(NotificationsDbContext.SchemaName);
