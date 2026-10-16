using Crm.Infrastructure.Persistence;

namespace Crm.Billing.Persistence;

/// <summary>
/// Financial records keep their history: the application deletes none of them (soft delete only), and export attempts are
/// only ever added. What an approved run or basis contains is guarded by the triggers of migration ProtectApprovedBilling
/// (DEV-04, docs/runbooks/08-database-permissions.md).
/// </summary>
internal sealed class BillingDatabasePermissions : IDatabasePermissionRules
{
    private static readonly string[] NeverDeleted =
        ["BillingRuns", "BillingBases", "BillingLines", "BillingApprovals", "BillingExportAttempts", "Charges", "Invoices", "InvoicePayments", "PendingCharges"];

    public IEnumerable<string> Statements =>
        NeverDeleted.Select(table => DatabasePermissions.IfTable(
                BillingDbContext.SchemaName, table, $"DENY DELETE ON OBJECT::[billing].[{table}] TO [{DatabaseRoles.Runtime}];"))
            .Append(DatabasePermissions.IfTable(
                BillingDbContext.SchemaName, "BillingExportAttempts", $"DENY UPDATE ON OBJECT::[billing].[BillingExportAttempts] TO [{DatabaseRoles.Runtime}];"));
}
