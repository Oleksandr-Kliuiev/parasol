using System.Net;
using System.Text.RegularExpressions;
using Crm.Authorization;
using Crm.Identity.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M38: every employee has full access, so the development sign-in offers that first; the narrower roles stay for testing the
/// permission checks, which do not change. A test that changes the user's own settings signs in as a named user of its own.
/// </summary>
public sealed partial class DevelopmentSignInTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [GeneratedRegex("""<a href="/bff/dev-login\?role=(?<role>[^&"]+)&amp;returnUrl=(?<returnUrl>[^"]+)">(?<label>.*?)</a>""")]
    private static partial Regex SignInLink();

    private WebApplicationFactory<Program> DevelopmentHost() => factory.WithWebHostBuilder(builder =>
    {
        builder.UseEnvironment("Development");
        builder.UseSetting("Auth:Mode", "Development");
    });

    [Fact]
    public async Task The_page_offers_the_employee_with_full_access_first_and_keeps_the_return_address()
    {
        await using var host = DevelopmentHost();
        using var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        var response = await client.GetAsync("/bff/login?returnUrl=%2Fconnections", Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var html = await response.Content.ReadAsStringAsync(Ct);
        var links = SignInLink().Matches(html).ToList();
        links.Select(link => WebUtility.UrlDecode(link.Groups["role"].Value)).ShouldBe(CrmRoles.All);
        links[0].Groups["label"].Value.ShouldBe("Employee (full access) <small>Crm.Admin</small>");
        links.Skip(1).Select(link => link.Groups["label"].Value).ShouldBe(CrmRoles.All.Skip(1));
        links.ShouldAllBe(link => WebUtility.UrlDecode(link.Groups["returnUrl"].Value) == "/connections");
        html.IndexOf("Employee (full access)", StringComparison.Ordinal).ShouldBeLessThan(html.IndexOf("Other roles", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_named_user_is_a_development_user_of_its_own_with_the_same_role()
    {
        // The e2e language spec saves languages as Dev Language while other specs sign in as Dev Finance at the same time.
        await using var host = DevelopmentHost();
        using var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        (await client.GetAsync("/bff/dev-login?role=Crm.Finance&returnUrl=%2F", Ct)).StatusCode.ShouldBe(HttpStatusCode.Redirect);
        (await client.GetAsync("/bff/dev-login?role=Crm.Finance&user=Language&returnUrl=%2F", Ct)).StatusCode.ShouldBe(HttpStatusCode.Redirect);

        await using var scope = host.Services.CreateAsyncScope();
        var users = await scope.ServiceProvider.GetRequiredService<IdentityDbContext>().Users.AsNoTracking()
            .Where(u => u.TenantId == "00000000-0000-0000-0000-00000000dev0" && (u.ObjectId == "dev-finance" || u.ObjectId == "dev-finance-language"))
            .OrderBy(u => u.ObjectId).ToListAsync(Ct);
        users.Select(u => u.DisplayName).ShouldBe(["Dev Finance", "Dev Language"]);
        users.ShouldAllBe(u => u.Roles == CrmRoles.Finance);

        // Letters only: anything else names no development user.
        foreach (var user in new[] { "Language%20X", "..%2Fadmin", "Spr%C3%A5k", new string('a', 25) })
        {
            (await client.GetAsync($"/bff/dev-login?role=Crm.Finance&user={user}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound, user);
        }
    }
}
