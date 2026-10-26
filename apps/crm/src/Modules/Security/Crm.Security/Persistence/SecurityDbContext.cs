using Crm.Infrastructure.Persistence;
using Crm.Security.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Security.Persistence;

/// <summary>
/// The security module's schema (M40.S, filled in M41): the mirror of Huntress's incidents with their plans and comments, its
/// escalations and platform actions, summary reports and usage.
/// </summary>
public sealed class SecurityDbContext(DbContextOptions<SecurityDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "security";

    public override string Schema => SchemaName;

    public DbSet<Incident> Incidents => Set<Incident>();

    public DbSet<Remediation> Remediations => Set<Remediation>();

    public DbSet<IncidentComment> IncidentComments => Set<IncidentComment>();

    public DbSet<Notice> Notices => Set<Notice>();

    public DbSet<SummaryReport> SummaryReports => Set<SummaryReport>();

    public DbSet<ProductUsage> ProductUsages => Set<ProductUsage>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Incident>(b =>
        {
            b.ToTable("Incidents");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.AgentExternalId).HasMaxLength(64);
            b.Property(x => x.DeviceName).HasMaxLength(Incident.DeviceNameLength);
            b.Property(x => x.Status).HasMaxLength(32);
            b.Property(x => x.Severity).HasMaxLength(16);
            b.Property(x => x.Subject).HasMaxLength(Incident.SubjectLength);
            b.Property(x => x.Summary).HasMaxLength(Incident.SummaryLength);
            b.Property(x => x.Body).HasMaxLength(Incident.BodyLength);
            b.Property(x => x.Platform).HasMaxLength(32);
            b.Property(x => x.IndicatorTypes).HasMaxLength(Incident.IndicatorTypesLength);
            b.Property(x => x.IndicatorCounts).HasMaxLength(Incident.IndicatorCountsLength);
            b.Property(x => x.Url).HasMaxLength(Incident.UrlLength);
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.Status });
            b.HasMany(x => x.Remediations).WithOne().HasForeignKey(x => x.IncidentId).OnDelete(DeleteBehavior.Cascade);
            b.HasMany(x => x.Comments).WithOne().HasForeignKey(x => x.IncidentId).OnDelete(DeleteBehavior.Cascade);
            b.Navigation(x => x.Remediations).UsePropertyAccessMode(PropertyAccessMode.Field);
            b.Navigation(x => x.Comments).UsePropertyAccessMode(PropertyAccessMode.Field);
        });

        modelBuilder.Entity<Remediation>(b =>
        {
            b.ToTable("Remediations");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Type).HasMaxLength(32);
            b.Property(x => x.Action).HasMaxLength(Remediation.ActionLength);
            b.Property(x => x.Parameters).HasMaxLength(Remediation.ParametersLength);
            b.Property(x => x.Status).HasMaxLength(32);
            b.Property(x => x.ApprovedBy).HasMaxLength(256);
            b.HasIndex(x => new { x.IncidentId, x.ExternalId }).IsUnique();
        });

        modelBuilder.Entity<IncidentComment>(b =>
        {
            b.ToTable("IncidentComments");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Body).HasMaxLength(IncidentComment.BodyLength);
            b.Property(x => x.Author).HasMaxLength(256);
            b.HasIndex(x => new { x.IncidentId, x.ExternalId }).IsUnique();
        });

        modelBuilder.Entity<Notice>(b =>
        {
            b.ToTable("Notices");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.ExternalOrganizationIds).HasMaxLength(256);
            b.Property(x => x.Status).HasMaxLength(32);
            b.Property(x => x.Severity).HasMaxLength(16);
            b.Property(x => x.Subject).HasMaxLength(Notice.SubjectLength);
            b.Property(x => x.Type).HasMaxLength(128);
            b.Property(x => x.TypeCode).HasMaxLength(128);
            b.Property(x => x.Subtype).HasMaxLength(128);
            b.Property(x => x.Entities).HasMaxLength(Notice.EntitiesLength);
            b.Property(x => x.Url).HasMaxLength(Incident.UrlLength);
            b.HasIndex(x => new { x.System, x.Kind, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.Status });
        });

        modelBuilder.Entity<SummaryReport>(b =>
        {
            b.ToTable("SummaryReports");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.Type).HasMaxLength(32);
            b.Property(x => x.Url).HasMaxLength(Incident.UrlLength);
            b.HasIndex(x => new { x.System, x.ExternalId }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.PeriodStart });
        });

        modelBuilder.Entity<ProductUsage>(b =>
        {
            b.ToTable("ProductUsages");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.Name).HasMaxLength(256);
            b.HasIndex(x => new { x.System, x.ExternalOrganizationId }).IsUnique();
            b.HasIndex(x => x.OrganizationId);
        });
    }
}

internal sealed class SecurityDesignTimeFactory() : ModuleDesignTimeFactory<SecurityDbContext>(SecurityDbContext.SchemaName);
