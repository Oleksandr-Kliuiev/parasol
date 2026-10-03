using Crm.Infrastructure.Persistence;
using Crm.Sales.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Sales.Persistence;

public sealed class SalesDbContext(DbContextOptions<SalesDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "sales";

    public const string QuoteNumberSequence = "QuoteNumbers";

    /// <summary>Default stages seeded by the initial migration (docs/02 §4.3).</summary>
    public static readonly (Guid Id, string Name, int Probability, int Order, bool Won, bool Lost)[] DefaultStages =
    [
        (new Guid("00000000-0000-0000-0000-00000000551a"), "Qualification", 10, 1, false, false),
        (new Guid("00000000-0000-0000-0000-00000000552a"), "Needs analysis", 25, 2, false, false),
        (new Guid("00000000-0000-0000-0000-00000000553a"), "Quote sent", 50, 3, false, false),
        (new Guid("00000000-0000-0000-0000-00000000554a"), "Negotiation", 75, 4, false, false),
        (new Guid("00000000-0000-0000-0000-00000000555a"), "Won", 100, 5, true, false),
        (new Guid("00000000-0000-0000-0000-00000000556a"), "Lost", 0, 6, false, true),
    ];

    public override string Schema => SchemaName;

    public DbSet<PipelineStage> PipelineStages => Set<PipelineStage>();

    public DbSet<Lead> Leads => Set<Lead>();

    public DbSet<Opportunity> Opportunities => Set<Opportunity>();

    public DbSet<Quote> Quotes => Set<Quote>();

    public DbSet<QuoteLine> QuoteLines => Set<QuoteLine>();

    public DbSet<QuoteTemplate> QuoteTemplates => Set<QuoteTemplate>();

    /// <summary>Next quote number, e.g. T-2026-0042 ("tilbud"). All versions of a quote keep the number they were given.</summary>
    public async Task<string> NextQuoteNumberAsync(int year, CancellationToken cancellationToken)
    {
        // Not composed (no SingleAsync): SQL Server does not allow NEXT VALUE FOR inside a subquery.
        var values = await Database
            .SqlQueryRaw<long>($"SELECT NEXT VALUE FOR [{SchemaName}].[{QuoteNumberSequence}] AS [Value]")
            .ToListAsync(cancellationToken);
        return string.Create(System.Globalization.CultureInfo.InvariantCulture, $"T-{year}-{values.Single():0000}");
    }

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.HasSequence<long>(QuoteNumberSequence, SchemaName).StartsAt(1).IncrementsBy(1);

        modelBuilder.Entity<PipelineStage>(b =>
        {
            b.ToTable("PipelineStages");
            b.ConfigureAuditable();
            b.Property(x => x.Name).HasMaxLength(64);
            b.HasIndex(x => x.Order);
        });

        modelBuilder.Entity<Lead>(b =>
        {
            b.ToTable("Leads");
            b.ConfigureAuditable();
            b.Property(x => x.CompanyName).HasMaxLength(256);
            b.Property(x => x.OrgNumber).HasMaxLength(16);
            b.Property(x => x.ContactName).HasMaxLength(256);
            b.Property(x => x.Email).HasMaxLength(256);
            b.Property(x => x.Phone).HasMaxLength(32);
            b.Property(x => x.Source).HasMaxLength(64);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Notes).HasMaxLength(4000);
            b.Property(x => x.DisqualifyReason).HasMaxLength(256);
            b.HasIndex(x => new { x.Status, x.CreatedAt });
            b.HasIndex(x => x.OwnerId);
        });

        modelBuilder.Entity<Opportunity>(b =>
        {
            b.ToTable("Opportunities");
            b.ConfigureAuditable();
            b.Property(x => x.Name).HasMaxLength(256);
            b.Property(x => x.BusinessLine).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.OneOffAmount).HasPrecision(18, 2);
            b.Property(x => x.Mrr).HasPrecision(18, 2);
            b.Property(x => x.Source).HasMaxLength(64);
            b.Property(x => x.Competitor).HasMaxLength(128);
            b.Property(x => x.LostReason).HasMaxLength(256);
            b.Ignore(x => x.ForecastAmount);
            b.HasOne<PipelineStage>().WithMany().HasForeignKey(x => x.StageId).OnDelete(DeleteBehavior.Restrict);
            b.HasIndex(x => new { x.Status, x.ExpectedCloseDate });
            b.HasIndex(x => new { x.OrganizationId, x.Status });
            b.HasIndex(x => x.OwnerId);
            b.HasIndex(x => x.StageId);
        });

        modelBuilder.Entity<QuoteTemplate>(b =>
        {
            b.ToTable("QuoteTemplates");
            b.ConfigureAuditable();
            b.Property(x => x.Name).HasMaxLength(128);
            b.Property(x => x.Language).HasMaxLength(8);
            b.Property(x => x.IntroText).HasMaxLength(4000);
            b.Property(x => x.TermsText).HasMaxLength(8000);
            b.Property(x => x.FooterText).HasMaxLength(512);
            b.HasIndex(x => new { x.Language, x.IsActive });
        });

        modelBuilder.Entity<Quote>(b =>
        {
            b.ToTable("Quotes");
            b.ConfigureAuditable();
            b.Property(x => x.Number).HasMaxLength(32);
            b.Property(x => x.Title).HasMaxLength(256);
            b.Property(x => x.Language).HasMaxLength(8);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.MaxDiscountPct).HasPrecision(5, 2);
            b.Property(x => x.IntroText).HasMaxLength(4000);
            b.Property(x => x.TermsText).HasMaxLength(8000);
            b.Property(x => x.CustomerReference).HasMaxLength(128);
            b.Property(x => x.RejectedReason).HasMaxLength(512);
            b.Property(x => x.SentTo).HasMaxLength(256);
            b.Property(x => x.DeclineReason).HasMaxLength(512);
            b.Ignore(x => x.OneTimeExVat);
            b.Ignore(x => x.MonthlyExVat);
            b.Ignore(x => x.OneTimeVat);
            b.Ignore(x => x.MonthlyVat);
            b.Ignore(x => x.ContractValue);
            b.Ignore(x => x.IsEditable);
            b.Ignore(x => x.HasDocument);
            b.HasMany(x => x.Lines).WithOne().HasForeignKey(x => x.QuoteId).OnDelete(DeleteBehavior.Cascade);
            b.Navigation(x => x.Lines).HasField("_lines").UsePropertyAccessMode(PropertyAccessMode.Field);
            b.HasIndex(x => new { x.Number, x.VersionNo }).IsUnique();
            b.HasIndex(x => new { x.RootId, x.VersionNo });
            b.HasIndex(x => new { x.OrganizationId, x.Status });
            b.HasIndex(x => new { x.Status, x.ValidUntil });
            b.HasIndex(x => x.OpportunityId);
            b.HasIndex(x => x.OwnerId);
        });

        modelBuilder.Entity<QuoteLine>(b =>
        {
            b.ToTable("QuoteLines");
            // Ids come from the domain (SequentialId), so EF must not treat a line with an id as an existing row.
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Sku).HasMaxLength(64);
            b.Property(x => x.Name).HasMaxLength(256);
            b.Property(x => x.Description).HasMaxLength(1000);
            b.Property(x => x.Quantity).HasPrecision(18, 2);
            b.Property(x => x.UnitPrice).HasPrecision(18, 2);
            b.Property(x => x.DiscountPct).HasPrecision(5, 2);
            b.Property(x => x.VatRate).HasPrecision(5, 2);
            b.Property(x => x.Recurrence).HasConversion<string>().HasMaxLength(16);
            b.Ignore(x => x.NetAmount);
            b.HasIndex(x => x.QuoteId);
            b.HasIndex(x => x.ProductId);
        });
    }
}

internal sealed class SalesDesignTimeFactory() : ModuleDesignTimeFactory<SalesDbContext>(SalesDbContext.SchemaName);
