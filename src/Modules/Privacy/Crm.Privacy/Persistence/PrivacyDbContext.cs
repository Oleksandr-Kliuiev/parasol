using Crm.Infrastructure.Persistence;
using Crm.Privacy.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Privacy.Persistence;

public sealed class PrivacyDbContext(DbContextOptions<PrivacyDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "privacy";

    public const string CaseNumberSequence = "CaseNumbers";

    /// <summary>The installation's key for suppression hashes; created with a random value by the migration (DEV-11).</summary>
    public const string SuppressionKeyName = "suppression";

    public override string Schema => SchemaName;

    public DbSet<PrivacyCase> Cases => Set<PrivacyCase>();

    public DbSet<LegalHold> LegalHolds => Set<LegalHold>();

    public DbSet<Suppression> Suppressions => Set<Suppression>();

    public DbSet<ErasureManifest> ErasureManifests => Set<ErasureManifest>();

    public DbSet<ErasedRecordRow> ErasedRecords => Set<ErasedRecordRow>();

    public DbSet<RetentionPolicy> RetentionPolicies => Set<RetentionPolicy>();

    public DbSet<RetentionRun> RetentionRuns => Set<RetentionRun>();

    public DbSet<PrivacyKey> Keys => Set<PrivacyKey>();

    /// <summary>Next case number, e.g. PRV-2026-0007; the sequence is global, so numbers never repeat across years.</summary>
    /// <summary>
    /// The next case number. A database restored from a backup has the sequence of that moment, while the replay brings back
    /// the cases of later erasures with their own numbers (DEV-11-AC06): numbers taken that way are skipped, never issued twice.
    /// </summary>
    public async Task<string> NextCaseNumberAsync(int year, CancellationToken cancellationToken)
    {
        while (true)
        {
            // Not composed (no SingleAsync): SQL Server does not allow NEXT VALUE FOR inside a subquery.
            var values = await Database
                .SqlQueryRaw<int>($"SELECT NEXT VALUE FOR [{SchemaName}].[{CaseNumberSequence}] AS [Value]")
                .ToListAsync(cancellationToken);
            var number = string.Create(System.Globalization.CultureInfo.InvariantCulture, $"PRV-{year}-{values.Single():0000}");
            if (!await Cases.IgnoreQueryFilters().AnyAsync(c => c.Number == number, cancellationToken))
            {
                return number;
            }
        }
    }

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.HasSequence<int>(CaseNumberSequence, SchemaName).StartsAt(1).IncrementsBy(1);

        modelBuilder.Entity<PrivacyCase>(b =>
        {
            b.ToTable("Cases");
            b.ConfigureAuditable();
            b.Property(x => x.Number).HasMaxLength(16);
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.SubjectKind).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Channel).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.VerificationMethod).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Note).HasMaxLength(500);
            b.Property(x => x.VerificationNote).HasMaxLength(500);
            b.Property(x => x.PlanDigest).HasMaxLength(64);
            b.Property(x => x.ExportSha256).HasMaxLength(64);
            b.Property(x => x.RejectionReason).HasMaxLength(500);
            b.Ignore(x => x.IsClosed);
            b.HasIndex(x => x.Number).IsUnique();
            b.HasIndex(x => new { x.SubjectKind, x.SubjectId });
            b.HasIndex(x => x.Status);
        });

        modelBuilder.Entity<LegalHold>(b =>
        {
            b.ToTable("LegalHolds");
            b.ConfigureAuditable();
            b.Property(x => x.Module).HasMaxLength(64);
            b.Property(x => x.EntityType).HasMaxLength(128);
            b.Property(x => x.Reason).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Explanation).HasMaxLength(1000);
            b.Property(x => x.ReleaseReason).HasMaxLength(500);
            b.HasIndex(x => new { x.Module, x.EntityType, x.EntityId });
        });

        modelBuilder.Entity<Suppression>(b =>
        {
            b.ToTable("Suppressions");
            b.ConfigureAuditable();
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Value).HasMaxLength(256);
            b.Property(x => x.LiftReason).HasMaxLength(500);
            // One live suppression per value: an erasure repeated, or a replay after a restore, adds nothing.
            b.HasIndex(x => new { x.Kind, x.Value }).IsUnique().HasFilter("[LiftedAt] IS NULL");
            b.HasIndex(x => x.CaseId);
        });

        modelBuilder.Entity<ErasureManifest>(b =>
        {
            b.ToTable("ErasureManifests");
            // Ids come from the domain (SequentialId); the manifest's id is also its name in the document store.
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.CaseNumber).HasMaxLength(16);
            b.Property(x => x.Sha256).HasMaxLength(64);
            b.Property(x => x.StoreKey).HasMaxLength(256);
            b.HasIndex(x => x.CaseId).IsUnique();
        });

        modelBuilder.Entity<ErasedRecordRow>(b =>
        {
            b.ToTable("ErasedRecords");
            b.HasKey(x => x.Id);
            b.Property(x => x.Module).HasMaxLength(64);
            b.Property(x => x.EntityType).HasMaxLength(128);
            b.Property(x => x.Action).HasMaxLength(24);
            b.Property(x => x.DataClass).HasMaxLength(64);
            b.HasIndex(x => new { x.Module, x.EntityType, x.EntityId });
            b.HasIndex(x => x.ManifestId);
        });

        modelBuilder.Entity<RetentionPolicy>(b =>
        {
            b.ToTable("RetentionPolicies", t => t.HasCheckConstraint("CK_RetentionPolicies_RetainDays", "[RetainDays] >= 30"));
            b.HasKey(x => x.DataClass);
            b.Property(x => x.DataClass).HasMaxLength(64);
            b.Property(x => x.ApprovedBy).HasMaxLength(256);
            b.Property(x => x.Reference).HasMaxLength(256);
        });

        modelBuilder.Entity<RetentionRun>(b =>
        {
            b.ToTable("RetentionRuns");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Mode).HasConversion<string>().HasMaxLength(16);
            b.HasIndex(x => x.StartedAt);
        });

        modelBuilder.Entity<PrivacyKey>(b =>
        {
            b.ToTable("Keys");
            b.HasKey(x => x.Name);
            b.Property(x => x.Name).HasMaxLength(32);
            b.Property(x => x.Value).HasMaxLength(64);
        });
    }
}

internal sealed class PrivacyDesignTimeFactory() : ModuleDesignTimeFactory<PrivacyDbContext>(PrivacyDbContext.SchemaName);

/// <summary>A secret of the privacy module kept in its schema; written once by the migration, read-only to the application.</summary>
public sealed class PrivacyKey
{
    public string Name { get; init; } = string.Empty;

    public byte[] Value { get; init; } = [];
}
