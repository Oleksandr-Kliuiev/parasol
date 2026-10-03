using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Crm.Authorization;

namespace Crm.UnitTests;

public class PermissionsTests
{
    [Fact]
    public void Admin_has_every_permission()
    {
        var admin = Permissions.ForRoles([CrmRoles.Admin]);
        foreach (var field in typeof(Permissions).GetFields().Where(f => f.IsLiteral))
        {
            admin.ShouldContain((string)field.GetValue(null)!);
        }
    }

    [Fact]
    public void Technician_cannot_see_finance_or_edit_organizations()
    {
        var technician = Permissions.ForRoles([CrmRoles.Technician]);
        technician.ShouldContain(Permissions.CustomersRead);
        technician.ShouldContain(Permissions.ContactsWrite);
        technician.ShouldNotContain(Permissions.CustomersWrite);
        technician.ShouldNotContain(Permissions.FinanceRead);
        technician.ShouldNotContain(Permissions.FinanceCostRead);
    }

    [Fact]
    public void Sales_sees_invoices_but_not_cost_prices()
    {
        var sales = Permissions.ForRoles([CrmRoles.Sales]);
        sales.ShouldContain(Permissions.FinanceRead);
        sales.ShouldNotContain(Permissions.FinanceCostRead);
    }

    [Fact]
    public void Catalog_is_maintained_by_finance_and_contracts_by_sales_and_finance()
    {
        Permissions.ForRoles([CrmRoles.Finance]).ShouldContain(Permissions.CatalogWrite);
        Permissions.ForRoles([CrmRoles.Sales]).ShouldNotContain(Permissions.CatalogWrite);
        Permissions.ForRoles([CrmRoles.Sales]).ShouldContain(Permissions.ContractsWrite);
        Permissions.ForRoles([CrmRoles.Technician]).ShouldContain(Permissions.ContractsRead);
        Permissions.ForRoles([CrmRoles.Technician]).ShouldNotContain(Permissions.ContractsWrite);
        Permissions.ForRoles([CrmRoles.ReadOnly]).ShouldContain(Permissions.CatalogRead);
    }

    [Fact]
    public void Multiple_roles_union_their_permissions()
    {
        var combined = Permissions.ForRoles([CrmRoles.Technician, CrmRoles.Finance]);
        combined.ShouldContain(Permissions.ContactsWrite);
        combined.ShouldContain(Permissions.FinanceCostRead);
    }

    [Fact]
    public void Unknown_roles_grant_nothing()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity([new Claim("roles", "Crm.SuperUser"), new Claim(ClaimTypes.Role, "Admin")], "test"));
        principal.GetPermissions().ShouldBeEmpty();
    }
}

public class SensitiveDataJsonModifierTests
{
    private sealed record PriceDto(string Product, decimal Price, [property: SensitiveData(Permissions.FinanceCostRead)] decimal Cost);

    private static string Serialize(bool canSeeCost)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            TypeInfoResolver = new DefaultJsonTypeInfoResolver().WithAddedModifier(
                SensitiveDataJsonModifier.Create(permission => canSeeCost && permission == Permissions.FinanceCostRead)),
        };
        return JsonSerializer.Serialize(new PriceDto("M365 Business Premium", 250m, 180m), options);
    }

    [Fact]
    public void Sensitive_property_is_removed_without_permission() =>
        Serialize(canSeeCost: false).ShouldNotContain("cost");

    [Fact]
    public void Sensitive_property_is_serialized_with_permission() =>
        Serialize(canSeeCost: true).ShouldContain("\"cost\":180");
}
