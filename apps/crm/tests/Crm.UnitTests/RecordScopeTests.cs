using System.Security.Claims;
using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.SharedKernel.Application;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace Crm.UnitTests;

/// <summary>Record scope (DEV-09): which roles see every quote and project, and what a limited caller is limited to.</summary>
public class RecordScopeTests
{
    // docs/02 §2 and SEC-AZ-03, proposed until EXT-01 (ADR-018).
    [Theory]
    [InlineData(CrmRoles.Admin, true, true)]
    [InlineData(CrmRoles.Management, true, true)]
    [InlineData(CrmRoles.Finance, true, true)]
    [InlineData(CrmRoles.Sales, false, true)]
    [InlineData(CrmRoles.ServiceLead, false, true)]
    [InlineData(CrmRoles.ReadOnly, false, true)]
    [InlineData(CrmRoles.Technician, false, false)]
    public void Each_role_sees_every_quote_or_project_only_as_the_matrix_says(string role, bool allQuotes, bool allProjects)
    {
        var held = Permissions.ForRoles([role]);

        held.Contains(Permissions.QuotesAll).ShouldBe(allQuotes);
        held.Contains(Permissions.ProjectsAll).ShouldBe(allProjects);
        // The scope narrows what a role reads; it never gives a kind the role cannot read at all.
        if (allQuotes)
        {
            held.ShouldContain(Permissions.SalesRead);
        }

        if (allProjects)
        {
            held.ShouldContain(Permissions.ProjectsRead);
        }
    }

    [Fact]
    public void A_user_with_several_roles_gets_the_widest_scope()
    {
        Permissions.ForRoles([CrmRoles.Sales, CrmRoles.Finance]).ShouldContain(Permissions.QuotesAll);
        Permissions.ForRoles([CrmRoles.Technician, CrmRoles.ServiceLead]).ShouldContain(Permissions.ProjectsAll);
    }

    [Fact]
    public void Roles_come_only_from_role_claims_of_known_crm_roles()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new Claim("roles", CrmRoles.Sales),
            new Claim("roles", "Crm.SuperUser"),
            new Claim("requested_role", CrmRoles.Admin),
            new Claim("scope", CrmRoles.Management),
        ], "test"));

        principal.GetCrmRoles().ShouldBe([CrmRoles.Sales]);
        principal.GetPermissions().ShouldNotContain(Permissions.QuotesAll);
    }

    [Theory]
    [InlineData("Restricted", false, true)]
    [InlineData("Restricted", true, false)]
    [InlineData("Open", false, false)]
    public void A_caller_is_limited_to_its_own_records_only_in_the_restricted_mode_without_the_permission(string mode, bool holdsAll, bool limited)
    {
        var userId = Guid.NewGuid();
        using var services = Services(mode, new User(userId, holdsAll ? [Permissions.QuotesAll] : []));
        var scope = services.GetRequiredService<IRecordScope>();

        scope.Mode.ToString().ShouldBe(mode);
        scope.LimitedTo(Permissions.QuotesAll).ShouldBe(limited ? userId : null);
    }

    [Fact]
    public void Background_work_sees_everything_and_a_caller_without_a_crm_user_sees_nothing()
    {
        using (var system = Services("Restricted", new User(null, null)))
        {
            system.GetRequiredService<IRecordScope>().LimitedTo(Permissions.ProjectsAll).ShouldBeNull();
        }

        using var stranger = Services("Restricted", new User(null, []));
        stranger.GetRequiredService<IRecordScope>().LimitedTo(Permissions.ProjectsAll).ShouldBe(Guid.Empty);
    }

    [Fact]
    public void The_restricted_mode_is_the_default()
    {
        using var services = Services(null, new User(Guid.NewGuid(), []));
        services.GetRequiredService<IRecordScope>().Mode.ShouldBe(RecordScopeMode.Restricted);
    }

    private static ServiceProvider Services(string? mode, ICurrentUser user)
    {
        var settings = new Dictionary<string, string?>();
        if (mode is not null)
        {
            settings["Authorization:RecordScope"] = mode;
        }

        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(settings).Build());
        services.AddSingleton<IHostEnvironment>(new Environment());
        services.AddScoped(_ => user);
        services.AddCrmInfrastructure();
        return services.BuildServiceProvider();
    }

    /// <param name="Permissions">Null: every permission, like the worker's system user.</param>
    private sealed record User(Guid? UserId, string[]? Permissions) : ICurrentUser
    {
        public string DisplayName => "test";

        public bool IsAuthenticated => true;

        public bool HasPermission(string permission) => Permissions is null || Permissions.Contains(permission);
    }

    private sealed class Environment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";

        public string ApplicationName { get; set; } = "Crm.UnitTests";

        public string ContentRootPath { get; set; } = Path.GetTempPath();

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
