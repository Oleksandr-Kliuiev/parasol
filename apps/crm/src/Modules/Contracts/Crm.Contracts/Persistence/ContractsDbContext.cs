using Crm.Contracts.Domain;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Crm.Contracts.Persistence;

public sealed class ContractsDbContext(DbContextOptions<ContractsDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "contracts";

    public const string ContractNumberSequence = "ContractNumbers";

    public override string Schema => SchemaName;

    public DbSet<Contract> Contracts => Set<Contract>();

    public DbSet<ContractLine> ContractLines => Set<ContractLine>();

    public DbSet<SlaPolicy> SlaPolicies => Set<SlaPolicy>();

    public DbSet<HourBank> HourBanks => Set<HourBank>();

    public DbSet<HourBankEntry> HourBankEntries => Set<HourBankEntry>();

    public DbSet<Reminder> Reminders => Set<Reminder>();

    /// <summary>Next contract number, e.g. K-2026-0042. The sequence is global so numbers never repeat across years.</summary>
    public async Task<string> NextContractNumberAsync(int year, CancellationToken cancellationToken)
    {
        // Not composed (no SingleAsync): SQL Server does not allow NEXT VALUE FOR inside a subquery.
        var values = await Database
            .SqlQueryRaw<long>($"SELECT NEXT VALUE FOR [{SchemaName}].[{ContractNumberSequence}] AS [Value]")
            .ToListAsync(cancellationToken);
        var value = values.Single();
        return string.Create(System.Globalization.CultureInfo.InvariantCulture, $"K-{year}-{value:0000}");
    }

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.HasSequence<long>(ContractNumberSequence, SchemaName).StartsAt(1).IncrementsBy(1);

        modelBuilder.Entity<Contract>(b =>
        {
            b.ToTable("Contracts");
            b.ConfigureAuditable();
            b.Property(x => x.Number).HasMaxLength(32);
            b.Property(x => x.Title).HasMaxLength(256);
            b.Property(x => x.Type).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.InvoiceFrequency).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.InvoiceTiming).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.PriceCategory).HasMaxLength(32);
            b.Property(x => x.CustomerReference).HasMaxLength(128);
            b.Property(x => x.Notes).HasMaxLength(4000);
            b.Ignore(x => x.IsLive);
            b.HasOne<SlaPolicy>().WithMany().HasForeignKey(x => x.SlaPolicyId).OnDelete(DeleteBehavior.Restrict);
            b.HasMany(x => x.Lines).WithOne().HasForeignKey(x => x.ContractId).OnDelete(DeleteBehavior.Restrict);
            b.Navigation(x => x.Lines).HasField("_lines").UsePropertyAccessMode(PropertyAccessMode.Field);
            b.HasIndex(x => x.Number).IsUnique();
            // DEV-07: one contract per accepted quote, deleted drafts included.
            b.HasIndex(x => x.SourceQuoteId).IsUnique().HasFilter("[SourceQuoteId] IS NOT NULL");
            b.HasIndex(x => new { x.OrganizationId, x.Status });
            b.HasIndex(x => new { x.Status, x.EndDate });
            b.HasIndex(x => x.OwnerId);
            b.HasIndex(x => x.MovedByMergeId).HasFilter("[MovedByMergeId] IS NOT NULL");
        });

        modelBuilder.Entity<ContractLine>(b =>
        {
            b.ToTable("ContractLines");
            b.ConfigureAuditable();
            b.Property(x => x.Description).HasMaxLength(512);
            b.Property(x => x.QuantityModel).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.DeviceFilter).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Quantity).HasPrecision(18, 2);
            b.Property(x => x.UnitPrice).HasPrecision(18, 2);
            b.Property(x => x.DiscountPct).HasPrecision(5, 2);
            b.HasIndex(x => x.ProductId);
            b.HasIndex(x => x.SeriesId);
        });

        modelBuilder.Entity<SlaPolicy>(b =>
        {
            b.ToTable("SlaPolicies");
            b.ConfigureAuditable();
            b.Property(x => x.Name).HasMaxLength(128);
            b.Property(x => x.Coverage).HasConversion<string>().HasMaxLength(16);
            MapTarget(b.ComplexProperty(x => x.P1));
            MapTarget(b.ComplexProperty(x => x.P2));
            MapTarget(b.ComplexProperty(x => x.P3));
            MapTarget(b.ComplexProperty(x => x.P4));
            b.Property(x => x.IncludedHoursPerMonth).HasPrecision(9, 2);
            b.Property(x => x.OverageRate).HasPrecision(18, 2);
            b.Property(x => x.AfterHoursMultiplier).HasPrecision(5, 2);
            b.Property(x => x.CoveredWorkTypes).HasMaxLength(512);
            b.Property(x => x.AteraValue).HasMaxLength(128);
            b.HasIndex(x => x.Name).IsUnique().HasFilter("[IsDeleted] = 0");
        });

        modelBuilder.Entity<HourBank>(b =>
        {
            b.ToTable("HourBanks");
            b.ConfigureAuditable();
            b.Property(x => x.Name).HasMaxLength(128);
            b.Property(x => x.PurchasedHours).HasPrecision(9, 2);
            b.Property(x => x.UsedHours).HasPrecision(9, 2);
            b.Property(x => x.OverageHours).HasPrecision(9, 2);
            b.Property(x => x.OverageRate).HasPrecision(18, 2);
            b.Property(x => x.LowBalancePct).HasPrecision(5, 2);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Ignore(x => x.RemainingHours);
            b.Ignore(x => x.IsLow);
            b.HasOne<Contract>().WithMany().HasForeignKey(x => x.ContractId).OnDelete(DeleteBehavior.Restrict);
            b.HasIndex(x => new { x.OrganizationId, x.Status });
            b.HasIndex(x => x.MovedByMergeId).HasFilter("[MovedByMergeId] IS NOT NULL");
        });

        modelBuilder.Entity<HourBankEntry>(b =>
        {
            b.ToTable("HourBankEntries");
            b.ConfigureAuditable();
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Hours).HasPrecision(9, 2);
            b.Property(x => x.OverageHours).HasPrecision(9, 2);
            b.Property(x => x.Description).HasMaxLength(512);
            b.Property(x => x.SourceType).HasMaxLength(32);
            b.Property(x => x.SourceId).HasMaxLength(128);
            b.HasOne<HourBank>().WithMany().HasForeignKey(x => x.HourBankId).OnDelete(DeleteBehavior.Restrict);
            b.HasIndex(x => new { x.HourBankId, x.Date });
            b.HasIndex(x => new { x.SourceType, x.SourceId }).IsUnique().HasFilter("[SourceType] IS NOT NULL AND [SourceId] IS NOT NULL");
        });

        modelBuilder.Entity<Reminder>(b =>
        {
            b.ToTable("Reminders");
            b.ConfigureAuditable();
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.DeduplicationKey).HasMaxLength(128);
            b.HasIndex(x => x.DeduplicationKey).IsUnique();
            b.HasIndex(x => new { x.AssigneeId, x.AcknowledgedAt });
            b.HasIndex(x => x.OrganizationId);
        });
    }

    private static void MapTarget(ComplexPropertyBuilder<PriorityTarget> target)
    {
        target.Property(t => t.ResponseMinutes);
        target.Property(t => t.ResolutionMinutes);
    }
}

internal sealed class ContractsDesignTimeFactory() : ModuleDesignTimeFactory<ContractsDbContext>(ContractsDbContext.SchemaName);
