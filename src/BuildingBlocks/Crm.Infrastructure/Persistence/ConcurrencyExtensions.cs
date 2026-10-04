using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Crm.Infrastructure.Persistence;

public static class ConcurrencyExtensions
{
    /// <summary>
    /// ETag from the row version. The entity must be tracked: shadow properties such as RowVersion are not
    /// materialized by no-tracking queries.
    /// </summary>
    public static string GetETag(this DbContext context, object entity)
    {
        var entry = context.Entry(entity);
        if (entry.State == EntityState.Detached)
        {
            throw new InvalidOperationException($"{entity.GetType().Name} must be tracked to read its row version for an ETag.");
        }

        var version = (byte[]?)entry.Property(ModuleDbContext.RowVersionProperty).CurrentValue
                      ?? throw new InvalidOperationException($"{entity.GetType().Name} has no row version yet.");
        return $"\"{Convert.ToBase64String(version)}\"";
    }

    /// <summary>
    /// Makes the next SaveChanges fail with <see cref="DbUpdateConcurrencyException"/> if the row changed since the
    /// client read it. Returns false when the ETag is not in a recognizable format.
    /// </summary>
    public static bool ApplyIfMatch(this DbContext context, object entity, string ifMatch)
    {
        var trimmed = ifMatch.Trim();
        if (trimmed.StartsWith("W/", StringComparison.Ordinal))
        {
            trimmed = trimmed[2..];
        }

        trimmed = trimmed.Trim('"');
        byte[] version;
        try
        {
            version = Convert.FromBase64String(trimmed);
        }
        catch (FormatException)
        {
            return false;
        }

        context.Entry(entity).Property(ModuleDbContext.RowVersionProperty).OriginalValue = version;
        return true;
    }

    /// <summary>A unique index refused the row: somebody else inserted the same value at the same moment.</summary>
    public static bool IsUniqueViolation(this DbUpdateException exception) => exception.InnerException is SqlException { Number: 2601 or 2627 };

    /// <summary>
    /// After <see cref="ApplyIfMatch"/>: true when the client's version is not the row just read, so a command can be refused
    /// before it does any work. The row version check of SaveChanges still guards a change that comes in between.
    /// </summary>
    public static bool IsStale(this DbContext context, object entity)
    {
        var property = context.Entry(entity).Property(ModuleDbContext.RowVersionProperty);
        return !((byte[]?)property.OriginalValue ?? []).AsSpan().SequenceEqual((byte[]?)property.CurrentValue ?? []);
    }
}
