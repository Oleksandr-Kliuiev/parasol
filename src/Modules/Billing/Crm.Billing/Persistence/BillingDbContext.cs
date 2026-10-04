using Crm.Billing.Domain;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Persistence;

public sealed class BillingDbContext(DbContextOptions<BillingDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "billing";

    public override string Schema => SchemaName;

    public DbSet<BillingRun> BillingRuns => Set<BillingRun>();

    public DbSet<BillingBasis> BillingBases => Set<BillingBasis>();

    public DbSet<BillingLine> BillingLines => Set<BillingLine>();

    public DbSet<BillingExportAttempt> ExportAttempts => Set<BillingExportAttempt>();

    public DbSet<Invoice> Invoices => Set<Invoice>();

    public DbSet<InvoicePayment> InvoicePayments => Set<InvoicePayment>();

    public DbSet<PendingCharge> PendingCharges => Set<PendingCharge>();

    public DbSet<BillingApproval> BillingApprovals => Set<BillingApproval>();

    public DbSet<Charge> Charges => Set<Charge>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<PendingCharge>(b =>
        {
            b.ToTable("PendingCharges");
            b.ConfigureAuditable();
            b.Property(x => x.Description).HasMaxLength(512);
            b.Property(x => x.SourceType).HasMaxLength(32);
            b.Property(x => x.Quantity).HasPrecision(18, 2);
            b.Property(x => x.UnitPrice).HasPrecision(18, 2);
            b.Property(x => x.DiscountPct).HasPrecision(5, 2);
            b.Property(x => x.VatRate).HasPrecision(5, 2);
            b.Property(x => x.Reason).HasMaxLength(512);
            b.HasIndex(x => new { x.SourceType, x.SourceId, x.SourceLineId }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.InvoicedBasisId });
        });

        modelBuilder.Entity<Charge>(b =>
        {
            b.ToTable("Charges", t => t.HasTrigger(BillingTriggers.Charges));
            b.ConfigureAuditable();
            b.Property(x => x.Key).HasMaxLength(200);
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(32);
            b.Property(x => x.Currency).HasMaxLength(3);
            b.Property(x => x.Amount).HasPrecision(18, 2);
            b.Property(x => x.Reason).HasMaxLength(512);
            b.Ignore(x => x.IsActive);
            // ADR-013: one active charge per obligation; released ones stay as the record of what happened.
            b.HasIndex(x => x.Key).IsUnique().HasFilter("[Status] <> 'Released' AND [IsDeleted] = 0");
            b.HasIndex(x => new { x.SeriesId, x.ServiceFrom });
            b.HasIndex(x => x.ContractLineId);
            b.HasIndex(x => x.BasisId);
            b.HasIndex(x => new { x.RunId, x.Status });
        });

        modelBuilder.Entity<BillingRun>(b =>
        {
            b.ToTable("BillingRuns", t => t.HasTrigger(BillingTriggers.Runs));
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Notes).HasMaxLength(1024);
            // BR-BIL-01: only one run per period may be open.
            b.HasIndex(x => x.PeriodStart).IsUnique().HasFilter("[Status] <> 'Closed' AND [IsDeleted] = 0");
            b.HasIndex(x => x.Status);
            b.Property(x => x.ApprovedDigest).HasMaxLength(64);
            b.HasMany(x => x.Approvals).WithOne().HasForeignKey(a => a.RunId).OnDelete(DeleteBehavior.Restrict);
            b.Ignore(x => x.CurrentApprovals);
        });

        modelBuilder.Entity<BillingApproval>(b =>
        {
            b.ToTable("BillingApprovals", t => t.HasTrigger(BillingTriggers.Approvals));
            b.ConfigureAuditable();
            b.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.ContentDigest).HasMaxLength(64);
            b.Property(x => x.Policy).HasMaxLength(128);
            b.Property(x => x.InvalidationReason).HasMaxLength(64);
            b.HasIndex(x => new { x.RunId, x.ContentRevision });
        });

        modelBuilder.Entity<BillingBasis>(b =>
        {
            b.ToTable("BillingBases", t => t.HasTrigger(BillingTriggers.Bases));
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.IdempotencyKey).HasMaxLength(128);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(32);
            b.Property(x => x.ExportSystem).HasMaxLength(32);
            b.Property(x => x.OrderNo).HasMaxLength(64);
            b.Property(x => x.CustomerReference).HasMaxLength(128);
            b.Property(x => x.TotalExVat).HasPrecision(18, 2);
            b.Property(x => x.PreviousPeriodTotal).HasPrecision(18, 2);
            b.HasIndex(x => x.IdempotencyKey).IsUnique();
            b.HasIndex(x => new { x.RunId, x.OrganizationId });
            b.HasIndex(x => x.Status);
            b.HasMany(x => x.Lines).WithOne().HasForeignKey(l => l.BasisId).OnDelete(DeleteBehavior.Cascade);
            b.HasMany(x => x.Attempts).WithOne().HasForeignKey(a => a.BasisId).OnDelete(DeleteBehavior.Cascade);
            b.Ignore(x => x.CurrentLines);
            b.Ignore(x => x.BilledLines);
            b.Ignore(x => x.ConflictCount);
            b.Ignore(x => x.Anomalies);
        });

        modelBuilder.Entity<BillingLine>(b =>
        {
            b.ToTable("BillingLines", t => t.HasTrigger(BillingTriggers.Lines));
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Group).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.ProductCode).HasMaxLength(64);
            b.Property(x => x.Description).HasMaxLength(512);
            b.Property(x => x.Quantity).HasPrecision(18, 2);
            b.Property(x => x.UnitPrice).HasPrecision(18, 4);
            b.Property(x => x.DiscountPct).HasPrecision(5, 2);
            b.Property(x => x.VatRate).HasPrecision(5, 2);
            b.Property(x => x.LineTotal).HasPrecision(18, 2);
            b.Property(x => x.Origin).HasConversion<string>().HasMaxLength(16).HasDefaultValue(BillingLineOrigin.Collected).HasSentinel(BillingLineOrigin.Collected);
            b.Property(x => x.SourceKey).HasMaxLength(128);
            b.Property(x => x.SourceSignature).HasMaxLength(256);
            b.Property(x => x.SourceDescription).HasMaxLength(512);
            b.Property(x => x.SourceQuantity).HasPrecision(18, 2);
            b.Property(x => x.SourceUnitPrice).HasPrecision(18, 4);
            b.Property(x => x.SourceDiscountPct).HasPrecision(5, 2);
            b.Property(x => x.Decision).HasConversion<string>().HasMaxLength(16).HasDefaultValue(BillingLineDecision.None).HasSentinel(BillingLineDecision.None);
            b.Property(x => x.DecisionSignature).HasMaxLength(256);
            b.Property(x => x.Conflict).HasConversion<string>().HasMaxLength(24).HasDefaultValue(BillingLineConflict.None).HasSentinel(BillingLineConflict.None);
            b.Property(x => x.ChangeReason).HasMaxLength(512);
            b.Ignore(x => x.SourceLineTotal);
            b.HasIndex(x => x.BasisId);
            b.HasIndex(x => x.ProductId);
            // ADR-011: one current line per charge key in a basis, whatever two parallel collects do.
            b.HasIndex(x => new { x.BasisId, x.SourceKey }).IsUnique().HasFilter("[SourceKey] IS NOT NULL AND [IsDeleted] = 0");
        });

        modelBuilder.Entity<BillingExportAttempt>(b =>
        {
            b.ToTable("BillingExportAttempts", t => t.HasTrigger(BillingTriggers.ExportAttempts));
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Result).HasMaxLength(32);
            b.Property(x => x.Message).HasMaxLength(1024);
            b.Property(x => x.CorrelationId).HasMaxLength(64);
            b.HasIndex(x => x.BasisId);
        });

        modelBuilder.Entity<Invoice>(b =>
        {
            b.ToTable("Invoices");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.System).HasMaxLength(32);
            b.Property(x => x.InvoiceNo).HasMaxLength(64);
            b.Property(x => x.OrderNo).HasMaxLength(64);
            b.Property(x => x.ExternalReference).HasMaxLength(128);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Url).HasMaxLength(512);
            b.Property(x => x.TotalIncVat).HasPrecision(18, 2);
            b.Property(x => x.Outstanding).HasPrecision(18, 2);
            b.HasIndex(x => new { x.System, x.InvoiceNo }).IsUnique();
            b.HasIndex(x => new { x.OrganizationId, x.InvoiceDate });
            // The invoice list's order (DEV-12): date, number, id.
            b.HasIndex(x => new { x.InvoiceDate, x.InvoiceNo, x.Id });
            b.HasIndex(x => x.BasisId);
            b.HasMany(x => x.Payments).WithOne().HasForeignKey(p => p.InvoiceId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<InvoicePayment>(b =>
        {
            b.ToTable("InvoicePayments");
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).ValueGeneratedNever();
            b.Property(x => x.Amount).HasPrecision(18, 2);
            b.HasIndex(x => x.InvoiceId);
        });
    }
}

internal sealed class BillingDesignTimeFactory() : ModuleDesignTimeFactory<BillingDbContext>(BillingDbContext.SchemaName);
