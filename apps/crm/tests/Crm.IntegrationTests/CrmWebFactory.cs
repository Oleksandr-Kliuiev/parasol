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

/// <summary>
/// One SQL Server container and one application instance for the whole test assembly. The schema and the permissions are
/// applied by the migrator as the server administrator; the application then runs as a SQL login in the crm_worker role
/// only, without db_datawriter, exactly the rights it has in production (DEV-04). Tests that stand in for a database
/// administrator — a restore, data from before a migration — use <see cref="AdminSqlAsync"/>.
/// </summary>
public sealed class CrmWebFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string Database = "crm_tests";
    private readonly MsSqlContainer _sql = new MsSqlBuilder("mcr.microsoft.com/mssql/server:2022-latest").Build();
    private readonly Lock _clientsLock = new();
    private readonly TestKeyRing _keyRing = new();
    private readonly string _runtimePassword = $"Rt-{Guid.NewGuid():N}aA1!";

    /// <summary>The server administrator on the test database: what the migrator and a DBA have.</summary>
    public string AdminConnectionString => new Microsoft.Data.SqlClient.SqlConnectionStringBuilder(_sql.GetConnectionString()) { InitialCatalog = Database }.ConnectionString;

    /// <summary>Host and port of the SQL Server container, for a proxy in front of it (DEV-06).</summary>
    public (string Host, int Port) SqlEndpoint
    {
        get
        {
            var source = new Microsoft.Data.SqlClient.SqlConnectionStringBuilder(_sql.GetConnectionString()).DataSource.Split(',');
            return (source[0], source.Length > 1 ? int.Parse(source[1], System.Globalization.CultureInfo.InvariantCulture) : 1433);
        }
    }

    /// <summary>The login the application runs as: a member of crm_worker and nothing else.</summary>
    public string RuntimeConnectionString => LoginConnectionString("crm_worker_test", _runtimePassword);

    public string LoginConnectionString(string login, string password) =>
        new Microsoft.Data.SqlClient.SqlConnectionStringBuilder(_sql.GetConnectionString())
        {
            InitialCatalog = Database,
            UserID = login,
            Password = password,
        }.ConnectionString;

    public WireMockServer Brreg { get; } = WireMockServer.Start();

    public WireMockServer Graph { get; } = WireMockServer.Start();

    public WireMockServer PowerOffice { get; } = WireMockServer.Start();

    public WireMockServer Atera { get; } = WireMockServer.Start();

    public WireMockServer PartnerCenter { get; } = WireMockServer.Start();

    public RecordingEventHandler Events { get; } = new();

    public DeliveryProbes Probes { get; } = new();

    public TestDocumentStore Documents { get; } = new();

    public async ValueTask InitializeAsync()
    {
        // M43: every test's critical alert can queue a notice for the operations channel; the channel takes them, so they are sent
        // and leave the queue instead of coming back with a growing pause in front of other tests' cards.
        Graph.Given(WireMock.RequestBuilders.Request.Create().WithPath("/teams/operations").UsingPost())
            .RespondWith(WireMock.ResponseBuilders.Response.Create().WithStatusCode(202));
        await _sql.StartAsync();
        // The migrator: schema, Hangfire, roles and grants, as the administrator.
        await using (var migrator = new CrmMigrationFactory(this))
        {
            _ = migrator.Server;
        }

        await CreateLoginAsync("crm_worker_test", _runtimePassword, Crm.Infrastructure.Persistence.DatabaseRoles.Worker);
        // The application, as its runtime role.
        _ = Server;
    }

    /// <summary>Creates a SQL login and database user that is a member of <paramref name="role"/> only.</summary>
    public async Task CreateLoginAsync(string login, string password, string role)
    {
        await AdminSqlAsync($"""
            IF SUSER_ID(N'{login}') IS NULL CREATE LOGIN [{login}] WITH PASSWORD = N'{password}', CHECK_POLICY = OFF;
            IF DATABASE_PRINCIPAL_ID(N'{login}') IS NULL CREATE USER [{login}] FOR LOGIN [{login}];
            {Crm.Infrastructure.Persistence.DatabasePermissions.MembershipScript(login, role)}
            """);
    }

    /// <summary>Runs T-SQL as the server administrator on the test database.</summary>
    public async Task AdminSqlAsync(string sql)
    {
        await using var connection = new Microsoft.Data.SqlClient.SqlConnection(AdminConnectionString);
        await connection.OpenAsync();
        await using var command = new Microsoft.Data.SqlClient.SqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Runs parameterised T-SQL as the server administrator with the billing triggers disabled meanwhile — what a database
    /// administrator does to put back a restore or data from before a migration. Disabling, the statements and enabling run in
    /// one transaction: the schema lock keeps every other session out of those tables until the triggers are back, and a
    /// failure leaves them enabled. Classes that use it belong to <see cref="DatabaseAdministrationCollection"/>.
    /// </summary>
    public async Task AdminSqlWithoutBillingTriggersAsync(FormattableString sql)
    {
        string[] tables = ["BillingRuns", "BillingBases", "BillingLines", "BillingApprovals", "Charges", "BillingExportAttempts"];
        await using var connection = new Microsoft.Data.SqlClient.SqlConnection(AdminConnectionString);
        await connection.OpenAsync();
        await using var transaction = (Microsoft.Data.SqlClient.SqlTransaction)await connection.BeginTransactionAsync();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        var arguments = sql.GetArguments();
        var names = new object[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            names[i] = $"@p{i}";
            command.Parameters.AddWithValue($"@p{i}", arguments[i] ?? DBNull.Value);
        }

        command.CommandText = string.Concat(
            "SET DEADLOCK_PRIORITY HIGH;",
            string.Concat(tables.Select(t => $"DISABLE TRIGGER ALL ON [billing].[{t}];")),
            string.Format(System.Globalization.CultureInfo.InvariantCulture, sql.Format, names),
            ";",
            string.Concat(tables.Select(t => $"ENABLE TRIGGER ALL ON [billing].[{t}];")));
        await command.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
    }

    public override async ValueTask DisposeAsync()
    {
        Brreg.Stop();
        Graph.Stop();
        PowerOffice.Stop();
        Atera.Stop();
        PartnerCenter.Stop();
        await base.DisposeAsync();
        _keyRing.Dispose();
        await _sql.DisposeAsync();
        // The test run's own document folder; nothing else is ever stored there.
        if (Directory.Exists(Documents.Root))
        {
            Directory.Delete(Documents.Root, recursive: true);
        }
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder) => Configure(builder, RuntimeConnectionString, migrate: false);

    internal void Configure(IWebHostBuilder builder, string connectionString, bool migrate)
    {
        builder.UseEnvironment("Testing");
        // UseSetting (not ConfigureAppConfiguration) so values are visible while Program.cs registers services.
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:crm"] = connectionString,
            ["DataProtection:KeyRingPath"] = _keyRing.KeyRingPath,
            ["DataProtection:CertificatePath"] = _keyRing.CertificatePath,
            ["DataProtection:CertificatePassword"] = TestKeyRing.Password,
            ["Database:MigrateOnStartup"] = migrate ? "true" : "false",
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
            // M43: urgent alerts go to the operations channel; every test's critical alert can queue a notice there.
            ["Integrations:MicrosoftGraph:Teams:Channels:Operations"] = Graph.Url + "/teams/operations",
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
            // The integrity tests chain what they just wrote; the settle time has its own test.
            ["Audit:Integrity:SettleTime"] = "00:00:00",
            // A failed delivery is due again at once, so a test's next drain retries it; the delays have their own test.
            ["Outbox:RetryBaseDelay"] = "00:00:00",
            // Quote documents (DEV-08) go to a folder of this run; the store below wraps it with switchable failures.
            ["Documents:Provider"] = "FileSystem",
            ["Documents:RootPath"] = Documents.Root,
            ["Documents:VolumeId"] = Documents.VolumeId,
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
            // DEV-07: an event with two handlers whose failures and pauses the delivery tests switch on.
            services.AddSingleton(Probes);
            services.AddScoped<IDomainEventHandler<DeliveryProbe>, DeliveryProbeHandlerA>();
            services.AddScoped<IDomainEventHandler<DeliveryProbe>, DeliveryProbeHandlerB>();
            services.AddScoped<IDomainEventHandler<CrossModuleProbe>, CrossModuleProbeHandler>();
            services.AddSingleton<Crm.SharedKernel.Documents.IDocumentStore>(Documents);
        });
    }

    /// <summary>Client authenticated with the given App Roles; sends the CSRF header like the SPA does.</summary>
    public HttpClient ClientAs(string role, string? userKey = null, bool csrf = true)
    {
        var client = NewClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, userKey ?? role.ToLowerInvariant());
        if (csrf)
        {
            client.DefaultRequestHeaders.Add("X-CSRF", "1");
        }

        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    public HttpClient AnonymousClient() => NewClient();

    /// <summary>
    /// WebApplicationFactory keeps every client in a plain List to dispose it later. Test classes run in parallel, so
    /// unsynchronised adds can leave a null slot that makes DisposeAsync throw for the whole assembly; clients are therefore
    /// created one at a time.
    /// </summary>
    private HttpClient NewClient()
    {
        lock (_clientsLock)
        {
            return CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        }
    }
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
            // A stable user identifier: anti-forgery tokens are bound to it (without one they hash every claim, including the
            // per-request time claims below, and a token would never be valid for a later request).
            new(ClaimTypes.NameIdentifier, $"test-{userKey}"),
            new("preferred_username", $"{userKey}@test.local"),
            new("name", $"Test {userKey}"),
        };
        // Header users are present on every request: their interactive authentication is "now" (F-G2-08).
        var authTime = Context.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow().ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        claims.Add(new Claim("auth_time", authTime));
        claims.AddRange(roles.ToString().Split(',', StringSplitOptions.RemoveEmptyEntries).Select(r => new Claim("roles", r.Trim())));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName, "name", "roles"));
        if (ProvisionedUsers.TryGetValue(userKey, out var userId))
        {
            ((ClaimsIdentity)principal.Identity!).AddClaim(new Claim(CrmClaimTypes.UserId, userId));
            // The test authority confirms the header roles on every request (DEV-10); the session tests use real cookies instead.
            ((ClaimsIdentity)principal.Identity!).AddClaim(new Claim(
                Crm.Authorization.PermissionAuthorization.RolesVerifiedClaim,
                Context.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow().ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture)));
            ((ClaimsIdentity)principal.Identity!).AddClaim(new Claim(Crm.Authorization.PermissionAuthorization.AuthTimeClaim, authTime));
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
    // One counter for the ids of every external system, so they repeat neither within a system nor across systems. It starts at a
    // random point between 1 000 000 000 and 1 900 000 000: above the ranges the PowerOffice classes still draw their own ids from,
    // and below int.MaxValue, as PowerOffice and Atera keep some ids as 32-bit numbers. A run takes a few thousand.
    private static long externalId = 1_000_000_000 + Random.Shared.NextInt64(0, 900_000) * 1_000;

    /// <summary>
    /// A PowerOffice id (customer, product) that no other test of this run uses. The database is shared and classes run in
    /// parallel: a random number from a narrow range was sometimes an id another test had already linked, and the second link was
    /// refused (409 INT_EXTERNAL_ALREADY_LINKED). A counter cannot repeat itself.
    /// </summary>
    public static long PowerOfficeId() => Interlocked.Increment(ref externalId);

    /// <summary>The first of <paramref name="count"/> consecutive PowerOffice ids that no other test of this run uses.</summary>
    public static long PowerOfficeIds(int count) => Interlocked.Add(ref externalId, count) - count + 1;

    /// <summary>
    /// An Atera id (customer, contact, ticket, technician) that no other test of this run uses, for the same reason as
    /// <see cref="PowerOfficeId"/>. A technician maps to the first user it is seen with, and a ticket number to one mirror row.
    /// </summary>
    public static long AteraId() => Interlocked.Increment(ref externalId);

    /// <summary>The first of <paramref name="count"/> consecutive Atera ids that no other test of this run uses.</summary>
    public static long AteraIds(int count) => Interlocked.Add(ref externalId, count) - count + 1;

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

/// <summary>
/// Classes that act as the database administrator — disabling triggers to stage a restore or old data, checking what the roles
/// may do — run alone, so no other test sees the database in that state.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class DatabaseAdministrationCollection
{
    public const string Name = "database-administration";
}

/// <summary>The migrator run: the same application configuration, as the server administrator, migrating on start.</summary>
internal sealed class CrmMigrationFactory(CrmWebFactory factory) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder) => factory.Configure(builder, factory.AdminConnectionString, migrate: true);
}
