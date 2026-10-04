using Crm.Infrastructure.Persistence;
using Crm.Projects.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Projects.Persistence;

public sealed class ProjectsDbContext(DbContextOptions<ProjectsDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "projects";

    public const string ProjectNumberSequence = "ProjectNumbers";

    public override string Schema => SchemaName;

    public DbSet<Project> Projects => Set<Project>();

    public DbSet<ProjectPhase> ProjectPhases => Set<ProjectPhase>();

    public DbSet<ProjectTask> ProjectTasks => Set<ProjectTask>();

    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();

    /// <summary>Next project number, e.g. P-2026-0042. The sequence is global so numbers never repeat across years.</summary>
    public async Task<string> NextProjectNumberAsync(int year, CancellationToken cancellationToken)
    {
        // Not composed (no SingleAsync): SQL Server does not allow NEXT VALUE FOR inside a subquery.
        var values = await Database
            .SqlQueryRaw<int>($"SELECT NEXT VALUE FOR [{SchemaName}].[{ProjectNumberSequence}] AS [Value]")
            .ToListAsync(cancellationToken);
        var value = values.Single();
        return string.Create(System.Globalization.CultureInfo.InvariantCulture, $"P-{year}-{value:0000}");
    }

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.HasSequence<int>(ProjectNumberSequence, SchemaName).StartsAt(1).IncrementsBy(1);

        modelBuilder.Entity<Project>(b =>
        {
            b.ToTable("Projects");
            b.ConfigureAuditable();
            b.Property(x => x.Number).HasMaxLength(16);
            b.Property(x => x.Name).HasMaxLength(256);
            b.Property(x => x.Type).HasConversion<string>().HasMaxLength(32);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.BillingModel).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.BudgetHours).HasPrecision(18, 2);
            b.Property(x => x.BudgetAmount).HasPrecision(18, 2);
            b.Property(x => x.Notes).HasMaxLength(4000);
            b.Ignore(x => x.IsOpen);
            b.HasMany(x => x.Phases).WithOne().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            b.Navigation(x => x.Phases).HasField("_phases").UsePropertyAccessMode(PropertyAccessMode.Field);
            b.HasIndex(x => x.Number).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.Status });
            b.HasIndex(x => x.ManagerId);
        });

        modelBuilder.Entity<ProjectPhase>(b =>
        {
            b.ToTable("ProjectPhases");
            // Ids come from the domain (SequentialId), so EF must not treat a new phase as an existing row.
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Name).HasMaxLength(256);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.PlannedHours).HasPrecision(18, 2);
            b.Property(x => x.Fee).HasPrecision(18, 2);
            b.HasMany(x => x.Tasks).WithOne().HasForeignKey(x => x.PhaseId).OnDelete(DeleteBehavior.Cascade);
            b.Navigation(x => x.Tasks).HasField("_tasks").UsePropertyAccessMode(PropertyAccessMode.Field);
            b.HasIndex(x => x.ProjectId);
        });

        modelBuilder.Entity<ProjectTask>(b =>
        {
            b.ToTable("ProjectTasks");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Title).HasMaxLength(256);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.EstimatedHours).HasPrecision(18, 2);
            b.Property(x => x.Notes).HasMaxLength(2000);
            b.HasIndex(x => x.PhaseId);
            b.HasIndex(x => new { x.AssigneeId, x.Status });
        });

        // DEV-09: the team of a project; one live row per person (a removed member's row stays, soft-deleted, for the audit log).
        modelBuilder.Entity<ProjectMember>(b =>
        {
            b.ToTable("ProjectMembers");
            b.ConfigureAuditable();
            b.HasOne<Project>().WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            b.HasIndex(x => new { x.ProjectId, x.UserId }).IsUnique().HasFilter("[IsDeleted] = 0");
            b.HasIndex(x => x.UserId);
        });
    }
}

internal sealed class ProjectsDesignTimeFactory() : ModuleDesignTimeFactory<ProjectsDbContext>(ProjectsDbContext.SchemaName);
