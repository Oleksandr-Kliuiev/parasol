using Crm.Infrastructure.Persistence;

namespace Crm.Integrations.Core.Persistence;

/// <summary>
/// The vendor action log is the journal of what people asked vendors to do (M39.1): the application updates an action while it is
/// sent and settled, and retention empties its parameters, but no runtime identity deletes one.
/// </summary>
internal sealed class IntegrationDatabasePermissions : IDatabasePermissionRules
{
    public IEnumerable<string> Statements =>
    [
        DatabasePermissions.IfTable(IntegrationDbContext.SchemaName, "VendorActions",
            $"DENY DELETE ON OBJECT::[integration].[VendorActions] TO [{DatabaseRoles.Runtime}];"),
    ];
}
