using System.Text.Json;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Crm.Infrastructure.Persistence;

/// <summary>
/// On save: stamps audit columns, writes <see cref="AuditEntry"/> rows with a field-level diff and moves raised
/// domain events into the module outbox — all inside the same SaveChanges transaction.
/// </summary>
public sealed class AuditingInterceptor(ICurrentUser currentUser, IRequestContext requestContext, TimeProvider timeProvider)
    : SaveChangesInterceptor
{
    private static readonly HashSet<string> IgnoredProperties =
    [
        ModuleDbContext.RowVersionProperty,
        nameof(ISoftDeletable.IsDeleted), // conveyed by the Delete action
        nameof(IAuditable.CreatedAt), nameof(IAuditable.CreatedBy), nameof(IAuditable.ModifiedAt), nameof(IAuditable.ModifiedBy),
    ];

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        if (eventData.Context is ModuleDbContext context)
        {
            Process(context);
        }

        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result)
    {
        if (eventData.Context is ModuleDbContext context)
        {
            Process(context);
        }

        return base.SavingChanges(eventData, result);
    }

    private void Process(ModuleDbContext context)
    {
        var now = timeProvider.GetUtcNow();
        var module = context.Schema;
        var audits = new List<AuditEntry>();
        var outbox = new List<OutboxMessage>();

        foreach (var entry in context.ChangeTracker.Entries<Entity>().ToList())
        {
            if (entry.State is EntityState.Added or EntityState.Modified && entry.Entity is IAuditable)
            {
                StampAuditColumns(entry, now);
            }

            var action = ResolveAction(entry);
            if (action is not null && entry.Entity is IAuditable)
            {
                audits.Add(new AuditEntry
                {
                    At = now,
                    UserId = currentUser.UserId,
                    UserName = currentUser.DisplayName,
                    Action = action,
                    Module = module,
                    EntityType = entry.Metadata.ClrType.Name,
                    EntityId = entry.Entity.Id,
                    Changes = SerializeChanges(entry),
                    CorrelationId = requestContext.CorrelationId,
                    IpAddress = requestContext.IpAddress,
                });
            }

            foreach (var domainEvent in entry.Entity.DomainEvents)
            {
                outbox.Add(OutboxMessage.For(domainEvent, now, requestContext.CorrelationId));
            }

            entry.Entity.ClearDomainEvents();
        }

        context.AuditEntries.AddRange(audits);
        context.OutboxMessages.AddRange(outbox);
    }

    private void StampAuditColumns(EntityEntry<Entity> entry, DateTimeOffset now)
    {
        if (entry.State == EntityState.Added)
        {
            entry.Property(nameof(IAuditable.CreatedAt)).CurrentValue = now;
            entry.Property(nameof(IAuditable.CreatedBy)).CurrentValue = currentUser.UserId;
        }
        else
        {
            entry.Property(nameof(IAuditable.ModifiedAt)).CurrentValue = now;
            entry.Property(nameof(IAuditable.ModifiedBy)).CurrentValue = currentUser.UserId;
        }
    }

    private static string? ResolveAction(EntityEntry<Entity> entry) => entry.State switch
    {
        EntityState.Added => AuditActions.Create,
        EntityState.Deleted => AuditActions.Delete,
        EntityState.Modified when entry.Entity is ISoftDeletable &&
                                  entry.Property(nameof(ISoftDeletable.IsDeleted)) is { IsModified: true, CurrentValue: true }
            => AuditActions.Delete,
        EntityState.Modified when HasAuditableChanges(entry) => AuditActions.Update,
        _ => null,
    };

    private static bool HasAuditableChanges(EntityEntry entry) =>
        entry.Properties.Any(p => p.IsModified && !IgnoredProperties.Contains(p.Metadata.Name) && !Equals(p.OriginalValue, p.CurrentValue)) ||
        entry.ComplexProperties.Any(HasAuditableChanges);

    private static bool HasAuditableChanges(ComplexPropertyEntry complex) =>
        complex.Properties.Any(p => p.IsModified && !Equals(p.OriginalValue, p.CurrentValue)) ||
        complex.ComplexProperties.Any(HasAuditableChanges);

    private static string? SerializeChanges(EntityEntry entry)
    {
        var changes = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        bool added = entry.State == EntityState.Added;

        foreach (var property in entry.Properties)
        {
            AddChange(changes, property.Metadata.Name, property, added);
        }

        foreach (var complex in entry.ComplexProperties)
        {
            AddComplex(changes, complex.Metadata.Name, complex, added);
        }

        return changes.Count == 0 ? null : JsonSerializer.Serialize(changes, JsonOptions);
    }

    private static void AddComplex(SortedDictionary<string, object?> changes, string prefix, ComplexPropertyEntry complex, bool added)
    {
        foreach (var property in complex.Properties)
        {
            AddChange(changes, $"{prefix}.{property.Metadata.Name}", property, added);
        }

        foreach (var nested in complex.ComplexProperties)
        {
            AddComplex(changes, $"{prefix}.{nested.Metadata.Name}", nested, added);
        }
    }

    private static void AddChange(SortedDictionary<string, object?> changes, string name, PropertyEntry property, bool added)
    {
        if (IgnoredProperties.Contains(property.Metadata.Name) || property.Metadata.IsPrimaryKey())
        {
            return;
        }

        if (added)
        {
            if (property.CurrentValue is not null and not System.Collections.ICollection { Count: 0 })
            {
                changes[name] = new { New = property.CurrentValue };
            }
        }
        else if (property.IsModified && !Equals(property.OriginalValue, property.CurrentValue))
        {
            changes[name] = new { Old = property.OriginalValue, New = property.CurrentValue };
        }
    }
}
