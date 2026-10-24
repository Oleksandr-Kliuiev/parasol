using Crm.Activities.Domain;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Activities.Persistence;

public sealed class ActivitiesDbContext(DbContextOptions<ActivitiesDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "activities";

    public override string Schema => SchemaName;

    public DbSet<Activity> Activities => Set<Activity>();
    public DbSet<SourceTaskLink> SourceTaskLinks => Set<SourceTaskLink>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<SourceTaskLink>(b =>
        {
            b.ToTable("SourceTaskLinks");
            b.HasKey(x => x.SourceKey);
            b.Property(x => x.SourceKey).HasMaxLength(64).IsUnicode(false);
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.WorkspaceId).HasMaxLength(128);
            b.Property(x => x.ClientId).HasMaxLength(128);
            b.Property(x => x.ObservationId).HasMaxLength(256);
            b.Property(x => x.TargetKind).HasMaxLength(16);
            b.HasIndex(x => x.ActivityId).IsUnique();
            b.HasOne<Activity>().WithMany().HasForeignKey(x => x.ActivityId).OnDelete(DeleteBehavior.Restrict);
            b.Ignore(x => x.Source);
        });
        modelBuilder.Entity<Activity>(b =>
        {
            b.ToTable("Activities");
            b.ConfigureAuditable();
            b.Property(x => x.Type).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Subject).HasMaxLength(256);
            b.Property(x => x.Body).HasMaxLength(8000);
            b.Property(x => x.Priority).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Location).HasMaxLength(256);
            b.Property(x => x.GraphEventId).HasMaxLength(512);
            b.Property(x => x.WebLink).HasMaxLength(1024);
            b.Property(x => x.ExternalMessageId).HasMaxLength(512);
            b.Property(x => x.FromAddress).HasMaxLength(256);
            b.HasIndex(x => new { x.OrganizationId, x.CreatedAt });
            b.HasIndex(x => new { x.AssigneeId, x.Status, x.DueAt });
            b.HasIndex(x => x.OpportunityId).HasFilter("[OpportunityId] IS NOT NULL");
            b.HasIndex(x => x.ContractId).HasFilter("[ContractId] IS NOT NULL");
            b.HasIndex(x => x.GraphEventId).HasFilter("[GraphEventId] IS NOT NULL");
            // The same message is saved once per customer, however many people have it in their mailbox (FR-ACT-03).
            b.HasIndex(x => new { x.OrganizationId, x.ExternalMessageId }).IsUnique().HasFilter("[ExternalMessageId] IS NOT NULL");
        });
    }
}

internal sealed class ActivitiesDesignTimeFactory() : ModuleDesignTimeFactory<ActivitiesDbContext>(ActivitiesDbContext.SchemaName);
