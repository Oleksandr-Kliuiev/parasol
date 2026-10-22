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

    public DbSet<AlertHold> AlertHolds => Set<AlertHold>();
    public DbSet<AlertTransition> AlertTransitions => Set<AlertTransition>();

    public DbSet<TicketRequest> TicketRequests => Set<TicketRequest>();

    public DbSet<TicketComment> TicketComments => Set<TicketComment>();

    public DbSet<Machine> Machines => Set<Machine>();

    public DbSet<DevicePatch> DevicePatches => Set<DevicePatch>();

    public DbSet<MachineLinkDecision> MachineLinkDecisions => Set<MachineLinkDecision>();

    public DbSet<MachineProposal> MachineProposals => Set<MachineProposal>();

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
            // The cross-customer ticket list (M39.2): open first, newest first, and a person's own tickets.
            b.HasIndex(x => new { x.IsOpen, x.CreatedAtSource });
            b.HasIndex(x => new { x.TechnicianUserId, x.IsOpen }).HasFilter("[TechnicianUserId] IS NOT NULL");
        });

        modelBuilder.Entity<TicketComment>(b =>
        {
            b.ToTable("TicketComments");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.Author).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.AuthorName).HasMaxLength(TicketComment.AuthorNameLength);
            // M39.2: a conversation belongs to its ticket in this schema; retention deletes closed tickets and their comments with them.
            b.HasOne<Ticket>().WithMany().HasForeignKey(x => x.TicketId).OnDelete(DeleteBehavior.Cascade);
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.TicketId, x.CreatedAtSource });
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
            b.Property(x => x.SerialNumber).HasMaxLength(Device.SerialNumberLength);
            b.Property(x => x.MacAddresses).HasMaxLength(Device.MacAddressesLength);
            // M40: the computer as its source describes it (lengths as Device.Apply cuts them).
            b.Property(x => x.AlternateId).HasMaxLength(128);
            b.Property(x => x.Vendor).HasMaxLength(128);
            b.Property(x => x.Model).HasMaxLength(256);
            b.Property(x => x.Motherboard).HasMaxLength(256);
            b.Property(x => x.Processor).HasMaxLength(256);
            b.Property(x => x.ProcessorClock).HasMaxLength(32);
            b.Property(x => x.BiosVersion).HasMaxLength(128);
            b.Property(x => x.OsVersion).HasMaxLength(64);
            b.Property(x => x.OsBuild).HasMaxLength(64);
            b.Property(x => x.IpAddresses).HasMaxLength(1024);
            b.Property(x => x.PublicIp).HasMaxLength(64);
            b.Property(x => x.DomainName).HasMaxLength(256);
            b.Property(x => x.LoggedInUsers).HasMaxLength(512);
            b.Property(x => x.LastLoginUser).HasMaxLength(256);
            b.Property(x => x.Disks).HasMaxLength(DeviceDisks.Length);
            b.Property(x => x.AgentVersion).HasMaxLength(64);
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.RemovedAt });
            // M40: a machine is its devices; it is removed only once no device names it.
            b.HasOne<Machine>().WithMany().HasForeignKey(x => x.MachineId).OnDelete(DeleteBehavior.Restrict);
            b.HasIndex(x => x.MachineId).HasFilter("[MachineId] IS NOT NULL");
        });

        modelBuilder.Entity<DevicePatch>(b =>
        {
            b.ToTable("DevicePatches");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.KbId).HasMaxLength(32);
            b.Property(x => x.Name).HasMaxLength(DevicePatch.NameLength);
            b.Property(x => x.Class).HasMaxLength(128);
            b.Property(x => x.Status).HasMaxLength(64);
            // M40: a device's updates go with it; a read replaces them as a whole.
            b.HasOne<Device>().WithMany().HasForeignKey(x => x.DeviceId).OnDelete(DeleteBehavior.Cascade);
            b.HasIndex(x => new { x.DeviceId, x.Installed });
        });

        modelBuilder.Entity<Machine>(b =>
        {
            b.ToTable("Machines");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Name).HasMaxLength(256);
            b.Property(x => x.Type).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Os).HasMaxLength(256);
            // A customer's machines by name (the Drift tab), current ones first.
            b.HasIndex(x => new { x.OrganizationId, x.RemovedAt, x.Name });
        });

        modelBuilder.Entity<MachineLinkDecision>(b =>
        {
            b.ToTable("MachineLinkDecisions");
            b.ConfigureAuditable();
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            // One decision per pair of devices; the matcher reads a customer's decisions.
            b.HasIndex(x => new { x.DeviceId, x.OtherDeviceId }).IsUnique();
            b.HasIndex(x => x.OrganizationId);
        });

        modelBuilder.Entity<MachineProposal>(b =>
        {
            b.ToTable("MachineProposals");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Evidence).HasConversion<int>();
            b.HasIndex(x => new { x.MachineId, x.OtherMachineId }).IsUnique();
            b.HasIndex(x => x.OtherMachineId);
            b.HasIndex(x => x.OrganizationId);
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
            // M40: the CRM's own status, one row per alert with the alert's id, so a read never changes its version.
            b.HasOne(x => x.Hold).WithOne().HasForeignKey<AlertHold>(x => x.Id).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<AlertHold>(b =>
        {
            b.ToTable("AlertHolds");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Reason).HasMaxLength(AlertHold.ReasonLength);
            // Hidden in Parasoll until a date: the open lists leave such alerts out until then.
            b.HasIndex(x => x.Until).HasFilter("[Until] IS NOT NULL");
        });

        modelBuilder.Entity<AlertTransition>(b =>
        {
            b.ToTable("AlertTransitions");
            b.ConfigureAuditable();
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Reason).HasMaxLength(AlertHold.ReasonLength);
            // M40: what people did with an alert goes with it when retention removes it.
            b.HasOne<Alert>().WithMany().HasForeignKey(x => x.AlertId).OnDelete(DeleteBehavior.Cascade);
            b.HasIndex(x => new { x.AlertId, x.CreatedAt });
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
