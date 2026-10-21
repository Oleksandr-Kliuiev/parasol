using Crm.Infrastructure.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Persistence;

public sealed class ServiceDbContext(DbContextOptions<ServiceDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "service";

    public override string Schema => SchemaName;

    public DbSet<Ticket> Tickets => Set<Ticket>();

    public DbSet<Device> Devices => Set<Device>();

    public DbSet<DeviceCountSnapshot> DeviceCountSnapshots => Set<DeviceCountSnapshot>();

    public DbSet<Alert> Alerts => Set<Alert>();

    public DbSet<TicketRequest> TicketRequests => Set<TicketRequest>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Ticket>(b =>
        {
            b.ToTable("Tickets");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.Title).HasMaxLength(512);
            b.Property(x => x.Status).HasMaxLength(32);
            b.Property(x => x.Priority).HasMaxLength(32);
            b.Property(x => x.Impact).HasMaxLength(32);
            b.Property(x => x.Type).HasMaxLength(64);
            b.Property(x => x.Source).HasMaxLength(64);
            b.Property(x => x.TechnicianName).HasMaxLength(256);
            b.Property(x => x.EndUserName).HasMaxLength(256);
            b.Property(x => x.EndUserEmail).HasMaxLength(256);
            b.Property(x => x.Url).HasMaxLength(512);
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.IsOpen, x.CreatedAtSource });
            b.HasIndex(x => x.ContactId).HasFilter("[ContactId] IS NOT NULL");
            b.HasIndex(x => x.IsOpen).HasFilter("[IsOpen] = 1")
                .IncludeProperties(x => x.TechnicianUserId);
        });

        modelBuilder.Entity<Device>(b =>
        {
            b.ToTable("Devices");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.MachineName).HasMaxLength(256);
            b.Property(x => x.Type).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Os).HasMaxLength(256);
            b.Property(x => x.Url).HasMaxLength(512);
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.RemovedAt });
        });

        modelBuilder.Entity<DeviceCountSnapshot>(b =>
        {
            b.ToTable("DeviceCountSnapshots");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Type).HasConversion<string>().HasMaxLength(16);
            b.HasIndex(x => new { x.OrganizationId, x.Date, x.Type }).IsUnique();
        });

        modelBuilder.Entity<Alert>(b =>
        {
            b.ToTable("Alerts");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.ExternalCustomerId).HasMaxLength(128);
            b.Property(x => x.Severity).HasConversion<string>().HasMaxLength(16);
            // M38: the defaults let an older image keep inserting during a deployment; what it inserts is open monitoring.
            b.Property(x => x.State).HasConversion<string>().HasMaxLength(16).HasDefaultValue(AlertState.Open).HasSentinel(AlertState.Open);
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16).HasDefaultValue(AlertKind.Monitoring).HasSentinel(AlertKind.Monitoring);
            b.Property(x => x.Title).HasMaxLength(Alert.TitleLength);
            b.Property(x => x.DeviceName).HasMaxLength(Alert.DeviceNameLength);
            b.Property(x => x.Url).HasMaxLength(Alert.UrlLength);
            b.HasIndex(x => new { x.System, x.OrganizationId });
            // One row per alert of a source, so the id survives every read (alert → task links need it).
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
            // The cross-customer queue and the urgent list read open alerts by severity and age.
            b.HasIndex(x => new { x.State, x.Severity, x.CreatedAtSource }).IncludeProperties(x => x.OrganizationId);
        });

        modelBuilder.Entity<TicketRequest>(b =>
        {
            b.ToTable("TicketRequests");
            b.ConfigureAuditable();
            b.Property(x => x.Title).HasMaxLength(256);
            b.Property(x => x.Description).HasMaxLength(8000);
            b.Property(x => x.Priority).HasMaxLength(32);
            b.Property(x => x.Type).HasMaxLength(64);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Url).HasMaxLength(512);
            b.Property(x => x.Error).HasMaxLength(1000);
            b.HasIndex(x => new { x.OrganizationId, x.Status });
        });
    }
}

internal sealed class ServiceDesignTimeFactory() : ModuleDesignTimeFactory<ServiceDbContext>(ServiceDbContext.SchemaName);
