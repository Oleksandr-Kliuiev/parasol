using Crm.Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Persistence;

public sealed partial class BillingDbContext
{
    public DbSet<InvoiceDocument> InvoiceDocuments => Set<InvoiceDocument>();
    public DbSet<InvoiceDocumentCheck> InvoiceDocumentChecks => Set<InvoiceDocumentCheck>();

    private static void ConfigureInvoiceDocuments(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<InvoiceDocument>(b =>
        {
            b.ToTable("InvoiceDocuments");
            b.HasKey(d => d.Id);
            b.Property(d => d.Id).ValueGeneratedNever();
            b.Property(d => d.SourceName).HasMaxLength(240).UseCollation("Latin1_General_100_BIN2");
            b.Property(d => d.ContentSha256).HasMaxLength(64);
            b.Property(d => d.ObjectKey).HasMaxLength(256);
            b.HasIndex(d => new { d.InvoiceId, d.SourceName, d.ContentSha256 }).IsUnique();
            b.HasOne<Invoice>().WithMany().HasForeignKey(d => d.InvoiceId).OnDelete(DeleteBehavior.Restrict);
        });
        modelBuilder.Entity<InvoiceDocumentCheck>(b =>
        {
            b.ToTable("InvoiceDocumentChecks");
            b.HasKey(d => d.InvoiceId);
            b.Property(d => d.InvoiceId).ValueGeneratedNever();
            b.HasOne<Invoice>().WithMany().HasForeignKey(d => d.InvoiceId).OnDelete(DeleteBehavior.Restrict);
        });
    }
}
