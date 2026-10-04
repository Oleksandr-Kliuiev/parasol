using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Integrations.MicrosoftGraph;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Identity.Web;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using AuthenticationResult = Microsoft.Identity.Client.AuthenticationResult;
using MsalUiRequiredException = Microsoft.Identity.Client.MsalUiRequiredException;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-10: privileges end when the directory says so, in every replica, without a new sign-in; an unreachable directory stops
/// privileged actions within minutes and reading within hours; signing out ends the session everywhere. Real session cookies on
/// the Entra cookie path, a manual clock and a test authority (WireMock Graph, the role directory) — not a live Entra check
/// (EXT-02).
/// </summary>
public sealed class SessionLifecycleTests(CrmWebFactory factory) : IDisposable
{
    private static readonly Guid FinanceRole = Guid.Parse("00000000-0000-0000-0000-00000000f1a0");
    private static readonly Guid AdminRole = Guid.Parse("00000000-0000-0000-0000-00000000ad01");
    private static readonly Guid RetiredRole = Guid.Parse("00000000-0000-0000-0000-00000000de1e");
    private static readonly Guid DisabledMapping = Guid.Parse("00000000-0000-0000-0000-0000d15ab1ed");
    private static readonly ConcurrentBag<string> Disabled = [];
    private readonly string _keyRing = System.IO.Directory.CreateTempSubdirectory("crm-keys-").FullName;
    private readonly string _marker = $"{Guid.NewGuid():N}"[..10];

    // A tenant of its own: the role sync applies to every user of a tenant and records one confirmation for it.
    private readonly string _tenant = Guid.NewGuid().ToString();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC01_a_role_removed_in_the_directory_leaves_an_existing_cookie_within_the_bound()
    {
        await using var host = NewHost();
        var (finance, _) = await host.SignInAsync(Oid("finance"), CrmRoles.Finance);
        var (admin, _) = await host.SignInAsync(Oid("admin"), CrmRoles.Admin);
        (await ApproveAsync(finance)).StatusCode.ShouldBe(HttpStatusCode.NotFound, "authorized: no such run");
        (await admin.GetAsync("/api/v1/admin/record-scope", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // The directory takes Finance and Admin away (the role sync records what Entra assigns now).
        await ConfirmAsync(host, new() { [Oid("finance")] = [CrmRoles.ReadOnly], [Oid("admin")] = [] });

        // Within the replica's cache the old answer may stand ...
        host.Time.Advance(TimeSpan.FromSeconds(10));
        (await ApproveAsync(finance)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // ... and after it the cookie has lost the roles — no sign-in, no new token.
        host.Time.Advance(TimeSpan.FromSeconds(21));
        var refused = await ApproveAsync(finance);
        refused.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await refused.Content.ReadAsStringAsync(Ct)).ShouldNotContain(PermissionAuthorization.ReverifyRequired);
        (await finance.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        Roles(await finance.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).ShouldBe([CrmRoles.ReadOnly]);
        (await admin.GetAsync("/api/v1/admin/record-scope", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        Roles(await admin.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).ShouldBeEmpty();
    }

    [Fact]
    public async Task AC02_deactivation_a_group_left_and_an_expired_pim_activation_each_end_the_privilege()
    {
        await using var host = NewHost();
        var direct = Oid("direct");
        var member = Oid("member");
        var activated = Oid("pim");

        var nested = Oid("nested");

        // Entra: Finance assigned directly (and a role since disabled); Admin through a group — a member, and a PIM activation
        // (an active membership while it lasts). A nested group's member gets nothing from the group's assignment, in Entra's
        // tokens and here alike.
        EntraAssigns(
            assignments: [(direct, "User", FinanceRole), (direct, "User", RetiredRole), (Group, "Group", AdminRole)],
            members: [member, activated],
            nestedMembers: [nested]);
        var (directClient, _) = await host.SignInAsync(direct, CrmRoles.Finance);
        var (memberClient, _) = await host.SignInAsync(member, CrmRoles.Admin);
        var (activatedClient, _) = await host.SignInAsync(activated, CrmRoles.Admin);
        var (nestedClient, _) = await host.SignInAsync(nested);
        await RunRoleSyncAsync(host);
        host.Time.Advance(TimeSpan.FromSeconds(31));
        foreach (var client in new[] { memberClient, activatedClient })
        {
            (await client.GetAsync("/api/v1/admin/record-scope", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        Roles(await directClient.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).ShouldBe([CrmRoles.Finance], "a disabled role is not held");
        Roles(await nestedClient.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).ShouldBeEmpty("membership through a nested group grants nothing");

        // The member leaves the group; the PIM activation expires (Entra removes the member); the direct assignment stays.
        EntraAssigns(assignments: [(direct, "User", FinanceRole), (Group, "Group", AdminRole)], members: []);
        await RunRoleSyncAsync(host);
        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await memberClient.GetAsync("/api/v1/admin/record-scope", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await activatedClient.GetAsync("/api/v1/admin/record-scope", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await ApproveAsync(directClient)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // Disabled in Entra (its assignments stay): the next role sync takes every privilege, before the hourly user sync ...
        DisabledInEntra(direct);
        await RunRoleSyncAsync(host);
        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await ApproveAsync(directClient)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await directClient.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // ... which marks it inactive: the session ends, and the old cookie does not make the account active again.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IUserDirectorySync>().ApplyAsync(
                [new DirectoryUserChange(_tenant, direct, false, false, null, null, null, null, null)], Ct);
        }

        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await directClient.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await directClient.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<IUserDirectory>();
            (await users.GetProfileAsync(await UserIdAsync(host, direct), Ct))!.IsActive.ShouldBeFalse();
        }
    }

    [Fact]
    public async Task AC03_an_old_cookie_on_a_second_replica_brings_back_neither_a_revoked_role_nor_an_ended_session()
    {
        var time = ManualTimeProvider.InThePast();
        await using var first = NewHost(time);
        await using var second = NewHost(time);
        var (onFirst, cookie) = await first.SignInAsync(Oid("finance"), CrmRoles.Finance);
        using var onSecond = second.Client(cookie);
        (await ApproveAsync(onSecond)).StatusCode.ShouldBe(HttpStatusCode.NotFound, "the second replica reads the session from the server");

        await ConfirmAsync(first, new() { [Oid("finance")] = [CrmRoles.ReadOnly] });
        time.Advance(TimeSpan.FromSeconds(31));
        // The copied cookie still names Finance; the second replica takes the roles from the server.
        (await ApproveAsync(onSecond)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await onSecond.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // Signing out on the first replica ends the session; the copy is refused on the second once its cache turns over.
        (await onFirst.PostAsync("/bff/logout", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await first.Client(cookie).GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        time.Advance(TimeSpan.FromSeconds(31));
        (await onSecond.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task AC04_an_unreachable_directory_stops_privileged_actions_within_minutes_and_reading_within_hours()
    {
        await using var host = NewHost();
        var oid = Oid("finance");
        var (finance, _) = await host.SignInAsync(oid, CrmRoles.Finance);

        host.Time.Advance(TimeSpan.FromMinutes(4));
        (await ApproveAsync(finance)).StatusCode.ShouldBe(HttpStatusCode.NotFound, "confirmed four minutes ago");

        // Graph refuses (no permission granted, an outage): nothing is confirmed, the confirmation ages.
        factory.Graph.Given(Request.Create().WithPath($"/graph/v1.0/servicePrincipals").WithParam("$filter", $"appId eq '{AppId}'").UsingGet())
            .WithGuid(GraphMapping(0)).RespondWith(Response.Create().WithStatusCode(403));
        await Should.ThrowAsync<HttpRequestException>(() => RunRoleSyncAsync(host));
        host.Time.Advance(TimeSpan.FromMinutes(2));
        var stale = await ApproveAsync(finance);
        stale.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await stale.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(PermissionAuthorization.ReverifyRequired);
        (await finance.GetAsync($"/api/v1/reports/mart/time-entries", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden, "an export is privileged");
        (await finance.GetAsync("/api/v1/customers/organizations/export", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden, "an export is privileged");
        (await finance.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK, "reading goes on");

        // The directory answers again: privileged actions are back without a sign-in.
        EntraAssigns(assignments: [(oid, "User", FinanceRole)], members: []);
        await RunRoleSyncAsync(host);
        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await ApproveAsync(finance)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // Never indefinitely: unconfirmed for longer than the grace, the session reads no more and must sign in again.
        host.Time.Advance(TimeSpan.FromHours(8) + TimeSpan.FromMinutes(1));
        (await finance.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        var (again, _) = await host.SignInAsync(oid, CrmRoles.Finance);
        (await ApproveAsync(again)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task The_role_sync_writes_a_user_only_when_the_roles_change_and_confirms_everyone_else_once_for_the_tenant()
    {
        await using var host = NewHost();
        var oid = Oid("steady");
        EntraAssigns(assignments: [(oid, "User", FinanceRole)], members: []);
        var (finance, _) = await host.SignInAsync(oid, CrmRoles.Finance);
        var userId = await UserIdAsync(host, oid);
        var (audits, rowVersion) = await UserRowAsync(host, userId);

        // Every two minutes the directory says the same: the user row and its audit trail stay as they are (no ETag churn,
        // no audit row per user and run) ...
        host.Time.Advance(TimeSpan.FromMinutes(4));
        await RunRoleSyncAsync(host);
        await RunRoleSyncAsync(host);
        (await UserRowAsync(host, userId)).ShouldBe((audits, rowVersion));

        // ... yet the reading counts as a confirmation: eight minutes after the sign-in, four after the reading, still fresh.
        host.Time.Advance(TimeSpan.FromMinutes(4));
        (await ApproveAsync(finance)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // A real change is written once, and audited with what changed.
        EntraAssigns(assignments: [], members: []);
        await RunRoleSyncAsync(host);
        await RunRoleSyncAsync(host);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Crm.Identity.Persistence.IdentityDbContext>();
            var added = await db.AuditEntries.Where(a => a.EntityId == userId).OrderBy(a => a.Id).Skip(audits).ToListAsync(Ct);
            added.Count.ShouldBe(1);
            added[0].Changes.ShouldNotBeNull().ShouldContain("\"Roles\"");
        }

        host.Time.Advance(TimeSpan.FromSeconds(31));
        var refused = await ApproveAsync(finance);
        refused.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await refused.Content.ReadAsStringAsync(Ct)).ShouldNotContain(PermissionAuthorization.ReverifyRequired);
    }

    [Fact]
    public async Task A_cookie_from_before_server_sessions_signs_in_once_more_and_the_user_stays_who_they_were()
    {
        await using var host = NewHost();
        var oid = Oid("legacy");
        var legacy = await host.LegacySignInAsync(oid, CrmRoles.Finance);
        var userId = await UserIdAsync(host, oid);

        // Issued before DEV-10: it names no server-side session, so it cannot be checked or ended — it is not accepted.
        (await legacy.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await legacy.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        var (again, _) = await host.SignInAsync(oid, CrmRoles.Finance);
        (await ApproveAsync(again)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await UserIdAsync(host, oid)).ShouldBe(userId, "the same CRM user, nothing recreated");
    }

    [Fact]
    public async Task An_active_session_with_freshly_confirmed_roles_still_ends_at_its_absolute_lifetime()
    {
        // This host: sliding two days, absolute three. Activity renews the cookie and the directory keeps confirming the roles.
        await using var host = NewHost();
        var oid = Oid("absolute");
        var (finance, _) = await host.SignInAsync(oid, CrmRoles.Finance);

        host.Time.Advance(TimeSpan.FromDays(1.5));
        await ConfirmAsync(host, new() { [oid] = [CrmRoles.Finance] });
        (await ApproveAsync(finance)).StatusCode.ShouldBe(HttpStatusCode.NotFound, "a day and a half in, active and confirmed");

        host.Time.Advance(TimeSpan.FromDays(1.5) + TimeSpan.FromMinutes(1));
        await ConfirmAsync(host, new() { [oid] = [CrmRoles.Finance] });
        (await finance.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized, "past three days nothing extends it");
    }

    [Fact]
    public async Task Entra_answering_no_ends_the_session_and_entra_out_of_reach_postpones_the_check_without_failing_requests()
    {
        var entra = new ScriptedTokenAcquisition();
        await using var host = NewHost(entra: entra);
        var oid = Oid("revalidated");
        var (client, _) = await host.SignInAsync(oid, CrmRoles.Finance);

        // An hour on (this host's revalidation interval), Entra cannot be reached: the request is served, not failed ...
        host.Time.Advance(TimeSpan.FromMinutes(61));
        await ConfirmAsync(host, new() { [oid] = [CrmRoles.Finance] });
        entra.Next = new HttpRequestException("unreachable");
        (await client.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await client.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        entra.Calls.ShouldBe(1, "the next attempt waits five minutes instead of every request");

        // ... asked again after five minutes, Entra answers and the check is done for another hour.
        host.Time.Advance(TimeSpan.FromMinutes(6));
        entra.Next = null;
        (await client.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await client.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        entra.Calls.ShouldBe(2);

        // The account may no longer get a token (disabled, password reset, sessions revoked in Entra): the session ends.
        host.Time.Advance(TimeSpan.FromMinutes(61));
        await ConfirmAsync(host, new() { [oid] = [CrmRoles.Finance] });
        entra.Next = new MsalUiRequiredException("invalid_grant", "The refresh token was revoked.");
        (await client.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        entra.Calls.ShouldBe(3);
    }

    [Fact]
    public async Task AC06_the_logs_carry_no_tokens_cookies_or_identity_claims()
    {
        var logs = new CapturingLoggerProvider();
        await using var host = NewHost(logs: logs);
        var oid = Oid("logged");
        EntraAssigns(assignments: [(oid, "User", FinanceRole)], members: []);
        var (client, cookie) = await host.SignInAsync(oid, CrmRoles.Finance);
        (await client.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        await RunRoleSyncAsync(host);
        await ConfirmAsync(host, new() { [oid] = [] });
        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await client.GetAsync("/api/v1/billing/runs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await client.PostAsync("/bff/logout", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var lines = logs.Lines.ToList();
        lines.Count.ShouldBeGreaterThan(50, "everything down to Trace was captured");
        // The sources that could carry them were listening: authentication, the outgoing Graph calls, the database.
        lines.ShouldContain(line => line.Contains("Microsoft.AspNetCore.Authentication", StringComparison.Ordinal));
        lines.ShouldContain(line => line.Contains("System.Net.Http.HttpClient", StringComparison.Ordinal));
        lines.ShouldContain(line => line.Contains("Microsoft.EntityFrameworkCore", StringComparison.Ordinal));
        var cookieValue = cookie[(cookie.IndexOf('=', StringComparison.Ordinal) + 1)..];
        foreach (var secret in new[] { cookieValue, "test-graph-token", oid, _tenant, "schemas.microsoft.com/identity/claims" })
        {
            lines.ShouldNotContain(line => line.Contains(secret, StringComparison.Ordinal), secret.Length > 40 ? "the session cookie" : secret);
        }

        lines.ShouldNotContain(line => line.Contains("eyJ", StringComparison.Ordinal), "a JWT");
    }

    [Fact]
    public void Production_does_not_start_without_the_shared_key_ring_and_half_a_configuration_starts_nowhere()
    {
        // Without one key ring for all replicas, a cookie issued by one is refused by the next, and sessions die with a replica.
        using var production = factory.WithWebHostBuilder(builder => builder.UseEnvironment("Production"));
        Messages(Should.Throw<Exception>(() => production.CreateClient())).ShouldContain(m => m.Contains("share one key ring", StringComparison.Ordinal));
        using var half = factory.WithWebHostBuilder(builder => builder.UseSetting("DataProtection:BlobUri", "https://example.blob.core.windows.net/keys/keys.xml"));
        Messages(Should.Throw<Exception>(() => half.CreateClient())).ShouldContain(m => m.Contains("go together", StringComparison.Ordinal));
    }

    public void Dispose()
    {
        if (System.IO.Directory.Exists(_keyRing))
        {
            System.IO.Directory.Delete(_keyRing, recursive: true);
        }
    }

    private string AppId => $"crm-app-{_marker}";

    private string Group => $"group-{_marker}";

    private string Oid(string who) => $"{who}-{_marker}";

    private SessionHost NewHost(ManualTimeProvider? time = null, CapturingLoggerProvider? logs = null, ScriptedTokenAcquisition? entra = null) =>
        new(factory, time ?? ManualTimeProvider.InThePast(), _keyRing, AppId, _tenant, logs, entra);

    private Guid GraphMapping(int index) => new(Convert.FromHexString($"{_marker}{index:000000}0000000000000000"[..32]));

    /// <summary>
    /// What Entra assigns: the CRM application with two roles (and a disabled third), its assignments, and the group's members —
    /// direct, and through a nested group for <paramref name="nestedMembers"/> (visible only in the transitive listing).
    /// </summary>
    private void EntraAssigns(
        IReadOnlyList<(string Principal, string Type, Guid Role)> assignments, IReadOnlyList<string> members, IReadOnlyList<string>? nestedMembers = null)
    {
        var sp = $"sp-{_marker}";
        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/servicePrincipals").WithParam("$filter", $"appId eq '{AppId}'").UsingGet())
            .WithGuid(GraphMapping(0))
            .RespondWith(Response.Create().WithStatusCode(200).WithBodyAsJson(new
            {
                value = new[]
                {
                    new
                    {
                        id = sp,
                        appRoles = new[]
                        {
                            new { id = FinanceRole, value = CrmRoles.Finance, isEnabled = true },
                            new { id = AdminRole, value = CrmRoles.Admin, isEnabled = true },
                            new { id = RetiredRole, value = CrmRoles.ReadOnly, isEnabled = false },
                        },
                    },
                },
            }));
        factory.Graph.Given(Request.Create().WithPath($"/graph/v1.0/servicePrincipals/{sp}/appRoleAssignedTo").UsingGet())
            .WithGuid(GraphMapping(1))
            .RespondWith(Response.Create().WithStatusCode(200).WithBodyAsJson(new
            {
                value = assignments.Select(a => new { principalId = a.Principal, principalType = a.Type, appRoleId = a.Role }).ToArray(),
            }));
        factory.Graph.Given(Request.Create().WithPath($"/graph/v1.0/groups/{Group}/members/microsoft.graph.user").UsingGet())
            .WithGuid(GraphMapping(2))
            .RespondWith(Response.Create().WithStatusCode(200).WithBodyAsJson(new { value = members.Select(m => new { id = m }).ToArray() }));
        DisabledInEntra();
        factory.Graph.Given(Request.Create().WithPath($"/graph/v1.0/groups/{Group}/transitiveMembers/microsoft.graph.user").UsingGet())
            .WithGuid(GraphMapping(3))
            .RespondWith(Response.Create().WithStatusCode(200).WithBodyAsJson(new
            {
                value = members.Concat(nestedMembers ?? []).Select(m => new { id = m }).ToArray(),
            }));
    }

    /// <summary>
    /// Accounts disabled in Entra. The listing is one tenant-wide request, so every test's disabled accounts are answered
    /// together; each test's accounts are its own (marked), and the others' change nothing for it.
    /// </summary>
    private void DisabledInEntra(params string[] objectIds)
    {
        foreach (var objectId in objectIds)
        {
            Disabled.Add(objectId);
        }

        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users").WithParam("$filter", "accountEnabled eq false").UsingGet())
            .WithGuid(DisabledMapping)
            .RespondWith(Response.Create().WithStatusCode(200).WithBodyAsJson(new { value = Disabled.Select(id => new { id }).ToArray() }));
    }

    private static async Task RunRoleSyncAsync(SessionHost host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<EntraRoleSyncJob>().RunAsync(Ct);
    }

    /// <summary>The test authority records what the directory assigns now, as the role sync does: users left out hold no role.</summary>
    private static async Task ConfirmAsync(SessionHost host, Dictionary<string, IReadOnlyCollection<string>> roles)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var applied = await scope.ServiceProvider.GetRequiredService<IUserRoleDirectory>().ApplyAsync(host.Tenant, roles, host.Time.GetUtcNow(), Ct);
        applied.Superseded.ShouldBeFalse();
    }

    private static async Task<Guid> UserIdAsync(SessionHost host, string objectId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var tenant = host.Tenant;
        return scope.ServiceProvider.GetRequiredService<Crm.Identity.Persistence.IdentityDbContext>().Users
            .Single(u => u.TenantId == tenant && u.ObjectId == objectId).Id;
    }

    private static async Task<(int Audits, string RowVersion)> UserRowAsync(SessionHost host, Guid userId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<Crm.Identity.Persistence.IdentityDbContext>();
        var rowVersion = await db.Users.Where(u => u.Id == userId)
            .Select(u => EF.Property<byte[]>(u, Crm.Infrastructure.Persistence.ModuleDbContext.RowVersionProperty)).SingleAsync(Ct);
        return (await db.AuditEntries.CountAsync(a => a.EntityId == userId, Ct), Convert.ToHexString(rowVersion));
    }

    /// <summary>A financial command: authorized it finds no such run (404); without the role 403; unconfirmed 403 with a code.</summary>
    private static Task<HttpResponseMessage> ApproveAsync(HttpClient client)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/billing/runs/{Guid.NewGuid()}/approve");
        request.Headers.IfMatch.ParseAdd("\"1\"");
        return client.SendAsync(request, Ct);
    }

    private static string[] Roles(JsonElement user) => user.GetProperty("roles").EnumerateArray().Select(r => r.GetString()!).ToArray();

    private static IEnumerable<string> Messages(Exception? error)
    {
        for (; error is not null; error = error.InnerException)
        {
            yield return error.Message;
        }
    }
}

/// <summary>
/// crm-web with real session cookies on the Entra cookie path (DEV-10), a manual clock and the test authority: the sign-in is
/// a test endpoint standing in for Entra's token; the directory is WireMock Graph or the role directory.
/// </summary>
internal sealed class SessionHost : IAsyncDisposable
{
    private readonly WebApplicationFactory<Program> _host;

    public SessionHost(
        CrmWebFactory factory, ManualTimeProvider time, string keyRing, string crmAppId, string tenant, CapturingLoggerProvider? logs,
        ScriptedTokenAcquisition? entra = null)
    {
        Time = time;
        Tenant = tenant;
        _host = factory.WithWebHostBuilder(builder =>
        {
            // Entra's own refresh-token check needs Entra: scripted when a test asks for it, otherwise not due within any test.
            builder.UseSetting("Auth:RevalidationInterval", entra is null ? "10.00:00:00" : "01:00:00");
            builder.UseSetting("Auth:SlidingExpiration", "2.00:00:00");
            builder.UseSetting("Auth:AbsoluteExpiration", "3.00:00:00");
            builder.UseSetting("Auth:SessionStateCacheSeconds", "30");
            builder.UseSetting("Auth:ActiveUserCacheSeconds", "0");
            builder.UseSetting("Auth:RoleGrace", "08:00:00");
            builder.UseSetting("Auth:PrivilegedFreshness", "00:05:00");
            builder.UseSetting("Integrations:MicrosoftGraph:CrmAppId", crmAppId);
            builder.UseSetting("Integrations:MicrosoftGraph:TenantId", tenant);
            if (logs is not null)
            {
                // Everything, whatever appsettings filters: a provider-specific rule outranks the general ones.
                builder.ConfigureLogging(logging => logging.SetMinimumLevel(LogLevel.Trace).AddProvider(logs).AddFilter<CapturingLoggerProvider>(null, LogLevel.Trace));
            }

            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton<TimeProvider>(time);
                // Replicas share one key ring, as in Azure (Blob Storage + Key Vault).
                services.AddDataProtection().PersistKeysToFileSystem(new DirectoryInfo(keyRing));
                services.PostConfigure<AuthenticationOptions>(options =>
                {
                    options.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
                    options.DefaultAuthenticateScheme = CookieAuthenticationDefaults.AuthenticationScheme;
                    options.DefaultChallengeScheme = CookieAuthenticationDefaults.AuthenticationScheme;
                    options.DefaultForbidScheme = CookieAuthenticationDefaults.AuthenticationScheme;
                    options.DefaultSignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
                });
                services.AddTransient<IStartupFilter>(_ => new TestSignInStartupFilter(tenant));
                if (entra is not null)
                {
                    services.RemoveAll<ITokenAcquisition>();
                    services.AddSingleton<ITokenAcquisition>(entra);
                }
            });
        });
    }

    public ManualTimeProvider Time { get; }

    public string Tenant { get; }

    public IServiceProvider Services => _host.Services;

    /// <summary>A browser: keeps its cookies; with <paramref name="cookie"/>, a copy of someone's session cookie instead.</summary>
    public HttpClient Client(string? cookie = null)
    {
        var client = _host.CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"), AllowAutoRedirect = false, HandleCookies = cookie is null,
        });
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        if (cookie is not null)
        {
            client.DefaultRequestHeaders.Add("Cookie", cookie);
        }

        return client;
    }

    /// <summary>Signs in as Entra would — a fresh token with these roles — and returns the browser and its session cookie.</summary>
    public async Task<(HttpClient Client, string Cookie)> SignInAsync(string objectId, params string[] roles)
    {
        var client = Client();
        // In headers, not the URL: Entra's callback carries no identity in the address either, and addresses are logged.
        using var request = new HttpRequestMessage(HttpMethod.Post, "/test/sign-in");
        request.Headers.Add("X-Test-Oid", objectId);
        request.Headers.Add("X-Test-Sign-In-Roles", string.Join(',', roles));
        var response = await client.SendAsync(request);
        response.StatusCode.ShouldBe(HttpStatusCode.NoContent);
        var cookie = string.Join("; ", response.Headers.GetValues("Set-Cookie")
            .Where(c => c.StartsWith(AuthenticationSetup.CookieName, StringComparison.Ordinal))
            .Select(c => c.Split(';')[0]));
        cookie.ShouldNotBeEmpty();
        return (client, cookie);
    }

    /// <summary>A cookie as the release before DEV-10 issued it: the user and the roles, no server-side session.</summary>
    public async Task<HttpClient> LegacySignInAsync(string objectId, params string[] roles)
    {
        var client = Client();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/test/legacy-sign-in");
        request.Headers.Add("X-Test-Oid", objectId);
        request.Headers.Add("X-Test-Sign-In-Roles", string.Join(',', roles));
        (await client.SendAsync(request)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        return client;
    }

    public ValueTask DisposeAsync() => _host.DisposeAsync();
}

/// <summary>Stands in for Entra's sign-in: the token's claims, then the same provisioning and cookie as OnTokenValidated.</summary>
internal sealed class TestSignInStartupFilter(string tenant) : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Map("/test/sign-in", branch => branch.Run(context => SignInAsync(context, legacy: false)));
        app.Map("/test/legacy-sign-in", branch => branch.Run(context => SignInAsync(context, legacy: true)));
        next(app);
    };

    private async Task SignInAsync(HttpContext context, bool legacy)
    {
        var objectId = context.Request.Headers["X-Test-Oid"].ToString();
        var claims = new List<Claim>
        {
            new(CrmClaimTypes.TenantId, tenant),
            new(CrmClaimTypes.ObjectId, objectId),
            new("preferred_username", $"{objectId}@test.local"),
            new("name", $"Session {objectId}"),
        };
        claims.AddRange(context.Request.Headers["X-Test-Sign-In-Roles"].ToString()
            .Split(',', StringSplitOptions.RemoveEmptyEntries).Select(role => new Claim("roles", role)));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, "AuthenticationTypes.Federation", "name", "roles"));
        await AuthenticationSetup.ProvisionUserAsync(principal, context.RequestServices, context.RequestAborted);
        if (legacy)
        {
            var identity = (ClaimsIdentity)principal.Identity!;
            foreach (var claim in identity.Claims.Where(c => c.Type is CrmClaimTypes.SessionId or PermissionAuthorization.RolesVerifiedClaim).ToList())
            {
                identity.RemoveClaim(claim);
            }
        }

        await context.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal);
        context.Response.StatusCode = StatusCodes.Status204NoContent;
    }
}

/// <summary>Entra's refresh-token check, scripted (DEV-10): answers, refuses the account, or cannot be reached.</summary>
internal sealed class ScriptedTokenAcquisition : ITokenAcquisition
{
    private int _calls;

    /// <summary>What the next check throws; null when Entra answers.</summary>
    public Exception? Next { get; set; }

    public int Calls => Volatile.Read(ref _calls);

    public Task<string> GetAccessTokenForUserAsync(
        IEnumerable<string> scopes, string? authenticationScheme = null, string? tenantId = null, string? userFlow = null,
        ClaimsPrincipal? user = null, TokenAcquisitionOptions? tokenAcquisitionOptions = null)
    {
        Interlocked.Increment(ref _calls);
        return Next is { } error ? Task.FromException<string>(error) : Task.FromResult("refreshed-for-test");
    }

    public Task<AuthenticationResult> GetAuthenticationResultForUserAsync(
        IEnumerable<string> scopes, string? authenticationScheme = null, string? tenantId = null, string? userFlow = null,
        ClaimsPrincipal? user = null, TokenAcquisitionOptions? tokenAcquisitionOptions = null) => throw new NotSupportedException();

    public Task<string> GetAccessTokenForAppAsync(
        string scope, string? authenticationScheme = null, string? tenant = null, TokenAcquisitionOptions? tokenAcquisitionOptions = null) =>
        throw new NotSupportedException();

    public Task<AuthenticationResult> GetAuthenticationResultForAppAsync(
        string scope, string? authenticationScheme = null, string? tenant = null, TokenAcquisitionOptions? tokenAcquisitionOptions = null) =>
        throw new NotSupportedException();

    public void ReplyForbiddenWithWwwAuthenticateHeader(
        IEnumerable<string> scopes, MsalUiRequiredException msalServiceException, string? authenticationScheme = null, HttpResponse? httpResponse = null) =>
        throw new NotSupportedException();

    public string GetEffectiveAuthenticationScheme(string? authenticationScheme) => throw new NotSupportedException();

    public Task ReplyForbiddenWithWwwAuthenticateHeaderAsync(
        IEnumerable<string> scopes, MsalUiRequiredException msalServiceException, HttpResponse? httpResponse = null) =>
        throw new NotSupportedException();
}

public sealed class ManualTimeProvider(DateTimeOffset start) : TimeProvider
{
    private long _ticks = start.UtcTicks;

    /// <summary>
    /// Twelve hours behind the real clock: a test that moves its clock on by hours still writes nothing dated in the future into
    /// the shared database (the audit chain waits for entries younger than its settle time, and other classes run alongside).
    /// </summary>
    public static ManualTimeProvider InThePast() => new(DateTimeOffset.UtcNow.AddHours(-12));

    public override DateTimeOffset GetUtcNow() => new(Interlocked.Read(ref _ticks), TimeSpan.Zero);

    public void Advance(TimeSpan by) => Interlocked.Add(ref _ticks, by.Ticks);
}

/// <summary>Everything every category logs, formatted and with its structured values, for the hygiene check (DEV-10-AC06).</summary>
internal sealed class CapturingLoggerProvider : ILoggerProvider
{
    private readonly ConcurrentQueue<string> _lines = new();

    public IReadOnlyCollection<string> Lines => _lines;

    public ILogger CreateLogger(string categoryName) => new Logger(categoryName, _lines);

    public void Dispose()
    {
    }

    private sealed class Logger(string category, ConcurrentQueue<string> lines) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
        {
            lines.Enqueue($"scope {category}: {state}");
            return null;
        }

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            lines.Enqueue($"{logLevel} {category}: {formatter(state, exception)} {exception}");
            if (state is IEnumerable<KeyValuePair<string, object?>> values)
            {
                foreach (var (key, value) in values)
                {
                    lines.Enqueue($"  {key}={value}");
                }
            }
        }
    }
}
