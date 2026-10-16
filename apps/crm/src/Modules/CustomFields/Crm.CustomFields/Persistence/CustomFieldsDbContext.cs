using Crm.CustomFields.Domain;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.CustomFields.Persistence;

public sealed class CustomFieldsDbContext(DbContextOptions<CustomFieldsDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "customfields";

    public override string Schema => SchemaName;

    public DbSet<CustomFieldDefinition> Definitions => Set<CustomFieldDefinition>();

    public DbSet<CustomFieldValue> Values => Set<CustomFieldValue>();

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<CustomFieldDefinition>(b =>
        {
            b.ToTable("CustomFieldDefinitions");
            b.ConfigureAuditable();
            b.Property(x => x.Entity).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Key).HasMaxLength(64);
            b.Property(x => x.Label).HasMaxLength(128);
            b.Property(x => x.Type).HasConversion<string>().HasMaxLength(16);
            b.Property(x => x.Hint).HasMaxLength(256);
            b.Property(x => x.Options);
            b.HasIndex(x => new { x.Entity, x.Key }).IsUnique().HasFilter("[IsDeleted] = 0");
            b.HasIndex(x => new { x.Entity, x.Order });
        });

        modelBuilder.Entity<CustomFieldValue>(b =>
        {
            b.ToTable("CustomFieldValues");
            b.ConfigureAuditable();
            b.Property(x => x.Entity).HasConversion<string>().HasMaxLength(24);
            b.Property(x => x.Value).HasMaxLength(1000);
            b.HasIndex(x => new { x.DefinitionId, x.EntityId }).IsUnique().HasFilter("[IsDeleted] = 0");
            b.HasIndex(x => new { x.Entity, x.EntityId });
        });
    }
}

internal sealed class CustomFieldsDesignTimeFactory() : ModuleDesignTimeFactory<CustomFieldsDbContext>(CustomFieldsDbContext.SchemaName);
