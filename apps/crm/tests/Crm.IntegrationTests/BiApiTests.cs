using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Customers.Persistence;
using Crm.Reports;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-14: the BI read API. Tokens are signed with a key of the test's own that stands in for the tenant's published keys; every
/// other check — issuer, audience, lifetime, tenant claim, client allow-list, role or scope — is the production code's.
/// Billing figures are staged in March and April 2024: no other class bills those months.
/// </summary>
public class BiApiTests(CrmWebFactory factory)
{
    private const string Bi = "/api/v1/bi/v1";
    private const string Audience = "api://crm-bi-test";
    private static readonly string Tenant = Guid.NewGuid().ToString();
    private static readonly string Client = Guid.NewGuid().ToString();
    private static readonly RsaSecurityKey Key = new(RSA.Create(2048)) { KeyId = "bi-test" };
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private WebApplicationFactory<Program> Host(Action<Microsoft.AspNetCore.Hosting.IWebHostBuilder>? configure = null) =>
        factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Bi:Enabled", "true");
            builder.UseSetting("Bi:TenantId", Tenant);
            builder.UseSetting("Bi:Audience", Audience);
            builder.UseSetting("Bi:AllowedClients:0", Client);
            // A refresh of this suite's size reads many pages in a minute; the limit has a test of its own below.
            builder.UseSetting("Bi:RequestsPerMinute", "100000");
            configure?.Invoke(builder);
            builder.ConfigureTestServices(services => services.Configure<JwtBearerOptions>(BiAccess.Scheme, options =>
            {
                // Entra's metadata is not reachable here: the signing key comes from the test, nothing else is relaxed.
                options.Authority = null;
                options.Configuration = new OpenIdConnectConfiguration();
                options.TokenValidationParameters.IssuerSigningKey = Key;
            }));
        });

    private static string Token(
        string? tenant = null, string? audience = null, string? client = null, string[]? roles = null, string? scope = null, TimeSpan? expiresIn = null,
        SecurityKey? key = null, string? tidClaim = null, string? algorithm = null,
        IReadOnlyDictionary<string, object>? extra = null, bool withoutClientAuthentication = false)
    {
        var tid = tenant ?? Tenant;
        var lifetime = expiresIn ?? TimeSpan.FromHours(1);
        var claims = new Dictionary<string, object>
        {
            ["tid"] = tidClaim ?? tid, ["azp"] = client ?? Client, ["ver"] = "2.0", ["roles"] = roles ?? [BiAccess.ReadRole],
        };
        if (!withoutClientAuthentication)
        {
            claims["azpacr"] = "2";
        }

        foreach (var (name, value) in extra ?? new Dictionary<string, object>())
        {
            claims[name] = value;
        }

        if (scope is not null)
        {
            claims["scp"] = scope;
        }

        var now = DateTime.UtcNow;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = $"https://login.microsoftonline.com/{tid}/v2.0",
            Audience = audience ?? Audience,
            Claims = claims,
            NotBefore = lifetime < TimeSpan.Zero ? now.AddHours(-3) : now.AddMinutes(-1),
            IssuedAt = lifetime < TimeSpan.Zero ? now.AddHours(-3) : now.AddMinutes(-1),
            Expires = now.Add(lifetime),
            SigningCredentials = new SigningCredentials(key ?? Key, algorithm ?? SecurityAlgorithms.RsaSha256),
        });
    }

    private static HttpClient As(WebApplicationFactory<Program> host, string? token)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        if (token is not null)
        {
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        return client;
    }

    [Fact]
    public async Task AC01_an_expired_foreign_tenant_foreign_audience_unsigned_or_unfit_token_is_refused()
    {
        await using var host = Host();
        var url = $"{Bi}/datasets/organizations?pageSize=1";

        (await As(host, null).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await As(host, Token()).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Not accepted at all: expired, issued by another tenant, for another audience, signed with a key the tenant never published.
        (await As(host, Token(expiresIn: TimeSpan.FromMinutes(-90))).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await As(host, Token(tenant: Guid.NewGuid().ToString())).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await As(host, Token(audience: "api://something-else")).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await As(host, Token(key: new RsaSecurityKey(RSA.Create(2048)) { KeyId = "bi-test" })).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await As(host, "not.a.token").GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        // A valid token that does not fit: another tenant in the claim, a client application nobody named, no BI grant, a CRM role that is no BI grant.
        (await As(host, Token(tidClaim: Guid.NewGuid().ToString())).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await As(host, Token(client: Guid.NewGuid().ToString())).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await As(host, Token(roles: [])).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await As(host, Token(roles: [CrmRoles.Admin])).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await As(host, Token(roles: [], scope: "User.Read Files.Read")).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // No delegated scope opens the API, whatever it is called: a user's token is not checked against a CRM user.
        (await As(host, Token(roles: [], scope: "Bi.Read Bi.Cost")).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task AC01_only_rs256_access_tokens_pass_not_other_algorithms_or_tokens_of_another_kind()
    {
        await using var host = Host();
        var url = $"{Bi}/datasets/organizations?pageSize=1";

        // Signed with the right key but with an algorithm Entra does not use here.
        (await As(host, Token(algorithm: SecurityAlgorithms.RsaSha384)).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        // The shape of an id_token for the same audience: a nonce, or no sign of a client authentication.
        (await As(host, Token(extra: new Dictionary<string, object> { ["nonce"] = "abc" })).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await As(host, Token(withoutClientAuthentication: true)).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await As(host, Token(extra: new Dictionary<string, object> { ["idtyp"] = "user" })).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        // The real thing, with an explicit application type.
        (await As(host, Token(extra: new Dictionary<string, object> { ["idtyp"] = "app" })).GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AC01_the_start_of_a_bi_refresh_is_audited_per_dataset_with_the_client_but_not_per_page_or_with_rows()
    {
        await using var host = Host();
        var from = $"2023-{DateTime.UtcNow.Second % 9 + 1:00}-01";
        (await As(host, Token()).GetAsync($"{Bi}/datasets/organizations?from={from}&pageSize=1", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<Crm.Integrations.Core.Persistence.IntegrationDbContext>();
        var entries = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync(
            db.AuditEntries.Where(a => a.Module == "reports" && a.EntityType == "BiRead" && a.Changes!.Contains(Client) && a.Changes.Contains(from)), Ct);
        entries.Count.ShouldBe(1);
        entries[0].Action.ShouldBe("Read");
        entries[0].UserId.ShouldBeNull("a client application, not a CRM user");
        entries[0].Changes!.ShouldContain("\"dataset\":\"organizations\"");
    }

    [Fact]
    public async Task AC01_a_refused_bi_token_is_logged_without_its_contents()
    {
        var logs = new CapturingLoggerProvider();
        await using var host = Host(builder => builder.ConfigureServices(services => services.AddLogging(logging => logging.AddProvider(logs))));
        (await As(host, Token(expiresIn: TimeSpan.FromMinutes(-90))).GetAsync($"{Bi}/datasets/organizations?pageSize=1&cursor=secret-cursor", Ct))
            .StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await As(host, Token(client: Guid.NewGuid().ToString())).GetAsync($"{Bi}/datasets/organizations", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var lines = logs.Lines.Where(l => l.Contains("BI ", StringComparison.Ordinal)).ToList();
        lines.ShouldContain(l => l.Contains("BI bearer token rejected", StringComparison.Ordinal));
        lines.ShouldContain(l => l.Contains("BI access denied", StringComparison.Ordinal));
        logs.Lines.ShouldNotContain(l => l.Contains("eyJ", StringComparison.Ordinal) || l.Contains("secret-cursor", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AC01_the_api_stays_shut_unless_configured_with_a_named_client()
    {
        // Disabled (the default): the routes do not exist.
        (await factory.AnonymousClient().GetAsync($"{Bi}/datasets/organizations", Ct)).StatusCode.ShouldBeOneOf(HttpStatusCode.NotFound, HttpStatusCode.Unauthorized);

        // Enabled without a client list or audience the application refuses to start rather than admit everybody.
        var incomplete = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Bi:Enabled", "true");
            builder.UseSetting("Bi:TenantId", Tenant);
        });
        Should.Throw<InvalidOperationException>(() => incomplete.CreateClient()).Message.ShouldContain("Bi:AllowedClients");
        incomplete.Dispose();
    }

    [Fact]
    public async Task AC02_bi_access_reads_only_the_datasets_it_holds_and_opens_nothing_else()
    {
        await using var host = Host();
        var reader = As(host, Token());
        var costReader = As(host, Token(roles: [BiAccess.CostRole]));

        // The catalog lists what the caller may read: no cost data for the plain reader.
        var catalog = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/", Ct);
        var names = catalog.GetProperty("datasets").EnumerateArray().Select(d => d.GetProperty("name").GetString()!).ToList();
        names.ShouldContain("revenue-by-month");
        names.ShouldNotContain("margins");
        names.ShouldNotContain("microsoft-costs");
        // Records under record scope (quotes, projects) are in no dataset: a machine identity has no user to scope them by.
        names.ShouldNotContain(n => n.Contains("quote", StringComparison.Ordinal) || n.Contains("project", StringComparison.Ordinal));
        (await costReader.GetFromJsonAsync<JsonElement>($"{Bi}/", Ct)).GetProperty("datasets").EnumerateArray().Select(d => d.GetProperty("name").GetString())
            .ShouldBe(["margins", "microsoft-costs"], ignoreOrder: true);

        var denied = await reader.GetAsync($"{Bi}/datasets/margins", Ct);
        denied.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await denied.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BI_DATASET_FORBIDDEN");
        (await reader.GetAsync($"{Bi}/datasets/microsoft-costs", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await costReader.GetAsync($"{Bi}/datasets/margins", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await costReader.GetAsync($"{Bi}/datasets/revenue-by-month", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await reader.GetAsync($"{Bi}/datasets/what-ever", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await reader.GetAsync($"{Bi}/snapshots/organizations?month=2024-03", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // The bearer opens no door of the cookie API, whoever it names; the cookie session of an administrator opens none of the BI API.
        (await reader.GetAsync("/api/v1/reports/mart/organizations", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await reader.GetAsync("/api/v1/customers/organizations", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await reader.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        var admin = host.CreateClient();
        admin.DefaultRequestHeaders.Add("X-Test-Roles", CrmRoles.Admin);
        admin.DefaultRequestHeaders.Add("X-Test-User", "bi-admin");
        (await admin.GetAsync($"{Bi}/datasets/organizations", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        // Every route of the BI API sits behind the bi policy (and its bearer scheme) and nothing else.
        var routes = host.Services.GetRequiredService<Microsoft.AspNetCore.Routing.EndpointDataSource>().Endpoints
            .OfType<Microsoft.AspNetCore.Routing.RouteEndpoint>()
            .Where(e => e.RoutePattern.RawText?.StartsWith("/api/v1/bi/", StringComparison.Ordinal) == true)
            .ToList();
        routes.Count.ShouldBeGreaterThanOrEqualTo(3);
        routes.ShouldAllBe(e => e.Metadata.OfType<Microsoft.AspNetCore.Authorization.IAuthorizeData>().Any(a => a.Policy == BiAccess.Policy));
    }

    [Fact]
    public async Task AC03_a_client_application_has_its_own_request_budget_and_is_told_when_to_come_back()
    {
        var other = Guid.NewGuid().ToString();
        await using var shared = Host(b =>
        {
            b.UseSetting("Bi:RequestsPerMinute", "3");
            b.UseSetting("Bi:AllowedClients:1", other);
        });
        var first = As(shared, Token());
        var second = As(shared, Token(client: other));
        for (var i = 0; i < 3; i++)
        {
            (await first.GetAsync($"{Bi}/datasets/organizations?pageSize=1", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        var limited = await first.GetAsync($"{Bi}/datasets/organizations?pageSize=1", Ct);
        limited.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        limited.Headers.RetryAfter.ShouldNotBeNull();
        (await limited.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("RATE_LIMITED");
        // Another client application of the same tenant keeps its own budget.
        (await second.GetAsync($"{Bi}/datasets/organizations?pageSize=1", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AC03_a_refresh_reads_every_page_with_stable_names_and_types_and_the_next_refresh_misses_nothing()
    {
        await using var host = Host();
        var reader = As(host, Token());
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "bi-admin");
        var marker = $"B{Guid.NewGuid():N}"[..10];
        var created = new List<Guid>();
        for (var i = 0; i < 5; i++)
        {
            created.Add(await admin.CreateOrganizationAsync(TestData.Organization($"{marker} Side {i} AS")));
        }

        // Three or more pages whatever else the shared database holds.
        var total = (await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/organizations?pageSize=5000", Ct)).GetProperty("rows").GetArrayLength();
        var pageSize = Math.Max(1, total / 4);
        var definition = (await reader.GetFromJsonAsync<JsonElement>($"{Bi}/", Ct)).GetProperty("datasets").EnumerateArray()
            .Single(d => d.GetProperty("name").GetString() == "organizations");
        var declared = definition.GetProperty("columns").EnumerateArray().Select(c => (c.GetProperty("name").GetString(), c.GetProperty("type").GetString())).ToList();
        declared.ShouldBe([("organizationId", "guid"), ("name", "string"), ("orgNumber", "string"), ("status", "string")]);

        async Task<(List<JsonElement> Rows, JsonElement First, JsonElement Last, int Pages)> RefreshAsync()
        {
            var rows = new List<JsonElement>();
            JsonElement first = default, last = default;
            string? cursor = null;
            var pages = 0;
            do
            {
                var page = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/organizations?pageSize={pageSize}{(cursor is null ? string.Empty : $"&cursor={cursor}")}", Ct);
                pages++;
                pages.ShouldBeLessThan(500, "a refresh ends: every page moves the cursor on");
                first = pages == 1 ? page : first;
                last = page;
                page.GetProperty("schemaVersion").GetString().ShouldBe("1");
                page.GetProperty("columns").EnumerateArray().Select(c => (c.GetProperty("name").GetString(), c.GetProperty("type").GetString())).ToList().ShouldBe(declared);
                rows.AddRange(page.GetProperty("rows").EnumerateArray().Select(r => r.Clone()));
                cursor = page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.GetProperty("nextCursor").GetString();
                (cursor is null).ShouldBe(page.GetProperty("watermark").ValueKind != JsonValueKind.Null, "the watermark comes with the last page only");
            }
            while (cursor is not null);

            return (rows, first, last, pages);
        }

        var firstRefresh = await RefreshAsync();
        var ids = firstRefresh.Rows.Select(r => r[0].GetGuid()).ToList();
        firstRefresh.Pages.ShouldBeGreaterThanOrEqualTo(3);
        ids.Distinct().Count().ShouldBe(ids.Count, "every row once");
        created.ShouldBeSubsetOf(ids);
        ids.ShouldBe(ids.OrderBy(i => i.ToString(), StringComparer.Ordinal).ToList(), "pages follow the key order");
        firstRefresh.Rows.ShouldAllBe(r => r.GetArrayLength() == 4 && r[1].ValueKind == JsonValueKind.String);
        // The watermark is the moment the refresh began, the same on every page.
        firstRefresh.Last.GetProperty("watermark").GetDateTimeOffset().ShouldBe(firstRefresh.First.GetProperty("asOf").GetDateTimeOffset());

        // Classes running beside this one create organizations and delete some of theirs: a later read may hold more, and it may
        // lack a row the pages had only when that organization was deleted meanwhile (never one of this test's).
        async Task GoneOnlyByDeletionAsync(IEnumerable<Guid> missing)
        {
            var gone = missing.ToList();
            if (gone.Count == 0) return;
            gone.ShouldNotContain(id => created.Contains(id));
            await using var scope = factory.Services.CreateAsyncScope();
            (await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().Organizations.IgnoreQueryFilters()
                .CountAsync(o => gone.Contains(o.Id) && !o.IsDeleted, Ct)).ShouldBe(0, "a row leaves a later read only by a deletion");
        }

        // The same read in one page agrees with the pages: everything the pages had, in the same order.
        var whole = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/organizations?pageSize=5000", Ct);
        var wholeIds = whole.GetProperty("rows").EnumerateArray().Select(r => r[0].GetGuid()).ToList();
        await GoneOnlyByDeletionAsync(ids.Except(wholeIds));
        wholeIds.Where(ids.Contains).ToList().ShouldBe(ids.Where(wholeIds.Contains).ToList());
        wholeIds.ShouldBe(wholeIds.OrderBy(i => i.ToString(), StringComparer.Ordinal).ToList());

        // A change at the boundary: an organization appears after the refresh began. This refresh may or may not hold it; the
        // next one, which re-reads from the start, always does — and still holds everything the first had.
        var late = await admin.CreateOrganizationAsync(TestData.Organization($"{marker} Sen AS"));
        var secondRefresh = await RefreshAsync();
        var secondIds = secondRefresh.Rows.Select(r => r[0].GetGuid()).ToList();
        secondIds.ShouldContain(late);
        created.ShouldBeSubsetOf(secondIds);
        await GoneOnlyByDeletionAsync(ids.Except(secondIds));
        secondRefresh.Last.GetProperty("watermark").GetDateTimeOffset().ShouldBeGreaterThan(firstRefresh.Last.GetProperty("watermark").GetDateTimeOffset());

        // A cursor of nobody's is refused; page size is bounded.
        (await reader.GetAsync($"{Bi}/datasets/organizations?cursor=garbage", Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/organizations?pageSize=100000", Ct)).GetProperty("rows").GetArrayLength().ShouldBeLessThanOrEqualTo(5000);
    }

    [Fact]
    public async Task AC04_a_snapshot_of_a_closed_month_does_not_move_when_prices_names_or_the_hour_cost_change_later()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "bi-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "bi-finance");
        var stage = await StageBillingAsync(admin, finance);

        await using var host = Host();
        var cost = As(host, Token(roles: [BiAccess.ReadRole, BiAccess.CostRole]));

        // Only an open month cannot be snapshotted; a closed one can, once, and a correction is a new revision.
        (await finance.PostAsJsonAsync("/api/v1/reports/snapshots/2099-01", new { }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await finance.PostAsJsonAsync("/api/v1/reports/snapshots/not-a-month", new { }, Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await factory.ClientAs(CrmRoles.Sales, userKey: "bi-sales").PostAsJsonAsync("/api/v1/reports/snapshots/2024-03", new { }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var taken = await finance.PostAsJsonAsync("/api/v1/reports/snapshots/2024-03", new { reason = "DEV-14 test" }, Ct);
        taken.StatusCode.ShouldBe(HttpStatusCode.OK, await taken.Content.ReadAsStringAsync(Ct));
        (await taken.ReadJsonAsync()).GetProperty("taken").EnumerateArray().ShouldAllBe(t => t.GetProperty("revision").GetInt32() == 1);
        (await finance.PostAsJsonAsync("/api/v1/reports/snapshots/2024-03", new { }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Conflict);

        async Task<JsonElement> SnapshotAsync(string dataset, int? revision = null) =>
            await cost.GetFromJsonAsync<JsonElement>($"{Bi}/snapshots/{dataset}?month=2024-03{(revision is null ? string.Empty : $"&revision={revision}")}", Ct);

        var revenue = await SnapshotAsync("revenue-by-customer");
        var margins = await SnapshotAsync("margins");
        var months = await SnapshotAsync("revenue-by-month");
        revenue.GetProperty("revision").GetInt32().ShouldBe(1);
        // Taken long after the month ended: not passed off as the state at month end.
        revenue.GetProperty("provenance").GetString().ShouldBe("Reconstructed");
        revenue.GetProperty("sha256").GetString()!.Length.ShouldBe(64);
        Row(revenue, stage.OrganizationId)[2].GetDecimal().ShouldBe(2500m);
        Row(revenue, stage.OrganizationId)[1].GetString().ShouldBe(stage.Name);
        Row(margins, stage.OrganizationId)[9].GetDecimal().ShouldBe(650m, "the hourly cost used is part of the row");
        months.GetProperty("rows").EnumerateArray().Single(r => r[0].GetInt32() == 2024 && r[1].GetInt32() == 3)[2].GetDecimal().ShouldBe(2500m);
        var before = revenue.GetRawText() + margins.GetRawText() + months.GetRawText();

        // Later edits: the customer is renamed, the product's list price changes, and the company's hour cost is set higher.
        var current = await admin.GetAsync($"/api/v1/customers/organizations/{stage.OrganizationId}", Ct);
        var body = await current.ReadJsonAsync();
        (await admin.PutWithETagAsync($"/api/v1/customers/organizations/{stage.OrganizationId}", new
        {
            name = stage.Name + " omdøpt", orgNumber = body.GetProperty("orgNumber").GetString(), legalForm = "AS", status = "Customer", ehfEnabled = false,
            email = "post@example.no", visitAddress = new { street = "Storgata 1", postalCode = "0155", city = "Oslo", countryCode = "NO" },
            domains = new[] { "example.no" },
        }, current.Headers.ETag!.Tag)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var product = await finance.GetAsync($"/api/v1/catalog/products/{stage.ProductId}", Ct);
        (await finance.PutWithETagAsync($"/api/v1/catalog/products/{stage.ProductId}", CatalogApiTests.Product(stage.Sku, "Managed services", 9_999m, 1_000m), product.Headers.ETag!.Tag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        await using var costlier = Host(b => b.UseSetting("Reports:InternalHourlyCost", "900"));
        var costlierReader = As(costlier, Token(roles: [BiAccess.ReadRole, BiAccess.CostRole]));

        // Live data follows the edits; the snapshot, read through either host, is byte for byte what it was.
        var live = await costlierReader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/margins?from=2024-03-01&to=2024-03-31", Ct);
        Row(live, stage.OrganizationId)[9].GetDecimal().ShouldBe(900m);
        Row(live, stage.OrganizationId)[1].GetString().ShouldBe(stage.Name + " omdøpt");
        foreach (var reader in new[] { cost, costlierReader })
        {
            var again = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/snapshots/revenue-by-customer?month=2024-03", Ct);
            var marginsAgain = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/snapshots/margins?month=2024-03", Ct);
            var monthsAgain = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/snapshots/revenue-by-month?month=2024-03", Ct);
            (again.GetRawText() + marginsAgain.GetRawText() + monthsAgain.GetRawText()).ShouldBe(before);
        }

        // A correction is a new revision with the new numbers; revision 1 is still there as it was.
        var revised = await finance.PostAsJsonAsync("/api/v1/reports/snapshots/2024-03", new { reason = "Corrected name", revise = true }, Ct);
        revised.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await SnapshotAsync("revenue-by-customer")).GetProperty("revision").GetInt32().ShouldBe(2);
        Row(await SnapshotAsync("revenue-by-customer", 2), stage.OrganizationId)[1].GetString().ShouldBe(stage.Name + " omdøpt");
        (await SnapshotAsync("revenue-by-customer", 1)).GetRawText().ShouldBe(revenue.GetRawText());
        (await finance.GetFromJsonAsync<JsonElement>("/api/v1/reports/snapshots/2024-03", Ct)).GetProperty("datasets").EnumerateArray()
            .Single(d => d.GetProperty("dataset").GetString() == "margins").GetProperty("revisions").EnumerateArray().Select(r => r.GetInt32()).ShouldBe([1, 2], ignoreOrder: true);

        // Only datasets with history have snapshots, and a month nobody captured has none.
        (await cost.GetAsync($"{Bi}/snapshots/organizations?month=2024-03", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await cost.GetAsync($"{Bi}/snapshots/margins?month=2020-01", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task AC04_a_snapshot_that_no_longer_matches_its_hash_is_not_served()
    {
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "bi-finance");
        (await finance.PostAsJsonAsync("/api/v1/reports/snapshots/2024-05", new { reason = "DEV-14 test" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        await using var host = Host();
        var reader = As(host, Token(roles: [BiAccess.ReadRole, BiAccess.CostRole]));
        (await reader.GetAsync($"{Bi}/snapshots/recurring-revenue?month=2024-05", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Someone edits the stored object behind the application's back.
        var file = factory.Documents.PathOf("reports/snapshots/recurring-revenue/2024-05/r001.json");
        var text = await File.ReadAllTextAsync(file, Ct);
        text.ShouldContain("\"All\"");
        await File.WriteAllTextAsync(file, text.Replace("\"All\"", "\"Alx\"", StringComparison.Ordinal), Ct);

        var refused = await reader.GetAsync($"{Bi}/snapshots/recurring-revenue?month=2024-05", Ct);
        refused.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await refused.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("RPT_SNAPSHOT_CORRUPT");
        (await reader.GetAsync($"{Bi}/snapshots/revenue-by-month?month=2024-05", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AC06_the_figures_agree_with_their_sources_and_what_is_unpaid_is_never_called_paid()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "bi-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "bi-finance");
        var stage = await StageBillingAsync(admin, finance);
        await using var host = Host();
        var reader = As(host, Token(roles: [BiAccess.ReadRole, BiAccess.CostRole]));

        // Billing: March approved at 2 500, April only collected (a draft): approved and pending never mix.
        var months = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/revenue-by-month?from=2024-03-01&to=2024-04-30", Ct);
        var march = months.GetProperty("rows").EnumerateArray().Single(r => r[1].GetInt32() == 3);
        var april = months.GetProperty("rows").EnumerateArray().Single(r => r[1].GetInt32() == 4);
        (march[2].GetDecimal(), march[3].GetDecimal()).ShouldBe((2500m, 0m));
        (april[2].GetDecimal(), april[3].GetDecimal()).ShouldBe((0m, 2500m));

        // The customer's figure is the basis the run holds, and the margin starts from the same revenue.
        var basis = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/bases/{stage.BasisId}", Ct);
        basis.GetProperty("totalExVat").GetDecimal().ShouldBe(2500m);
        var byCustomer = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/revenue-by-customer?from=2024-03-01&to=2024-03-31", Ct);
        var margin = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/margins?from=2024-03-01&to=2024-03-31", Ct);
        Row(byCustomer, stage.OrganizationId)[2].GetDecimal().ShouldBe(2500m);
        Row(margin, stage.OrganizationId)[2].GetDecimal().ShouldBe(2500m);
        var april2 = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/revenue-by-customer?from=2024-04-01&to=2024-04-30", Ct);
        april2.GetProperty("rows").EnumerateArray().ShouldNotContain(r => r[0].GetGuid() == stage.OrganizationId, "a draft is not approved revenue");

        // Recurring revenue: ARR is MRR times twelve, row by row, and the total is the sum of its contract types. (Which contracts are
        // live on the date is the contracts module's answer, and a lifecycle job running beside this test may expire the staged one.)
        var recurring = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/recurring-revenue?from=2024-03-01&to=2024-03-31", Ct);
        var recurringRows = recurring.GetProperty("rows").EnumerateArray().ToList();
        var all = recurringRows.Single(r => r[1].GetString() == "All");
        all[0].GetString().ShouldBe("2024-03-31");
        recurringRows.Where(r => r[1].GetString() != "All").Sum(r => r[2].GetDecimal()).ShouldBe(all[2].GetDecimal());
        recurringRows.ShouldAllBe(r => r[3].GetDecimal() == decimal.Round(r[2].GetDecimal() * 12m, 2));

        // Invoices: invoiced and outstanding. The accounting system reported a smaller outstanding amount later; the CRM cannot say whether
        // that was a payment or a credit note, so it offers no "paid".
        var invoiceNo = $"BI-{Guid.NewGuid():N}"[..14];
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var billing = scope.ServiceProvider.GetRequiredService<IBillingApi>();
            var date = new DateOnly(2024, 3, 10);
            ExternalInvoice Invoice(decimal outstanding, InvoiceStatus status) =>
                new("poweroffice", invoiceNo, null, null, stage.OrganizationId, date, date.AddDays(14), 3125m, outstanding, status, null);
            await billing.UpsertInvoicesAsync([Invoice(3125m, InvoiceStatus.Sent)], Ct);
            await billing.UpsertInvoicesAsync([Invoice(1000m, InvoiceStatus.PartiallyPaid)], Ct);
        }

        var invoices = await reader.GetFromJsonAsync<JsonElement>($"{Bi}/datasets/invoices?from=2024-03-01&to=2024-03-31", Ct);
        var columns = invoices.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString()!).ToList();
        columns.ShouldContain("totalIncVat");
        columns.ShouldContain("outstanding");
        columns.ShouldNotContain(c => c.Contains("paid", StringComparison.OrdinalIgnoreCase) || c.Contains("payment", StringComparison.OrdinalIgnoreCase));
        var row = invoices.GetProperty("rows").EnumerateArray().Single(r => r[1].GetString() == invoiceNo);
        (row[5].GetDecimal(), row[6].GetDecimal()).ShouldBe((3125m, 1000m));

        // The definitions travel with the data, and say the same.
        var glossary = (await reader.GetFromJsonAsync<JsonElement>($"{Bi}/", Ct)).GetProperty("glossary");
        glossary.GetProperty("outstanding").GetString()!.ShouldContain("credit note");
        glossary.GetProperty("MRR").GetString()!.ShouldContain("Not revenue billed");
        glossary.GetProperty("billed (approved)").GetString()!.ShouldContain("frozen at approval");
    }

    private static JsonElement Row(JsonElement table, Guid organizationId) =>
        table.GetProperty("rows").EnumerateArray().Single(r => r[0].GetGuid() == organizationId);

    private sealed record Stage(Guid OrganizationId, string Name, Guid ProductId, string Sku, Guid BasisId);

    /// <summary>A customer with one monthly line of 2 500 over March and April 2024; March is collected and approved, April only collected. Staged once.</summary>
    private static readonly SemaphoreSlim StageLock = new(1, 1);
    private static Stage? _stage;

    // The status and body travel with the failure: a refused run (an open run for the period, a collect in progress) otherwise
    // surfaces as a missing "id" property far from its cause.
    private static async Task<Guid> CreateRunAsync(HttpClient finance, int year, int month, string marker)
    {
        var response = await finance.PostAsJsonAsync("/api/v1/billing/runs", new { year, month, notes = marker }, Ct);
        var body = await response.Content.ReadAsStringAsync(Ct);
        response.IsSuccessStatusCode.ShouldBeTrue($"{(int)response.StatusCode}: {body}");
        return System.Text.Json.JsonDocument.Parse(body).RootElement.GetProperty("id").GetGuid();
    }

    private async Task<Stage> StageBillingAsync(HttpClient admin, HttpClient finance)
    {
        await StageLock.WaitAsync(Ct);
        try
        {
            if (_stage is not null)
            {
                return _stage;
            }

            var marker = $"B{Guid.NewGuid():N}"[..10];
            var name = $"{marker} Bi AS";
            var organizationId = await admin.CreateOrganizationAsync(new { name, status = "Customer" });
            var sku = CatalogApiTests.Sku("BI");
            var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(sku, "Managed services", 2_500m, 1_000m));
            var contractId = (await (await admin.PostAsJsonAsync("/api/v1/contracts", new
            {
                organizationId, title = $"{marker} Drift", type = "Msp", startDate = "2024-03-01", endDate = "2024-04-30", autoRenew = false,
                renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
            }, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();
            (await admin.PostAsJsonAsync($"/api/v1/contracts/{contractId}/lines", new
            {
                productId, quantityModel = "Fixed", quantity = 1m, unitPrice = 2_500m, validFrom = "2024-03-01",
            }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            (await admin.PostAsync($"/api/v1/contracts/{contractId}/activate", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            BillingApiTests.StubToken(factory);
            await BillingApiTests.LinkAsync(admin, "Organization", organizationId, "Customer", Random.Shared.NextInt64(700_000, 799_999).ToString(CultureInfo.InvariantCulture));
            await BillingApiTests.LinkAsync(admin, "Product", productId, "Product", Random.Shared.NextInt64(10_000, 99_999).ToString(CultureInfo.InvariantCulture));

            // The approved March basis is sent to PowerOffice by whichever class drains the queue. BillingApiTests answers every order
            // request with its own order number at a lower priority; this customer's order gets a number of its own, or its basis would
            // share an order with that test's and the invoice would find the wrong one.
            factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost().WithBody(new WildcardMatcher($"*{organizationId:N}*"))).AtPriority(1)
                .RespondWith(JsonReply(new { Id = 7_100_000, OrderNo = Random.Shared.Next(7_100_000, 7_199_999), CustomerId = 1, Status = "Draft" }));
            var april = await CreateRunAsync(finance, 2024, 4, marker);
            (await finance.RunCommandAsync(april, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
            var march = await CreateRunAsync(finance, 2024, 3, marker);
            (await finance.RunCommandAsync(march, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
            (await finance.RunCommandAsync(march, "approve")).StatusCode.ShouldBe(HttpStatusCode.OK);
            var bases = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/runs/{march}/bases?search={marker}", Ct);
            var ours = bases.EnumerateArray().Where(b => b.GetProperty("organization").GetProperty("id").GetGuid() == organizationId).ToList();
            // What the run holds when the customer's basis is missing: the run itself and all its bases, to name the cause.
            ours.Count.ShouldBe(1, $"contract {await admin.GetStringAsync($"/api/v1/contracts/{contractId}", Ct)} run {await finance.GetStringAsync($"/api/v1/billing/runs/{march}", Ct)} bases {await finance.GetStringAsync($"/api/v1/billing/runs/{march}/bases", Ct)} filtered {bases.GetRawText()}");
            var basisId = ours[0].GetProperty("id").GetGuid();
            return _stage = new Stage(organizationId, name, productId, sku, basisId);
        }
        finally
        {
            StageLock.Release();
        }
    }
}
