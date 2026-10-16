using Crm.Infrastructure.Persistence;
using Crm.Licensing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Licensing.Persistence;

public sealed class LicensingDbContext(DbContextOptions<LicensingDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "licensing";

    public override string Schema => SchemaName;

    public DbSet<CspSubscription> CspSubscriptions => Set<CspSubscription>();

    public DbSet<LicenseSnapshot> LicenseSnapshots => Set<LicenseSnapshot>();

    public DbSet<MsBilledLine> MsBilledLines => Set<MsBilledLine>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<CspSubscription>(b =>
        {
            b.ToTable("CspSubscriptions");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Source).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.CspCustomerId).HasMaxLength(128);
            b.Property(x => x.CspCustomerName).HasMaxLength(256);
            b.Property(x => x.TenantId).HasMaxLength(64);
            b.Property(x => x.SubscriptionId).HasMaxLength(128);
            b.Property(x => x.OfferId).HasMaxLength(128);
            b.Property(x => x.OfferName).HasMaxLength(256);
            b.Property(x => x.Sku).HasMaxLength(128);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Term).HasConversion<string>().HasMaxLength(8);
            b.Property(x => x.BillingCycle).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.PartnerUnitPrice).HasPrecision(18, 4);
            b.HasIndex(x => new { x.Source, x.SubscriptionId }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.Status });
            b.HasIndex(x => x.CspCustomerId);
            b.HasIndex(x => x.RenewalDate);
        });

        modelBuilder.Entity<LicenseSnapshot>(b =>
        {
            b.ToTable("LicenseSnapshots");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.SkuId).HasMaxLength(128);
            b.Property(x => x.SkuPartNumber).HasMaxLength(128);
            b.Ignore(x => x.Unused);
            // One reading per tenant, SKU and day: the day is the unit of "bought / assigned".
            b.HasIndex(x => new { x.OrganizationId, x.SnapshotDate, x.SkuId }).IsUnique();
            b.HasIndex(x => x.SnapshotDate);
        });

        modelBuilder.Entity<MsBilledLine>(b =>
        {
            b.ToTable("MsBilledLines");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.LineKey).HasMaxLength(512);
            b.Property(x => x.Source).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.InvoiceId).HasMaxLength(64);
            b.Property(x => x.CspCustomerId).HasMaxLength(128);
            b.Property(x => x.CspCustomerName).HasMaxLength(256);
            b.Property(x => x.SubscriptionId).HasMaxLength(128);
            b.Property(x => x.OfferId).HasMaxLength(128);
            b.Property(x => x.OfferName).HasMaxLength(256);
            b.Property(x => x.Currency).HasMaxLength(3);
            b.Property(x => x.Quantity).HasPrecision(18, 2);
            b.Property(x => x.UnitPrice).HasPrecision(18, 4);
            b.Property(x => x.Total).HasPrecision(18, 2);
            b.HasIndex(x => x.LineKey).IsUnique();
            b.HasIndex(x => new { x.PeriodStart, x.OrganizationId });
        });
    }
}

internal sealed class LicensingDesignTimeFactory() : ModuleDesignTimeFactory<LicensingDbContext>(LicensingDbContext.SchemaName);
