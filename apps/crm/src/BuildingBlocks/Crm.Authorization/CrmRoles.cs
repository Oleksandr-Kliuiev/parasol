namespace Crm.Authorization;

/// <summary>App Role values defined on the Entra ID app registration (docs/05-integrations.md §1.2).</summary>
public static class CrmRoles
{
    public const string Admin = "Crm.Admin";
    public const string Management = "Crm.Management";
    public const string Sales = "Crm.Sales";
    public const string Technician = "Crm.Technician";
    public const string ServiceLead = "Crm.ServiceLead";
    public const string Finance = "Crm.Finance";
    public const string ReadOnly = "Crm.ReadOnly";

    public static readonly IReadOnlyList<string> All = [Admin, Management, Sales, Technician, ServiceLead, Finance, ReadOnly];
}
