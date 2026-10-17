using Crm.Infrastructure.Persistence;

namespace Crm.TimeTracking.Persistence;

/// <summary>Financial create receipts are immutable under both application runtime identities.</summary>
internal sealed class TimeTrackingDatabasePermissions : IDatabasePermissionRules
{
    public IEnumerable<string> Statements =>
    [
        DatabasePermissions.IfTable(TimeTrackingDbContext.SchemaName, "TimeEntryCreateReceipts",
            $"DENY UPDATE, DELETE ON OBJECT::[time].[TimeEntryCreateReceipts] TO [{DatabaseRoles.Runtime}];"),
    ];
}
