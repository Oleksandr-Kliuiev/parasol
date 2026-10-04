using System.Globalization;
using System.Security.Claims;
using Crm.Authorization;
using Crm.Identity.Domain;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.UnitTests;

/// <summary>DEV-10: confirmed roles and the freshness a privileged action needs.</summary>
public class SessionAuthorizationTests
{
    private static readonly DateTimeOffset Noon = new(2026, 10, 4, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Confirmed_roles_change_the_version_only_when_they_change_and_an_older_confirmation_changes_nothing()
    {
        var user = User.Create("tenant", "oid");

        user.ConfirmRoles([CrmRoles.Sales, CrmRoles.Finance, CrmRoles.Sales], Noon).ShouldBeTrue();
        user.Roles.ShouldBe("Crm.Finance,Crm.Sales");
        user.RolesVersion.ShouldBe(1);
        user.RoleList.ShouldBe([CrmRoles.Finance, CrmRoles.Sales]);

        user.ConfirmRoles([CrmRoles.Finance, CrmRoles.Sales], Noon.AddMinutes(2)).ShouldBeFalse();
        user.RolesVersion.ShouldBe(1);
        user.RolesVerifiedAt.ShouldBe(Noon.AddMinutes(2), "a confirmation renews the time even when nothing changed");

        // A sync that began before a later sign-in does not undo what the sign-in confirmed.
        user.ConfirmRoles([], Noon.AddMinutes(1)).ShouldBeFalse();
        user.Roles.ShouldBe("Crm.Finance,Crm.Sales");

        user.ConfirmRoles([], Noon.AddMinutes(3)).ShouldBeTrue();
        user.RoleList.ShouldBeEmpty();
        user.RolesVersion.ShouldBe(2);
    }

    [Fact]
    public void A_directory_reading_touches_a_user_only_when_the_roles_changed_and_never_undoes_a_later_sign_in()
    {
        var user = User.Create("tenant", "oid");
        user.ConfirmRoles([CrmRoles.Finance], Noon);

        // Unchanged: nothing is written — the tenant's confirmation covers this user, so no update and no audit row.
        user.ApplyDirectoryRoles([CrmRoles.Finance], Noon.AddMinutes(2)).ShouldBeFalse();
        user.RolesVerifiedAt.ShouldBe(Noon);
        user.RolesVersion.ShouldBe(1);

        // Finance removed in Entra ID: the reading changes the roles and stamps its own time.
        user.ApplyDirectoryRoles([], Noon.AddMinutes(4)).ShouldBeTrue();
        user.RoleList.ShouldBeEmpty();
        user.RolesVersion.ShouldBe(2);
        user.RolesVerifiedAt.ShouldBe(Noon.AddMinutes(4));

        // A sign-in at 12:07 confirmed Sales; a reading begun at 12:06 is older and changes nothing.
        user.ConfirmRoles([CrmRoles.Sales], Noon.AddMinutes(7)).ShouldBeTrue();
        user.ApplyDirectoryRoles([], Noon.AddMinutes(6)).ShouldBeFalse();
        user.RoleList.ShouldBe([CrmRoles.Sales]);
    }

    [Fact]
    public void The_tenant_confirmation_only_moves_forward()
    {
        var confirmation = DirectoryRoleConfirmation.For("tenant", Noon);

        confirmation.Advance(Noon.AddMinutes(2)).ShouldBeTrue();
        confirmation.Advance(Noon.AddMinutes(1)).ShouldBeFalse("an overlapping run that read the directory earlier is discarded");
        confirmation.Advance(Noon.AddMinutes(2)).ShouldBeTrue("a reading as recent as the last one is not older");
        confirmation.ConfirmedAt.ShouldBe(Noon.AddMinutes(2));
    }

    [Theory]
    [InlineData("POST", Permissions.BillingApprove, 4, false, true)]
    [InlineData("POST", Permissions.BillingApprove, 6, false, false)]
    [InlineData("POST", Permissions.IntegrationsManage, 6, false, false)]
    [InlineData("DELETE", Permissions.CustomersDelete, 6, false, false)]
    [InlineData("GET", Permissions.BillingManage, 6, false, true)]
    [InlineData("GET", Permissions.CustomersRead, 6, true, false)]
    [InlineData("GET", Permissions.CustomersRead, 4, true, true)]
    [InlineData("POST", Permissions.SalesWrite, 600, false, true)]
    public async Task A_privileged_change_or_an_export_needs_roles_confirmed_within_five_minutes(
        string method, string permission, int minutesSinceConfirmation, bool export, bool allowed)
    {
        var authorization = Authorization(Noon);
        var user = Principal(Permissions.ForRoles([CrmRoles.Admin]).Contains(permission) ? CrmRoles.Admin : CrmRoles.Sales, Noon.AddMinutes(-minutesSinceConfirmation));
        var http = new DefaultHttpContext();
        http.Request.Method = method;
        if (export)
        {
            http.SetEndpoint(new Endpoint(null, new EndpointMetadataCollection(new ExportsDataMetadata()), "export"));
        }

        var result = await authorization.AuthorizeAsync(user, http, "perm:" + permission);

        result.Succeeded.ShouldBe(allowed);
        if (!allowed)
        {
            result.Failure!.FailureReasons.ShouldContain(r => r.Message == PermissionAuthorization.ReverifyRequired);
        }
    }

    [Fact]
    public async Task Without_a_confirmation_a_privileged_action_fails_closed_and_without_the_permission_it_is_plainly_refused()
    {
        var authorization = Authorization(Noon);
        var http = new DefaultHttpContext();
        http.Request.Method = "POST";

        var unconfirmed = new ClaimsPrincipal(new ClaimsIdentity([new Claim("roles", CrmRoles.Finance)], "test", "name", "roles"));
        (await authorization.AuthorizeAsync(unconfirmed, http, "perm:" + Permissions.BillingApprove)).Failure!.FailureReasons
            .ShouldContain(r => r.Message == PermissionAuthorization.ReverifyRequired);

        var sales = Principal(CrmRoles.Sales, Noon);
        var refused = await authorization.AuthorizeAsync(sales, http, "perm:" + Permissions.BillingApprove);
        refused.Succeeded.ShouldBeFalse();
        refused.Failure!.FailureReasons.ShouldBeEmpty();
    }

    private static IAuthorizationService Authorization(DateTimeOffset now)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddSingleton<TimeProvider>(new FixedTime(now));
        services.AddCrmAuthorization();
        return services.BuildServiceProvider().GetRequiredService<IAuthorizationService>();
    }

    private static ClaimsPrincipal Principal(string role, DateTimeOffset confirmedAt) =>
        new(new ClaimsIdentity(
        [
            new Claim("roles", role),
            new Claim(PermissionAuthorization.RolesVerifiedClaim, confirmedAt.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)),
        ], "test", "name", "roles"));

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
