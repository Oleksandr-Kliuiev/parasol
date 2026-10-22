using System.Net;
using Crm.Integrations.Atera;
using Crm.Integrations.Huntress;
using Crm.Integrations.PartnerCenter;
using Crm.Integrations.PowerOffice;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Crm.UnitTests;

/// <summary>
/// M39.0: provider clients never follow a redirect (CLAUDE.md, DEV-21). Following one would repeat the request, with its
/// <c>X-API-KEY</c> or subscription key, at whatever address the answer names. Atera also signs with a bearer token on request.
/// M41: both Huntress clients (reads and actions) end in the same handler, so Huntress's Basic credentials stay with Huntress.
/// </summary>
public class ProviderRedirectTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A plain HTTP server on a free loopback port that records what reaches it.</summary>
    private sealed class Loopback : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly List<(string Path, Dictionary<string, string> Headers)> _requests = [];

        private Loopback(WebApplication app) => _app = app;

        public Uri Address { get; private set; } = null!;

        public List<(string Path, Dictionary<string, string> Headers)> Requests
        {
            get { lock (_requests) return _requests.ToList(); }
        }

        public static async Task<Loopback> StartAsync(Func<HttpContext, Task> answer)
        {
            var builder = WebApplication.CreateSlimBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();
            var server = new Loopback(builder.Build());
            server._app.Run(async context =>
            {
                lock (server._requests)
                {
                    server._requests.Add((context.Request.Path.Value ?? string.Empty,
                        context.Request.Headers.ToDictionary(h => h.Key, h => h.Value.ToString(), StringComparer.OrdinalIgnoreCase)));
                }

                await answer(context);
            });
            await server._app.StartAsync();
            var bound = server._app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            server.Address = new Uri(bound.TrimEnd('/') + "/");
            return server;
        }

        public async ValueTask DisposeAsync()
        {
            await _app.StopAsync();
            await _app.DisposeAsync();
        }
    }

    private static Func<HttpContext, Task> RedirectTo(Loopback target) => context =>
    {
        context.Response.StatusCode = StatusCodes.Status302Found;
        context.Response.Headers.Location = new Uri(target.Address, "collect").ToString();
        return Task.CompletedTask;
    };

    private static ServiceProvider Providers(Dictionary<string, string?> settings)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection().AddLogging().AddSingleton(TimeProvider.System).AddSingleton<IConfiguration>(configuration);
        services.AddAteraIntegration(configuration).AddHuntressIntegration(configuration).AddPowerOfficeIntegration(configuration)
            .AddPartnerCenterIntegration(configuration);
        return services.BuildServiceProvider();
    }

    [Theory]
    [InlineData("IAteraClient")]
    [InlineData("IHuntressClient")]
    [InlineData("IHuntressActionClient")]
    [InlineData("IPowerOfficeClient")]
    [InlineData(PowerOfficeTokenProvider.HttpClientName)]
    [InlineData("IPartnerCenterClient")]
    [InlineData("IPartnerBillingClient")]
    [InlineData("PartnerCenterTokenProvider")]
    public void Every_provider_client_ends_in_a_handler_that_does_not_follow_redirects(string client)
    {
        using var services = Providers([]);
        HttpMessageHandler handler = services.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler(client);
        while (handler is DelegatingHandler outer)
        {
            handler = outer.InnerHandler!;
        }

        handler.ShouldBeOfType<SocketsHttpHandler>().AllowAutoRedirect.ShouldBeFalse();
    }

    [Fact]
    public async Task The_atera_key_never_reaches_the_address_a_redirect_names()
    {
        await using var elsewhere = await Loopback.StartAsync(_ => Task.CompletedTask);
        await using var atera = await Loopback.StartAsync(RedirectTo(elsewhere));
        using var services = Providers(new()
        {
            ["Integrations:Atera:Enabled"] = "true",
            ["Integrations:Atera:ApiKey"] = "atera-secret",
            ["Integrations:Atera:BaseUrl"] = new Uri(atera.Address, "api/v3/").ToString(),
        });

        var refused = await Should.ThrowAsync<AteraApiException>(async () =>
        {
            await foreach (var _ in services.GetRequiredService<IAteraClient>().GetCustomersAsync(Ct))
            {
            }
        });

        refused.Status.ShouldBe(HttpStatusCode.Found);
        atera.Requests.Count.ShouldBe(1);
        atera.Requests[0].Headers["X-API-KEY"].ShouldBe("atera-secret");
        elsewhere.Requests.ShouldBeEmpty();
    }

    [Fact]
    public async Task The_huntress_credentials_never_reach_the_address_a_redirect_names()
    {
        await using var elsewhere = await Loopback.StartAsync(_ => Task.CompletedTask);
        await using var huntress = await Loopback.StartAsync(RedirectTo(elsewhere));
        using var services = Providers(new()
        {
            ["Integrations:Huntress:Enabled"] = "true",
            ["Integrations:Huntress:ApiKey"] = "huntress-key",
            ["Integrations:Huntress:ApiSecret"] = "huntress-secret",
            ["Integrations:Huntress:BaseUrl"] = new Uri(huntress.Address, "v1/").ToString(),
        });

        var refused = await Should.ThrowAsync<HuntressApiException>(() => services.GetRequiredService<IHuntressActionClient>().GetAccountAsync(Ct));

        refused.Status.ShouldBe(HttpStatusCode.Found);
        huntress.Requests.ShouldHaveSingleItem().Headers["Authorization"].ShouldStartWith("Basic ");
        elsewhere.Requests.ShouldBeEmpty();
    }

    [Fact]
    public async Task The_poweroffice_keys_never_reach_the_address_a_redirect_names()
    {
        await using var elsewhere = await Loopback.StartAsync(_ => Task.CompletedTask);
        await using var powerOffice = await Loopback.StartAsync(RedirectTo(elsewhere));
        using var services = Providers(new()
        {
            ["Integrations:PowerOffice:Enabled"] = "true",
            ["Integrations:PowerOffice:ApplicationKey"] = "application",
            ["Integrations:PowerOffice:ClientKey"] = "client",
            ["Integrations:PowerOffice:SubscriptionKey"] = "subscription-secret",
            ["Integrations:PowerOffice:BaseUrl"] = new Uri(powerOffice.Address, "v2/").ToString(),
            ["Integrations:PowerOffice:TokenUrl"] = new Uri(powerOffice.Address, "OAuth/Token").ToString(),
        });

        var refused = await Should.ThrowAsync<HttpRequestException>(() => services.GetRequiredService<PowerOfficeTokenProvider>().GetTokenAsync(Ct));

        refused.StatusCode.ShouldBe(HttpStatusCode.Found);
        powerOffice.Requests.ShouldHaveSingleItem().Headers["Ocp-Apim-Subscription-Key"].ShouldBe("subscription-secret");
        elsewhere.Requests.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(null, "X-API-KEY", "atera-secret")]
    [InlineData("ApiKey", "X-API-KEY", "atera-secret")]
    [InlineData("Bearer", "Authorization", "Bearer atera-secret")]
    public async Task Atera_is_signed_with_one_header_of_the_configured_scheme(string? scheme, string header, string value)
    {
        await using var atera = await Loopback.StartAsync(context =>
        {
            context.Response.ContentType = "application/json";
            return context.Response.WriteAsync("""{"items":[],"totalPages":1}""");
        });
        using var services = Providers(new()
        {
            ["Integrations:Atera:Enabled"] = "true",
            ["Integrations:Atera:ApiKey"] = " atera-secret ",
            ["Integrations:Atera:Authentication"] = scheme,
            ["Integrations:Atera:BaseUrl"] = new Uri(atera.Address, "api/v3/").ToString(),
        });

        await foreach (var _ in services.GetRequiredService<IAteraClient>().GetCustomersAsync(Ct))
        {
        }

        var headers = atera.Requests.ShouldHaveSingleItem().Headers;
        headers[header].ShouldBe(value);
        headers.ShouldNotContainKey(header == "Authorization" ? "X-API-KEY" : "Authorization");
    }
}
