using Crm.Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Persistence;

public sealed partial class BillingDbContext
{
    private static void ConfigureCustomerLedger(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<CustomerLedgerSnapshot>(b =>
        {
            b.ToTable("CustomerLedgerSnapshots");
            b.HasKey(s => new { s.System, s.CustomerKey });
            b.Property(s => s.System).HasMaxLength(32);
            b.Property(s => s.CustomerKey).HasMaxLength(64);
            b.HasIndex(s => s.OrganizationId);
        });
        modelBuilder.Entity<CustomerLedgerEntry>(b =>
        {
            b.ToTable("CustomerLedgerEntries");
            b.HasKey(e => e.Id);
            b.Property(e => e.Id).ValueGeneratedNever();
            b.Property(e => e.System).HasMaxLength(32);
            b.Property(e => e.CustomerKey).HasMaxLength(64);
            b.Property(e => e.Kind).HasConversion<string>().HasMaxLength(24);
            b.Ignore(e => e.Source);
            b.HasIndex(e => new { e.System, e.ExternalId }).IsUnique();
            b.HasIndex(e => new { e.System, e.CustomerKey, e.LastSeenScanId, e.MatchId });
            b.HasIndex(e => new { e.System, e.VoucherId });
            b.HasOne<CustomerLedgerSnapshot>().WithMany().HasForeignKey(e => new { e.System, e.CustomerKey }).OnDelete(DeleteBehavior.Restrict);
            b.HasMany(e => e.Versions).WithOne().HasForeignKey(v => v.EntryId).OnDelete(DeleteBehavior.Restrict);
        });
        modelBuilder.Entity<CustomerLedgerVersion>(b =>
        {
            b.ToTable("CustomerLedgerVersions");
            b.HasKey(v => v.Id);
            b.Property(v => v.Id).ValueGeneratedNever();
            b.HasIndex(v => new { v.EntryId, v.ObservedAt });
        });
    }
}
