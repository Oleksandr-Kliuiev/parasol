using System.Linq.Expressions;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Crm.Infrastructure.Persistence;

/// <summary>Base for module DbContexts: one schema per module, outbox, audit table, row versions, soft delete.</summary>
public abstract class ModuleDbContext(DbContextOptions options) : DbContext(options)
{
    public const string RowVersionProperty = "RowVersion";

    /// <summary>Database schema owned by the module, e.g. <c>customers</c>.</summary>
    public abstract string Schema { get; }

    public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();

    public DbSet<AuditEntry> AuditEntries => Set<AuditEntry>();

    /// <summary>Whether this context owns the audit table migration (only the Audit module).</summary>
    protected virtual bool OwnsAuditTable => false;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema(Schema);
        ConfigureModule(modelBuilder);

        modelBuilder.Entity<OutboxMessage>(b =>
        {
            b.ToTable("OutboxMessages");
            b.HasKey(x => x.Id);
            b.Property(x => x.Type).HasMaxLength(500);
            b.Property(x => x.CorrelationId).HasMaxLength(64);
            b.HasIndex(x => new { x.ProcessedAt, x.OccurredAt });
        });

        modelBuilder.Entity<AuditEntry>(b =>
        {
            b.ToTable("AuditEntries", "audit", t =>
            {
                if (!OwnsAuditTable)
                {
                    t.ExcludeFromMigrations();
                }
            });
            b.HasKey(x => x.Id);
            b.Property(x => x.Id).UseIdentityColumn();
            b.Property(x => x.Action).HasMaxLength(32);
            b.Property(x => x.Module).HasMaxLength(64);
            b.Property(x => x.EntityType).HasMaxLength(128);
            b.Property(x => x.UserName).HasMaxLength(256);
            b.Property(x => x.CorrelationId).HasMaxLength(64);
            b.Property(x => x.IpAddress).HasMaxLength(64);
            b.HasIndex(x => new { x.EntityType, x.EntityId });
            b.HasIndex(x => x.At);
            b.HasIndex(x => x.UserId);
        });

        foreach (var entityType in modelBuilder.Model.GetEntityTypes())
        {
            var clrType = entityType.ClrType;
            if (!typeof(Entity).IsAssignableFrom(clrType) || entityType.IsOwned() || entityType.BaseType is not null)
            {
                continue;
            }

            modelBuilder.Entity(clrType).Property<byte[]>(RowVersionProperty).IsRowVersion();
            modelBuilder.Entity(clrType).Ignore(nameof(Entity.DomainEvents));

            if (typeof(ISoftDeletable).IsAssignableFrom(clrType))
            {
                var parameter = Expression.Parameter(clrType, "e");
                var filter = Expression.Lambda(
                    Expression.Not(Expression.Property(parameter, nameof(ISoftDeletable.IsDeleted))),
                    parameter);
                modelBuilder.Entity(clrType).HasQueryFilter(filter);
            }
        }
    }

    protected abstract void ConfigureModule(ModelBuilder modelBuilder);
}

public static class EntityTypeBuilderExtensions
{
    /// <summary>Standard mapping for <see cref="AuditableEntity"/> columns.</summary>
    public static EntityTypeBuilder<T> ConfigureAuditable<T>(this EntityTypeBuilder<T> builder)
        where T : AuditableEntity
    {
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Id).ValueGeneratedNever();
        builder.Property(x => x.CreatedAt);
        builder.Property(x => x.CreatedBy);
        builder.Property(x => x.ModifiedAt);
        builder.Property(x => x.ModifiedBy);
        builder.Property(x => x.IsDeleted);
        return builder;
    }
}
