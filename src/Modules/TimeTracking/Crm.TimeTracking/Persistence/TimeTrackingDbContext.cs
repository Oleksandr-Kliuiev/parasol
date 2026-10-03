using Crm.Infrastructure.Persistence;
using Crm.TimeTracking.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.TimeTracking.Persistence;

public sealed class TimeTrackingDbContext(DbContextOptions<TimeTrackingDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "time";

    public override string Schema => SchemaName;

    public DbSet<TimeEntry> TimeEntries => Set<TimeEntry>();

    public DbSet<TimeAllocation> TimeAllocations => Set<TimeAllocation>();

    public DbSet<TimePeriod> TimePeriods => Set<TimePeriod>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<TimeEntry>(b =>
        {
            b.ToTable("TimeEntries");
            b.ConfigureAuditable();
            b.Property(x => x.Source).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.ExternalId).HasMaxLength(128);
            b.Property(x => x.TechnicianExternalId).HasMaxLength(128);
            b.Property(x => x.TechnicianName).HasMaxLength(256);
            b.Property(x => x.TicketTitle).HasMaxLength(512);
            b.Property(x => x.Hours).HasPrecision(6, 2);
            b.Property(x => x.WorkType).HasMaxLength(128);
            b.Property(x => x.Description).HasMaxLength(2000);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Amount).HasPrecision(18, 2);
            b.Property(x => x.ReviewNote).HasMaxLength(512);
            b.Ignore(x => x.CurrentAllocations);
            b.Ignore(x => x.Year);
            b.Ignore(x => x.Month);
            b.HasMany(x => x.Allocations).WithOne().HasForeignKey(a => a.TimeEntryId).OnDelete(DeleteBehavior.Restrict);
            b.Navigation(x => x.Allocations).HasField("_allocations").UsePropertyAccessMode(PropertyAccessMode.Field);
            b.HasIndex(x => new { x.Source, x.ExternalId }).IsUnique().HasFilter("[ExternalId] IS NOT NULL AND [IsDeleted] = 0");
            b.HasIndex(x => new { x.OrganizationId, x.WorkDate });
            b.HasIndex(x => new { x.TechnicianId, x.WorkDate });
            b.HasIndex(x => new { x.Status, x.WorkDate });
            b.HasIndex(x => x.ProjectId).HasFilter("[ProjectId] IS NOT NULL");
        });

        modelBuilder.Entity<TimeAllocation>(b =>
        {
            b.ToTable("TimeAllocations");
            b.ConfigureAuditable();
            b.Property(x => x.Classification).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Hours).HasPrecision(6, 2);
            b.Property(x => x.BilledHours).HasPrecision(6, 2);
            b.Property(x => x.Rate).HasPrecision(18, 2);
            b.Property(x => x.Amount).HasPrecision(18, 2);
            b.HasIndex(x => x.HourBankId).HasFilter("[HourBankId] IS NOT NULL");
        });

        modelBuilder.Entity<TimePeriod>(b =>
        {
            b.ToTable("TimePeriods");
            b.ConfigureAuditable();
            b.Property(x => x.ReopenReason).HasMaxLength(512);
            b.HasIndex(x => new { x.Year, x.Month }).IsUnique();
        });
    }
}

internal sealed class TimeTrackingDesignTimeFactory() : ModuleDesignTimeFactory<TimeTrackingDbContext>(TimeTrackingDbContext.SchemaName);
