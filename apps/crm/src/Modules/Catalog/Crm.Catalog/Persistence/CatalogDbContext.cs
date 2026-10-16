using Crm.Catalog.Domain;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Catalog.Persistence;

public sealed class CatalogDbContext(DbContextOptions<CatalogDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "catalog";

    /// <summary>Seeded by the initial migration so a fresh installation can create price lists immediately.</summary>
    public static readonly Guid StandardCategoryId = new("00000000-0000-0000-0000-00000000c001");

    public override string Schema => SchemaName;

    public DbSet<Product> Products => Set<Product>();

    public DbSet<CustomerCategory> CustomerCategories => Set<CustomerCategory>();

    public DbSet<PriceList> PriceLists => Set<PriceList>();

    public DbSet<PriceListItem> PriceListItems => Set<PriceListItem>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Product>(b =>
        {
            b.ToTable("Products");
            b.ConfigureAuditable();
            b.Property(x => x.Sku).HasMaxLength(64);
            b.Property(x => x.Name).HasMaxLength(256);
            b.Property(x => x.NameEn).HasMaxLength(256);
            b.Property(x => x.Description).HasMaxLength(2000);
            b.Property(x => x.Type).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.BusinessLine).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Unit).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.BillingPeriod).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.CommitmentTerm).HasConversion<string>().HasMaxLength(8);
            b.Property(x => x.VatRate).HasPrecision(5, 2);
            b.Property(x => x.ListPrice).HasPrecision(18, 2);
            b.Property(x => x.UnitCost).HasPrecision(18, 2);
            b.Property(x => x.Currency).HasMaxLength(3).IsFixedLength();
            b.Property(x => x.MicrosoftOfferId).HasMaxLength(128);
            b.Property(x => x.AteraWorkType).HasMaxLength(128);
            b.Property(x => x.RevenueAccount).HasMaxLength(16);
            b.Ignore(x => x.Components);
            b.HasIndex(x => x.Sku).IsUnique().HasFilter("[IsDeleted] = 0");
            b.HasIndex(x => new { x.Name, x.Id });
        });

        modelBuilder.Entity<CustomerCategory>(b =>
        {
            b.ToTable("CustomerCategories");
            b.ConfigureAuditable();
            b.Property(x => x.Code).HasMaxLength(32);
            b.Property(x => x.Name).HasMaxLength(128);
            b.Property(x => x.LicenseMarkupPct).HasPrecision(7, 2);
            b.HasIndex(x => x.Code).IsUnique().HasFilter("[IsDeleted] = 0");
        });

        modelBuilder.Entity<PriceList>(b =>
        {
            b.ToTable("PriceLists");
            b.ConfigureAuditable();
            b.Property(x => x.Name).HasMaxLength(128);
            b.Property(x => x.CustomerCategory).HasMaxLength(32);
            b.Property(x => x.Currency).HasMaxLength(3).IsFixedLength();
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.HasIndex(x => new { x.CustomerCategory, x.ValidFrom });
        });

        modelBuilder.Entity<PriceListItem>(b =>
        {
            b.ToTable("PriceListItems");
            b.ConfigureAuditable();
            b.Property(x => x.UnitPrice).HasPrecision(18, 2);
            b.Property(x => x.UnitCost).HasPrecision(18, 2);
            b.Property(x => x.PartnerPrice).HasPrecision(18, 4);
            b.Property(x => x.PartnerCurrency).HasMaxLength(3).IsFixedLength();
            b.Property(x => x.ExchangeRate).HasPrecision(18, 6);
            b.HasOne<PriceList>().WithMany().HasForeignKey(x => x.PriceListId).OnDelete(DeleteBehavior.Restrict);
            b.HasOne<Product>().WithMany().HasForeignKey(x => x.ProductId).OnDelete(DeleteBehavior.Restrict);
            b.HasIndex(x => new { x.PriceListId, x.ProductId }).IsUnique().HasFilter("[IsDeleted] = 0");
            b.HasIndex(x => x.ProductId);
        });
    }
}

internal sealed class CatalogDesignTimeFactory() : ModuleDesignTimeFactory<CatalogDbContext>(CatalogDbContext.SchemaName);
