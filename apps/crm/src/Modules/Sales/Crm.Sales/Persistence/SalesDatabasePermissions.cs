using Crm.Infrastructure.Persistence;

namespace Crm.Sales.Persistence;

/// <summary>
/// Quote documents are evidence of what a customer was offered: the application deletes none (DEV-08). Erasing one a privacy
/// case covered is the privacy operator's procedure (DEV-11).
/// </summary>
internal sealed class SalesDatabasePermissions : IDatabasePermissionRules
{
    public IEnumerable<string> Statements =>
    [
        DatabasePermissions.IfTable(SalesDbContext.SchemaName, "QuoteDocuments", $"DENY DELETE ON OBJECT::[sales].[QuoteDocuments] TO [{DatabaseRoles.Runtime}];"),
        $"IF OBJECT_ID(N'[sales].[{SalesTriggers.ClearErasedDocuments}]', N'P') IS NOT NULL GRANT EXECUTE ON OBJECT::[sales].[{SalesTriggers.ClearErasedDocuments}] TO [{DatabaseRoles.Privacy}];",
    ];
}
