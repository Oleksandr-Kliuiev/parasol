using Crm.Infrastructure.Persistence;

namespace Crm.Sales.Persistence;

/// <summary>Quote documents are evidence of what a customer was offered: the application deletes none (DEV-08).</summary>
internal sealed class SalesDatabasePermissions : IDatabasePermissionRules
{
    public IEnumerable<string> Statements =>
    [
        DatabasePermissions.IfTable(SalesDbContext.SchemaName, "QuoteDocuments", $"DENY DELETE ON OBJECT::[sales].[QuoteDocuments] TO [{DatabaseRoles.Runtime}];"),
    ];
}
