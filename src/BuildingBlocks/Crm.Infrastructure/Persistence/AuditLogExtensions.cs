using System.Text.Json;
using Crm.SharedKernel.Application;

namespace Crm.Infrastructure.Persistence;

public static class AuditLogExtensions
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Records an action that changes no entity (export, merge decision…) in the audit log.
    /// The entry is saved with the context's next SaveChanges.
    /// </summary>
    public static void RecordAudit(
        this ModuleDbContext context,
        ICurrentUser user,
        IRequestContext request,
        TimeProvider time,
        string action,
        string entityType,
        Guid entityId,
        object? details)
    {
        context.AuditEntries.Add(new AuditEntry
        {
            At = time.GetUtcNow(),
            UserId = user.UserId,
            UserName = user.DisplayName,
            Action = action,
            Module = context.Schema,
            EntityType = entityType,
            EntityId = entityId,
            Changes = details is null ? null : JsonSerializer.Serialize(details, JsonOptions),
            CorrelationId = request.CorrelationId,
            IpAddress = request.IpAddress,
        });
    }
}
