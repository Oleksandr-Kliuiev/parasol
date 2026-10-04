using System.Text.Json;
using Crm.Customers.Domain;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Crm.Customers.Persistence;

public sealed class CustomersDbContext(DbContextOptions<CustomersDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "customers";

    public override string Schema => SchemaName;

    public DbSet<Organization> Organizations => Set<Organization>();

    public DbSet<Contact> Contacts => Set<Contact>();

    public DbSet<OrganizationContact> OrganizationContacts => Set<OrganizationContact>();

    public DbSet<OrganizationMerge> OrganizationMerges => Set<OrganizationMerge>();

    public DbSet<DuplicateDismissal> DuplicateDismissals => Set<DuplicateDismissal>();

    private static readonly JsonSerializerOptions SnapshotJson = new(JsonSerializerDefaults.Web);

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Organization>(b =>
        {
            b.ToTable("Organizations");
            b.ConfigureAuditable();
            b.Property(x => x.Name).HasMaxLength(256);
            b.Property(x => x.OrgNumber).HasMaxLength(9).IsFixedLength();
            b.Property(x => x.LegalForm).HasMaxLength(16);
            b.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.NaceCode).HasMaxLength(16);
            b.Property(x => x.Website).HasMaxLength(256);
            b.Property(x => x.Phone).HasMaxLength(32);
            b.Property(x => x.Email).HasMaxLength(256);
            b.Property(x => x.InvoiceEmail).HasMaxLength(256);
            b.Property(x => x.RegistryStatus).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Domains);
            MapAddress(b.ComplexProperty(x => x.PostalAddress));
            MapAddress(b.ComplexProperty(x => x.VisitAddress));
            MapAddress(b.ComplexProperty(x => x.BillingAddress));

            b.HasIndex(x => x.OrgNumber).IsUnique().HasFilter("[OrgNumber] IS NOT NULL AND [IsDeleted] = 0");
            b.HasIndex(x => new { x.Name, x.Id });
            b.HasIndex(x => x.AccountManagerId);
            b.HasIndex(x => x.MergedIntoId).HasFilter("[MergedIntoId] IS NOT NULL");
            b.HasIndex(x => x.ParentId).HasFilter("[ParentId] IS NOT NULL");
        });

        modelBuilder.Entity<OrganizationMerge>(b =>
        {
            b.ToTable("OrganizationMerges");
            b.ConfigureAuditable();
            b.Property(x => x.TargetBefore).HasConversion(
                v => JsonSerializer.Serialize(v, SnapshotJson),
                v => JsonSerializer.Deserialize<OrganizationSnapshot>(v, SnapshotJson)!);
            b.Property(x => x.SourceBefore).HasConversion(
                v => JsonSerializer.Serialize(v, SnapshotJson),
                v => JsonSerializer.Deserialize<OrganizationSnapshot>(v, SnapshotJson)!);
            b.Property(x => x.MovedAffiliationIds);
            b.HasIndex(x => x.TargetId);
            b.HasIndex(x => x.SourceId);
        });

        modelBuilder.Entity<DuplicateDismissal>(b =>
        {
            b.ToTable("DuplicateDismissals");
            b.ConfigureAuditable();
            b.HasIndex(x => new { x.FirstOrganizationId, x.SecondOrganizationId }).IsUnique();
        });

        modelBuilder.Entity<Contact>(b =>
        {
            b.ToTable("Contacts");
            b.ConfigureAuditable();
            b.Property(x => x.FirstName).HasMaxLength(128);
            b.Property(x => x.LastName).HasMaxLength(128);
            b.Property(x => x.Email).HasMaxLength(256);
            b.Property(x => x.Phone).HasMaxLength(32);
            b.Property(x => x.MobilePhone).HasMaxLength(32);
            b.Property(x => x.PreferredLanguage).HasMaxLength(8);
            b.Ignore(x => x.FullName);
            b.Ignore(x => x.IsPseudonymized);
            b.HasMany(x => x.Affiliations).WithOne().HasForeignKey(x => x.ContactId).OnDelete(DeleteBehavior.Cascade);
            b.Navigation(x => x.Affiliations).HasField("_affiliations").UsePropertyAccessMode(PropertyAccessMode.Field);
            b.HasIndex(x => x.Email).IsUnique().HasFilter("[Email] IS NOT NULL AND [IsDeleted] = 0");
            b.HasIndex(x => new { x.LastName, x.FirstName });
        });

        modelBuilder.Entity<OrganizationContact>(b =>
        {
            b.ToTable("OrganizationContacts");
            b.ConfigureAuditable();
            b.Property(x => x.Title).HasMaxLength(128);
            b.Property(x => x.Roles).HasConversion<int>();
            b.HasOne<Organization>().WithMany().HasForeignKey(x => x.OrganizationId).OnDelete(DeleteBehavior.Restrict);
            b.HasIndex(x => new { x.OrganizationId, x.ContactId }).IsUnique();
        });
    }

    private static void MapAddress(ComplexPropertyBuilder<Address> address)
    {
        address.Property(a => a.Street).HasMaxLength(256);
        address.Property(a => a.PostalCode).HasMaxLength(16);
        address.Property(a => a.City).HasMaxLength(128);
        address.Property(a => a.CountryCode).HasMaxLength(2);
    }
}

internal sealed class CustomersDesignTimeFactory() : ModuleDesignTimeFactory<CustomersDbContext>(CustomersDbContext.SchemaName);
