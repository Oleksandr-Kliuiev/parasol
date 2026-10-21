using System.Net;
using System.Text.RegularExpressions;
using Crm.Authorization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Crm.IntegrationTests;

/// <summary>
/// M38: every employee has full access, so the development sign-in offers that first; the narrower roles stay for testing the
/// permission checks, which do not change.
/// </summary>
public sealed partial class DevelopmentSignInTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [GeneratedRegex("""<a href="/bff/dev-login\?role=(?<role>[^&"]+)&amp;returnUrl=(?<returnUrl>[^"]+)">(?<label>.*?)</a>""")]
    private static partial Regex SignInLink();

    [Fact]
    public async Task The_page_offers_the_employee_with_full_access_first_and_keeps_the_return_address()
    {
        await using var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Development");
            builder.UseSetting("Auth:Mode", "Development");
        });
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
}
