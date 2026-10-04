using System.Collections.Frozen;
using System.Security.Claims;

namespace Crm.Authorization;

/// <summary>
/// Fine-grained permissions checked by the API. Roles only exist in Entra ID; this map is the single place
/// that turns roles into permissions (docs/02-functional-spec.md §2).
/// </summary>
public static class Permissions
{
    public const string CustomersRead = "customers.read";
    public const string CustomersWrite = "customers.write";
    public const string CustomersDelete = "customers.delete";
    public const string ContactsWrite = "contacts.write";

    /// <summary>Invoice amounts, outstanding balance, revenue.</summary>
    public const string FinanceRead = "finance.read";

    /// <summary>Cost prices and margins.</summary>
    public const string FinanceCostRead = "finance.cost.read";

    /// <summary>Products and price lists; cost prices additionally need <see cref="FinanceCostRead"/>.</summary>
    public const string CatalogRead = "catalog.read";
    public const string CatalogWrite = "catalog.write";

    /// <summary>Contracts, SLA policies and hour banks; prices additionally need <see cref="FinanceRead"/>.</summary>
    public const string ContractsRead = "contracts.read";
    public const string ContractsWrite = "contracts.write";

    /// <summary>Leads, opportunities, quotes and the pipeline.</summary>
    public const string SalesRead = "sales.read";
    public const string SalesWrite = "sales.write";

    /// <summary>Approve a line discount above the limit of one's own role (BR-SAL-05).</summary>
    public const string SalesDiscountApprove = "sales.discount.approve";

    /// <summary>
    /// Every quote, not only the ones one owns (record scope, DEV-09/SEC-AZ-03). Without it — in the Restricted mode — a role
    /// sees and works on the quotes whose current version it owns, and nothing else.
    /// </summary>
    public const string QuotesAll = "sales.quotes.all";

    /// <summary>Microsoft CSP subscriptions (read-only mirror plus the distributor import).</summary>
    public const string LicensingRead = "licensing.read";
    public const string LicensingManage = "licensing.manage";

    /// <summary>Tasks, calls, meetings and notes.</summary>
    public const string ActivitiesRead = "activities.read";
    public const string ActivitiesWrite = "activities.write";

    /// <summary>Mirror of Atera tickets, devices and alerts.</summary>
    public const string ServiceRead = "service.read";

    /// <summary>Create tickets in Atera from the CRM.</summary>
    public const string ServiceWrite = "service.write";

    /// <summary>Read and write one's own time entries.</summary>
    public const string TimeOwn = "time.own";

    /// <summary>Read everyone's time entries.</summary>
    public const string TimeRead = "time.read";

    /// <summary>Edit anyone's entries, approve them and close periods.</summary>
    public const string TimeManage = "time.manage";

    /// <summary>Reopen a closed period (with a reason, audited).</summary>
    public const string TimeUnlock = "time.unlock";

    /// <summary>Billing runs, bases and invoices; amounts additionally need <see cref="FinanceRead"/>.</summary>
    public const string BillingRead = "billing.read";

    /// <summary>Start and collect a run, adjust bases, export them and close the run.</summary>
    public const string BillingManage = "billing.manage";

    /// <summary>Approve a collected run (BR-BIL-04).</summary>
    public const string BillingApprove = "billing.approve";

    /// <summary>Second approval for bases above the threshold (BR-BIL-04).</summary>
    public const string BillingApproveSecond = "billing.approve.second";

    /// <summary>Dashboards and reports; money on them additionally needs <see cref="FinanceRead"/>.</summary>
    public const string ReportsRead = "reports.read";

    public const string AuditRead = "audit.read";
    /// <summary>Define the company's own fields on records (FR-ADM-04); the values follow the customer permissions.</summary>
    public const string CustomFieldsManage = "customfields.manage";

    /// <summary>Read-only data mart for Power BI (FR-RPT-03); separate from the dashboards because it exports whole tables.</summary>
    public const string ReportsMart = "reports.mart";

    /// <summary>Implementation projects: phases, tasks and their budgets (FR-PRJ-01).</summary>
    public const string ProjectsRead = "projects.read";

    public const string ProjectsWrite = "projects.write";

    /// <summary>
    /// Every project, not only the ones one is on (record scope, DEV-09/SEC-AZ-03). Without it — in the Restricted mode — a role
    /// sees the projects it manages, is a member of or has a task in.
    /// </summary>
    public const string ProjectsAll = "projects.all";

    public const string UsersRead = "users.read";
    public const string IntegrationsManage = "integrations.manage";

    /// <summary>
    /// Data subject requests, legal holds, suppressions and the retention report (DEV-11): separate from customers.write — an
    /// erasure is irreversible and an export hands over everything about a person. Admin only until EXT-07 names the role.
    /// </summary>
    public const string PrivacyManage = "privacy.manage";

    /// <summary>
    /// Read-only maintenance, the restore reconciliation and its checks (DEV-13): stopping every write and deciding what may be
    /// sent again after a restore. Admin only until EXT-04 names the operator role.
    /// </summary>
    public const string OperationsMaintenance = "operations.maintenance";

    private static readonly string[] Everything =
    [
        CustomersRead, CustomersWrite, CustomersDelete, ContactsWrite,
        CatalogRead, CatalogWrite, ContractsRead, ContractsWrite,
        SalesRead, SalesWrite, SalesDiscountApprove, QuotesAll, LicensingRead, LicensingManage, ActivitiesRead, ActivitiesWrite,
        ServiceRead, ServiceWrite, TimeOwn, TimeRead, TimeManage, TimeUnlock,
        BillingRead, BillingManage, BillingApprove, BillingApproveSecond, ReportsRead, ReportsMart, ProjectsRead, ProjectsWrite, ProjectsAll,
        FinanceRead, FinanceCostRead, AuditRead, UsersRead, IntegrationsManage, CustomFieldsManage, PrivacyManage, OperationsMaintenance,
    ];

    // Record scope (DEV-09) follows docs/02 §2 and SEC-AZ-03 until EXT-01 confirms the matrix (ADR-018): quotes — Sales its own,
    // Management and Finance all, the service roles and ReadOnly only quotes they happen to own; projects — technicians the ones
    // they are on, every other role all.

    private static readonly FrozenDictionary<string, FrozenSet<string>> ByRole = new Dictionary<string, FrozenSet<string>>
    {
        [CrmRoles.Admin] = Everything.ToFrozenSet(),
        [CrmRoles.Management] = new[]
        {
            CustomersRead, CustomersWrite, CustomersDelete, ContactsWrite, CatalogRead, ContractsRead, ContractsWrite,
            SalesRead, SalesWrite, SalesDiscountApprove, QuotesAll, LicensingRead, ActivitiesRead, ActivitiesWrite,
            ServiceRead, TimeRead, BillingRead, BillingApproveSecond, ReportsRead, ReportsMart, ProjectsRead, ProjectsWrite, ProjectsAll,
            FinanceRead, FinanceCostRead, AuditRead, UsersRead,
        }.ToFrozenSet(),
        [CrmRoles.Sales] = new[]
        {
            CustomersRead, CustomersWrite, ContactsWrite, CatalogRead, ContractsRead, ContractsWrite, SalesRead, SalesWrite,
            LicensingRead, ActivitiesRead, ActivitiesWrite, ServiceRead, ServiceWrite, TimeOwn, BillingRead, ReportsRead,
            ProjectsRead, ProjectsWrite, ProjectsAll, FinanceRead, UsersRead,
        }.ToFrozenSet(),
        [CrmRoles.Technician] = new[]
        {
            CustomersRead, ContactsWrite, CatalogRead, ContractsRead, SalesRead, LicensingRead, ActivitiesRead, ActivitiesWrite,
            ServiceRead, ServiceWrite, TimeOwn, ProjectsRead, UsersRead,
        }.ToFrozenSet(),
        [CrmRoles.ServiceLead] = new[]
        {
            CustomersRead, ContactsWrite, CatalogRead, ContractsRead, SalesRead, LicensingRead, ActivitiesRead, ActivitiesWrite,
            ServiceRead, ServiceWrite, TimeOwn, TimeRead, TimeManage, BillingRead, ReportsRead, ProjectsRead, ProjectsWrite, ProjectsAll, UsersRead,
        }.ToFrozenSet(),
        [CrmRoles.Finance] = new[]
        {
            CustomersRead, CatalogRead, CatalogWrite, ContractsRead, ContractsWrite, SalesRead, QuotesAll, LicensingRead, ActivitiesRead, ActivitiesWrite,
            ServiceRead, TimeRead, TimeUnlock, BillingRead, BillingManage, BillingApprove, ReportsRead, ReportsMart, ProjectsRead, ProjectsAll,
            FinanceRead, FinanceCostRead, AuditRead, UsersRead,
        }.ToFrozenSet(),
        [CrmRoles.ReadOnly] = new[]
        {
            CustomersRead, CatalogRead, ContractsRead, SalesRead, LicensingRead, ActivitiesRead, ServiceRead, ProjectsRead, ProjectsAll,
        }.ToFrozenSet(),
    }.ToFrozenDictionary(StringComparer.Ordinal);

    /// <summary>
    /// Privileges whose changes are financial commands or administration (DEV-10): used for anything but reading, they need the
    /// authority's recent confirmation of the caller's roles. Bulk exports are marked on the endpoint (<c>ExportsData</c>).
    /// </summary>
    public static readonly FrozenSet<string> Privileged = new[]
    {
        BillingManage, BillingApprove, BillingApproveSecond, TimeUnlock, SalesDiscountApprove,
        IntegrationsManage, CustomFieldsManage, CustomersDelete, PrivacyManage, OperationsMaintenance,
    }.ToFrozenSet(StringComparer.Ordinal);

    public static IReadOnlySet<string> ForRoles(IEnumerable<string> roles)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (string role in roles)
        {
            if (ByRole.TryGetValue(role, out var permissions))
            {
                result.UnionWith(permissions);
            }
        }

        return result;
    }

    public static IEnumerable<string> GetCrmRoles(this ClaimsPrincipal principal) =>
        principal.Claims
            .Where(c => c.Type is ClaimTypes.Role or "roles")
            .Select(c => c.Value)
            .Where(CrmRoles.All.Contains)
            .Distinct(StringComparer.Ordinal);

    public static IReadOnlySet<string> GetPermissions(this ClaimsPrincipal principal) => ForRoles(principal.GetCrmRoles());
}
