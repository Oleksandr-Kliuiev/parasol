using System.Net;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Protocols;

namespace Crm.IntegrationTests;

public sealed class EntraChallengeTests
{
    [Theory]
    [InlineData("/api/private")]
    [InlineData("/bff/user")]
    public async Task Anonymous_api_returns_401_without_contacting_Entra(string path)
    {
        await using var app = await CreateApp();
        using var client = app.GetTestClient();
        var response = await client.GetAsync(path);
        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        response.Headers.Location.ShouldBeNull();
    }

    [Fact]
    public async Task Browser_navigation_uses_local_login_and_explicit_login_still_challenges_Entra()
    {
        await using var app = await CreateApp();
        using var client = app.GetTestClient();
        var page = await client.GetAsync("/private");
        page.StatusCode.ShouldBe(HttpStatusCode.Redirect);
        page.Headers.Location!.AbsolutePath.ShouldBe("/bff/login");
        var login = await client.GetAsync("/login");
        login.StatusCode.ShouldBe(HttpStatusCode.Redirect);
        login.Headers.Location!.Host.ShouldBe("identity.example.test");
    }

    private static async Task<WebApplication> CreateApp()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Auth:Mode"] = "Entra",
            ["AzureAd:Instance"] = "https://login.microsoftonline.com/",
            ["AzureAd:TenantId"] = "00000000-0000-0000-0000-000000000001",
            ["AzureAd:ClientId"] = "00000000-0000-0000-0000-000000000002",
        });
        builder.Services.AddDataProtection().UseEphemeralDataProtectionProvider();
        builder.Services.AddDistributedMemoryCache();
        builder.AddCrmAuthentication();
        builder.Services.AddAuthorization();
        builder.Services.PostConfigure<OpenIdConnectOptions>(OpenIdConnectDefaults.AuthenticationScheme, options =>
        {
            options.Configuration = new OpenIdConnectConfiguration
            {
                Issuer = "https://identity.example.test/",
                AuthorizationEndpoint = "https://identity.example.test/authorize",
                TokenEndpoint = "https://identity.example.test/token",
            };
            options.ConfigurationManager = new StaticConfigurationManager<OpenIdConnectConfiguration>(options.Configuration);
            options.Backchannel = new HttpClient(new NoNetwork());
        });
        var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        foreach (var path in new[] { "/api/private", "/bff/user", "/private" })
            app.MapGet(path, () => "private").RequireAuthorization();
        app.MapGet("/login", () => Microsoft.AspNetCore.Http.Results.Challenge(
            new AuthenticationProperties(), [OpenIdConnectDefaults.AuthenticationScheme])).AllowAnonymous();
        await app.StartAsync();
        return app;
    }

    private sealed class NoNetwork : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => throw new InvalidOperationException("Test must never access an identity provider");
    }
}
