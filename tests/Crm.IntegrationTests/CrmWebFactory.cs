using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.SharedKernel.Domain;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Testcontainers.MsSql;
using WireMock.Server;

[assembly: AssemblyFixture(typeof(Crm.IntegrationTests.CrmWebFactory))]
[assembly: CaptureConsole]

namespace Crm.IntegrationTests;

/// <summary>One SQL Server container and one application instance for the whole test assembly.</summary>
public sealed class CrmWebFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder("mcr.microsoft.com/mssql/server:2022-latest").Build();

    public WireMockServer Brreg { get; } = WireMockServer.Start();

    public WireMockServer Graph { get; } = WireMockServer.Start();

    public WireMockServer PowerOffice { get; } = WireMockServer.Start();

    public WireMockServer Atera { get; } = WireMockServer.Start();

    public WireMockServer PartnerCenter { get; } = WireMockServer.Start();

    public RecordingEventHandler Events { get; } = new();

    public async ValueTask InitializeAsync()
    {
        await _sql.StartAsync();
        // Build the host (runs migrations on startup).
        _ = Server;
    }

    public override async ValueTask DisposeAsync()
    {
        Brreg.Stop();
        Graph.Stop();
        PowerOffice.Stop();
        Atera.Stop();
        PartnerCenter.Stop();
        await base.DisposeAsync();
        await _sql.DisposeAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        // UseSetting (not ConfigureAppConfiguration) so values are visible while Program.cs registers services.
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:crm"] = new Microsoft.Data.SqlClient.SqlConnectionStringBuilder(_sql.GetConnectionString())
            {
                InitialCatalog = "crm_tests",
            }.ConnectionString,
            ["Database:MigrateOnStartup"] = "true",
            ["Hangfire:DashboardEnabled"] = "false",
            ["Auth:Mode"] = "Entra",
            ["AzureAd:Instance"] = "https://login.microsoftonline.com/",
            ["AzureAd:TenantId"] = "11111111-1111-1111-1111-111111111111",
            ["AzureAd:ClientId"] = "22222222-2222-2222-2222-222222222222",
            ["Integrations:Brreg:BaseUrl"] = Brreg.Url + "/enhetsregisteret/api/",
            ["Integrations:Brreg:RequestsPerSecond"] = "50",
            ["RateLimits:ApiPerMinute"] = "100000",
            ["RateLimits:ExportsPerHour"] = "3",
            ["Auth:ActiveUserCacheSeconds"] = "0",
            ["Integrations:MicrosoftGraph:Enabled"] = "true",
            ["Integrations:MicrosoftGraph:TenantId"] = "11111111-1111-1111-1111-111111111111",
            ["Integrations:MicrosoftGraph:BaseUrl"] = Graph.Url + "/graph/v1.0/",
            ["Integrations:MicrosoftGraph:CalendarEnabled"] = "true",
            ["Integrations:MicrosoftGraph:MailEnabled"] = "true",
            ["Integrations:MicrosoftGraph:SharePoint:Enabled"] = "true",
            ["Integrations:MicrosoftGraph:SharePoint:SiteId"] = "vardahei.sharepoint.com,site,web",
            ["Integrations:MicrosoftGraph:SharePoint:DriveId"] = "drive-1",
            ["Integrations:MicrosoftGraph:Teams:Enabled"] = "true",
            ["Integrations:MicrosoftGraph:Teams:WonDealThreshold"] = "100000",
            ["Integrations:MicrosoftGraph:Teams:Channels:Sales"] = Graph.Url + "/teams/sales",
            ["Integrations:MicrosoftGraph:Teams:Channels:Finance"] = Graph.Url + "/teams/finance",
            ["Integrations:PowerOffice:Enabled"] = "true",
            ["Integrations:PowerOffice:ApplicationKey"] = "test-application-key",
            ["Integrations:PowerOffice:ClientKey"] = "test-client-key",
            ["Integrations:PowerOffice:SubscriptionKey"] = "test-subscription-key",
            ["Integrations:PowerOffice:BaseUrl"] = PowerOffice.Url + "/v2/",
            ["Integrations:PowerOffice:TokenUrl"] = PowerOffice.Url + "/OAuth/Token",
            ["Integrations:PowerOffice:PageSize"] = "2",
            ["Integrations:PowerOffice:RequestsPerSecond"] = "100",
            ["Integrations:PowerOffice:WriteEnabled"] = "true",
            ["Integrations:Atera:Enabled"] = "true",
            ["Integrations:Atera:ApiKey"] = "test-atera-key",
            ["Integrations:Atera:BaseUrl"] = Atera.Url + "/api/v3/",
            ["Integrations:Atera:ItemsInPage"] = "2",
            ["Integrations:Atera:RequestsPerMinute"] = "6000",
            ["Integrations:PartnerCenter:Enabled"] = "true",
            ["Integrations:PartnerCenter:TenantId"] = "11111111-1111-1111-1111-111111111111",
            ["Integrations:PartnerCenter:ClientId"] = "test-client",
            ["Integrations:PartnerCenter:ClientSecret"] = "test-secret",
            ["Integrations:PartnerCenter:RefreshToken"] = "test-refresh-token",
            ["Integrations:PartnerCenter:BaseUrl"] = PartnerCenter.Url + "/",
            ["Integrations:PartnerCenter:TokenUrl"] = PartnerCenter.Url + "/oauth2/token",
            ["Sales:EmailEnabled"] = "true",
            ["Sales:Company:Name"] = "Vardahei AS",
            ["Notifications:EmailEnabled"] = "true",
            ["Notifications:FromAddress"] = "crm@vardahei.no",
            ["Notifications:AppBaseUrl"] = "https://crm.test.local",
        };
        foreach (var (key, value) in settings)
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureLogging(logging => logging.SetMinimumLevel(LogLevel.Warning));
        builder.ConfigureTestServices(services =>
        {
            services.AddAuthentication(TestAuthHandler.SchemeName)
                .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.SchemeName, _ => { });
            services.PostConfigure<AuthenticationOptions>(options =>
            {
                options.DefaultScheme = TestAuthHandler.SchemeName;
                options.DefaultAuthenticateScheme = TestAuthHandler.SchemeName;
                options.DefaultChallengeScheme = TestAuthHandler.SchemeName;
                options.DefaultForbidScheme = TestAuthHandler.SchemeName;
                options.DefaultSignInScheme = TestAuthHandler.SchemeName;
            });
            services.AddSingleton<Azure.Core.TokenCredential>(new FakeTokenCredential());
            // The delegated Graph features (calendar, mailbox) need a user token; the real one comes from the BFF session.
            services.AddScoped<Crm.Integrations.MicrosoftGraph.IDelegatedTokenSource, FakeDelegatedTokenSource>();
            services.AddSingleton(Events);
            services.AddScoped<IDomainEventHandler<OrganizationCreated>>(sp => sp.GetRequiredService<RecordingEventHandler>());
        });
    }

    /// <summary>Client authenticated with the given App Roles; sends the CSRF header like the SPA does.</summary>
    public HttpClient ClientAs(string role, string? userKey = null, bool csrf = true)
    {
        var client = CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, userKey ?? role.ToLowerInvariant());
        if (csrf)
        {
            client.DefaultRequestHeaders.Add("X-CSRF", "1");
        }

        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    public HttpClient AnonymousClient() => CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
}

/// <summary>Authenticates requests from test headers and provisions the CRM user exactly like the real sign-in.</summary>
internal sealed class TestAuthHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Test";
    public const string RolesHeader = "X-Test-Roles";
    public const string UserHeader = "X-Test-User";
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> ProvisionedUsers = new();

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(RolesHeader, out var roles))
        {
            return AuthenticateResult.NoResult();
        }

        var userKey = Request.Headers[UserHeader].ToString();
        var claims = new List<Claim>
        {
            new(CrmClaimTypes.TenantId, "11111111-1111-1111-1111-111111111111"),
            new(CrmClaimTypes.ObjectId, $"test-{userKey}"),
            new("preferred_username", $"{userKey}@test.local"),
            new("name", $"Test {userKey}"),
        };
        claims.AddRange(roles.ToString().Split(',', StringSplitOptions.RemoveEmptyEntries).Select(r => new Claim("roles", r.Trim())));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName, "name", "roles"));
        if (ProvisionedUsers.TryGetValue(userKey, out var userId))
        {
            ((ClaimsIdentity)principal.Identity!).AddClaim(new Claim(CrmClaimTypes.UserId, userId));
        }
        else
        {
            // Same code path as a real sign-in; afterwards the user id is reused like a session cookie would.
            await AuthenticationSetup.ProvisionUserAsync(principal, Context.RequestServices, Context.RequestAborted);
            ProvisionedUsers.TryAdd(userKey, principal.FindFirstValue(CrmClaimTypes.UserId)!);
        }

        return AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName));
    }
}

internal sealed class FakeDelegatedTokenSource : Crm.Integrations.MicrosoftGraph.IDelegatedTokenSource
{
    public Task<string?> GetTokenAsync(IReadOnlyList<string> scopes, CancellationToken cancellationToken) =>
        Task.FromResult<string?>("test-delegated-token");
}

internal sealed class FakeTokenCredential : Azure.Core.TokenCredential
{
    public override Azure.Core.AccessToken GetToken(Azure.Core.TokenRequestContext requestContext, CancellationToken cancellationToken) =>
        new("test-graph-token", DateTimeOffset.UtcNow.AddHours(1));

    public override ValueTask<Azure.Core.AccessToken> GetTokenAsync(Azure.Core.TokenRequestContext requestContext, CancellationToken cancellationToken) =>
        ValueTask.FromResult(GetToken(requestContext, cancellationToken));
}

public sealed class RecordingEventHandler : IDomainEventHandler<OrganizationCreated>
{
    private readonly List<OrganizationCreated> _received = [];

    public IReadOnlyList<OrganizationCreated> Received
    {
        get
        {
            lock (_received)
            {
                return [.. _received];
            }
        }
    }

    public Task HandleAsync(OrganizationCreated domainEvent, CancellationToken cancellationToken)
    {
        lock (_received)
        {
            _received.Add(domainEvent);
        }

        return Task.CompletedTask;
    }
}

public static class TestData
{
    /// <summary>Random organization number with a valid MOD11 check digit.</summary>
    public static string OrgNumber()
    {
        int[] weights = [3, 2, 7, 6, 5, 4, 3, 2];
        while (true)
        {
            var digits = new int[8];
            digits[0] = Random.Shared.Next(8, 10);
            for (int i = 1; i < 8; i++)
            {
                digits[i] = Random.Shared.Next(0, 10);
            }

            int check = 11 - (digits.Select((d, i) => d * weights[i]).Sum() % 11);
            if (check == 11)
            {
                check = 0;
            }

            if (check != 10)
            {
                return string.Concat(digits) + check;
            }
        }
    }

    public static object Organization(string name, string? orgNumber = null, string status = "Prospect") => new
    {
        name,
        orgNumber = orgNumber ?? OrgNumber(),
        legalForm = "AS",
        status,
        email = "post@example.no",
        ehfEnabled = true,
        visitAddress = new { street = "Storgata 1", postalCode = "0155", city = "Oslo", countryCode = "NO" },
        domains = new[] { "example.no" },
    };

    public static string Admin => CrmRoles.Admin;
}
