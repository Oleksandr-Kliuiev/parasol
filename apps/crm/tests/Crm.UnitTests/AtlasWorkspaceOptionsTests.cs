using Crm.Authorization;
using Crm.Integrations.Core.Parasol;

namespace Crm.UnitTests;

public sealed class AtlasWorkspaceOptionsTests
{
    [Theory]
    [InlineData("https://atlas.example.invalid", true)]
    [InlineData("http://127.0.0.1:3000", true)]
    [InlineData("http://atlas.example.invalid", false)]
    [InlineData("https://user:password@atlas.example.invalid", false)]
    [InlineData("https://atlas.example.invalid/path", false)]
    [InlineData("https://atlas.example.invalid/?target=other", false)]
    [InlineData("https://atlas.example.invalid/#fragment", false)]
    public void Only_a_server_origin_without_embedded_credentials_or_paths_is_allowed(string url, bool valid) =>
        new AtlasWorkspaceOptions { Enabled = true, BaseUrl = url }.IsValid().ShouldBe(valid);

    [Fact]
    public void Employee_credentials_cannot_be_shared_and_malformed_tokens_are_rejected()
    {
        var options = new AtlasWorkspaceOptions { Enabled = true, BaseUrl = "http://localhost:3000" };
        var employee = new AtlasEmployeeCredential { WorkspaceId = "test", Token = "synthetic-token-for-one-employee" };
        options.Employees.Add(Guid.NewGuid().ToString("D"), employee); options.IsValid().ShouldBeTrue();
        options.Employees.Add(Guid.NewGuid().ToString("D"), employee); options.IsValid().ShouldBeFalse();
        options.Employees.Clear(); employee.Token = "invalid\r\nheader";
        options.Employees.Add(Guid.NewGuid().ToString("D"), employee); options.IsValid().ShouldBeFalse();
    }

    [Theory]
    [InlineData(CrmRoles.Admin, true)]
    [InlineData(CrmRoles.Management, true)]
    [InlineData(CrmRoles.Technician, true)]
    [InlineData(CrmRoles.ServiceLead, true)]
    [InlineData(CrmRoles.ReadOnly, true)]
    [InlineData(CrmRoles.Sales, false)]
    [InlineData(CrmRoles.Finance, false)]
    [InlineData("Unknown", false)]
    public void Technical_workspace_has_an_explicit_role_matrix(string role, bool allowed)
    {
        var permissions = Permissions.ForRoles([role]);
        permissions.Contains(Permissions.ParasolAtlasRead).ShouldBe(allowed);
        if (role == CrmRoles.Technician) permissions.Contains(Permissions.FinanceRead).ShouldBeFalse();
    }
}
