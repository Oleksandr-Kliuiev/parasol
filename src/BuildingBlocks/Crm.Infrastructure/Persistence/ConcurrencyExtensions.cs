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
}
