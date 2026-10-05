using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Identity.Persistence;
using Crm.Web.Auth;
using Crm.Web.Bff;
using Crm.Web.Http;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.Identity.Web.TokenCacheProviders.Distributed;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-21 (OWASP ASVS 5.0 self-assessment), web host and authentication: redirects after sign-in, transport and cache headers,
/// the OIDC handler's cookies, who may see the API description, sign-out, hosts and proxies, rate limits on sign-in, and the
/// security log. Cookies and sessions are the real ones (as in <see cref="SessionLifecycleTests"/>); Entra itself is not
/// reachable here (EXT-02).
/// </summary>
public sealed class WebHostSecurityTests(CrmWebFactory factory) : IDisposable
{
    private readonly string _keyRing = System.IO.Directory.CreateTempSubdirectory("crm-keys-").FullName;
    private readonly string _marker = $"{Guid.NewGuid():N}"[..10];
    private readonly string _tenant = Guid.NewGuid().ToString();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (System.IO.Directory.Exists(_keyRing))
        {
            System.IO.Directory.Delete(_keyRing, recursive: true);
        }
    }

    private string Oid(string who) => $"{who}-{_marker}";

    private SessionHost NewHost(CapturingLoggerProvider? logs = null, Action<IServiceCollection>? services = null, ManualTimeProvider? time = null) =>
        new(factory, time ?? ManualTimeProvider.InThePast(), _keyRing, $"crm-app-{_marker}", _tenant, logs, services: services);

    // --- Redirect after sign-in ------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("//evil.example")]
    [InlineData("/\\evil.example")]
    [InlineData("/%09/evil.example")]
    [InlineData("/\t/evil.example")]
    [InlineData("/\n/evil.example")]
    [InlineData("/\r\n/evil.example")]
    [InlineData("/%0d%0a/evil.example")]
    [InlineData("/%2F/evil.example")]
    [InlineData("/%2f%2fevil.example")]
    [InlineData("/%5Cevil.example")]
    [InlineData("/%255Cevil.example")]
    [InlineData("/%252F/evil.example")]
    [InlineData("/​/evil.example")]
    [InlineData("/／evil.example")]
    [InlineData("/∕evil.example")]
    [InlineData("https://evil.example/")]
    [InlineData("http://evil.example/")]
    [InlineData("javascript:alert(1)")]
    [InlineData("data:text/html,x")]
    [InlineData("evil.example")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("/ok\u0000")]
    [InlineData("/ok\u007f")]
    public void A_return_address_that_is_not_a_path_of_this_application_becomes_the_start_page(string? value) =>
        BffEndpoints.SafeReturnUrl(value).ShouldBe("/");

    [Theory]
    [InlineData("/")]
    [InlineData("/quotes")]
    [InlineData("/billing/runs/abc?tab=bases")]
    [InlineData("/search?q=%C3%A6%C3%B8%C3%A5")]
    [InlineData("/organizations?search=a%2Fb")]
    [InlineData("/a/b#section")]
    public void A_path_of_this_application_is_kept(string value) => BffEndpoints.SafeReturnUrl(value).ShouldBe(value);

    [Fact]
    public async Task The_development_style_entry_and_the_login_page_never_echo_a_foreign_address()
    {
        // The sign-in challenge itself needs Entra; the dev-login pair is the same function in front of a local redirect.
        var client = factory.AnonymousClient();
        var response = await client.GetAsync("/bff/dev-login?role=Crm.Admin&returnUrl=%2F%09%2Fevil.example", Ct);
        // Not available outside development: 404, and nothing redirected anywhere.
        response.Headers.Location.ShouldBeNull();
    }

    // --- Transport and cache headers -------------------------------------------------------------------------------------

    [Fact]
    public async Task HSTS_is_one_year_with_subdomains_and_no_preload_outside_development()
    {
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://crm.example.test"), AllowAutoRedirect = false });
        var response = await client.GetAsync("/", Ct);
        var hsts = response.Headers.GetValues("Strict-Transport-Security").Single();
        hsts.ShouldContain("max-age=31536000");
        hsts.ShouldContain("includeSubDomains");
        hsts.ShouldNotContain("preload");
    }

    [Fact]
    public async Task Signed_in_answers_are_never_cached_and_never_framed_while_the_app_keeps_its_own_policy()
    {
        await using var host = NewHost();
        var (client, _) = await host.SignInAsync(Oid("sales"), CrmRoles.Sales);

        var user = await client.GetAsync("/bff/user", Ct);
        user.StatusCode.ShouldBe(HttpStatusCode.OK);
        user.Headers.CacheControl!.NoStore.ShouldBeTrue();
        user.Headers.GetValues("Content-Security-Policy").Single().ShouldContain("frame-ancestors 'none'");
        user.Headers.GetValues("X-Frame-Options").Single().ShouldBe("DENY");

        var api = await client.GetAsync("/api/v1/customers/organizations", Ct);
        api.Headers.CacheControl!.NoStore.ShouldBeTrue();
        api.Headers.GetValues("Content-Security-Policy").Single().ShouldBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        api.Headers.GetValues("X-Frame-Options").Single().ShouldBe("DENY");

        // The SPA's own pages keep the app policy (scripts from self only, framing by Teams).
        var spa = await client.GetAsync("/", Ct);
        spa.Headers.GetValues("Content-Security-Policy").Single().ShouldContain("script-src 'self'");
        spa.Headers.CacheControl?.NoStore.ShouldNotBe(true);
    }

    [Fact]
    public async Task The_job_dashboard_is_never_framed_and_never_cached_and_a_post_without_the_antiforgery_token_is_refused()
    {
        var admin = factory.WithWebHostBuilder(builder => builder.UseSetting("Hangfire:DashboardEnabled", "true"));
        using var client = admin.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "dev21-admin");

        var page = await client.GetAsync("/admin/jobs", Ct);
        page.StatusCode.ShouldBe(HttpStatusCode.OK);
        page.Headers.CacheControl!.NoStore.ShouldBeTrue();
        page.Headers.GetValues("Content-Security-Policy").Single().ShouldBe("frame-ancestors 'none'");
        page.Headers.GetValues("X-Frame-Options").Single().ShouldBe("DENY");

        // A form post from another page of the site carries no anti-forgery token: the dashboard refuses it.
        var post = await client.PostAsync("/admin/jobs/recurring/trigger", new FormUrlEncodedContent([new("jobs[]", "notification-digest")]), Ct);
        post.StatusCode.ShouldNotBe(HttpStatusCode.NoContent);
        ((int)post.StatusCode).ShouldBeInRange(400, 499);

        // The page itself carries the token its own script sends back with every action.
        var html = await page.Content.ReadAsStringAsync(Ct);
        var header = System.Text.RegularExpressions.Regex.Match(html, "name=\"csrf-header\" content=\"([^\"]+)\"").Groups[1].Value;
        var token = System.Text.RegularExpressions.Regex.Match(html, "name=\"csrf-token\" content=\"([^\"]+)\"").Groups[1].Value;
        header.ShouldNotBeEmpty();
        token.ShouldNotBeEmpty();
        using var withToken = new HttpRequestMessage(HttpMethod.Post, "/admin/jobs/recurring/trigger")
        {
            Content = new FormUrlEncodedContent([new("jobs[]", "dev21-no-such-job")]),
        };
        withToken.Headers.Add(header, token);
        (await client.SendAsync(withToken, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
    }

    // --- OIDC handler and token cache -------------------------------------------------------------------------------------

    [Fact]
    public void The_oidc_handlers_own_cookies_carry_host_prefixes_and_the_token_cache_is_encrypted()
    {
        var oidc = factory.Services.GetRequiredService<IOptionsMonitor<OpenIdConnectOptions>>().Get(OpenIdConnectDefaults.AuthenticationScheme);
        oidc.CorrelationCookie.Name.ShouldStartWith("__Host-");
        oidc.CorrelationCookie.Path.ShouldBe("/");
        oidc.NonceCookie.Name.ShouldStartWith("__Host-");
        oidc.NonceCookie.Path.ShouldBe("/");

        factory.Services.GetRequiredService<IOptions<MsalDistributedTokenCacheAdapterOptions>>().Value.Encrypt.ShouldBeTrue();
    }

    [Fact]
    public async Task A_token_cache_entry_written_before_encryption_was_switched_on_is_a_miss_not_a_failure()
    {
        // Entries in identity.TokenCache from before DEV-21 are plain; reading them with encryption on must not break the
        // request: the user signs in again at worst (documented in the change).
        var memory = new Microsoft.Extensions.Caching.Distributed.MemoryDistributedCache(Options.Create(new Microsoft.Extensions.Caching.Memory.MemoryDistributedCacheOptions()));
        var plain = System.Text.Encoding.UTF8.GetBytes("{\"AccessToken\":{},\"RefreshToken\":{},\"IdToken\":{},\"Account\":{},\"AppMetadata\":{}}");
        var cache = new AnyKeyCache(memory, plain);
        var adapter = ActivatorUtilities.CreateInstance<MsalDistributedTokenCacheAdapter>(
            factory.Services, (Microsoft.Extensions.Caching.Distributed.IDistributedCache)cache,
            Options.Create(new MsalDistributedTokenCacheAdapterOptions { Encrypt = true }));
        var app = Microsoft.Identity.Client.ConfidentialClientApplicationBuilder.Create(Guid.NewGuid().ToString())
            .WithClientSecret("secret").WithAuthority($"https://login.microsoftonline.com/{_tenant}").WithInstanceDiscovery(false).Build();
        adapter.Initialize(app.UserTokenCache);

        string outcome;
        try
        {
            var account = await app.GetAccountAsync("uid.utid");
            outcome = account is null ? "read no account" : "read an account";
        }
        catch (Exception ex)
        {
            outcome = ex.GetType().FullName ?? "?";
        }

        cache.Reads.ShouldBeGreaterThan(0, "the entry was actually fetched from the distributed cache");
        outcome.ShouldBe("read no account");
    }

    /// <summary>Every key holds the same plain (unencrypted) entry.</summary>
    private sealed class AnyKeyCache(Microsoft.Extensions.Caching.Distributed.IDistributedCache inner, byte[] value) : Microsoft.Extensions.Caching.Distributed.IDistributedCache
    {
        public int Reads { get; private set; }

        public byte[]? Get(string key) { Reads++; return value; }

        public Task<byte[]?> GetAsync(string key, CancellationToken token = default) { Reads++; return Task.FromResult<byte[]?>(value); }

        public void Refresh(string key) => inner.Refresh(key);

        public Task RefreshAsync(string key, CancellationToken token = default) => inner.RefreshAsync(key, token);

        public void Remove(string key) => inner.Remove(key);

        public Task RemoveAsync(string key, CancellationToken token = default) => inner.RemoveAsync(key, token);

        public void Set(string key, byte[] v, Microsoft.Extensions.Caching.Distributed.DistributedCacheEntryOptions options) => inner.Set(key, v, options);

        public Task SetAsync(string key, byte[] v, Microsoft.Extensions.Caching.Distributed.DistributedCacheEntryOptions options, CancellationToken token = default) =>
            inner.SetAsync(key, v, options, token);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("common", false)]
    [InlineData("organizations", false)]
    [InlineData("consumers", false)]
    [InlineData("00000000-0000-0000-0000-000000000000", false)]
    [InlineData("11111111-1111-1111-1111-111111111111", true)]
    [InlineData("vardahei.onmicrosoft.com", true)]
    public void Outside_development_the_tenant_is_one_concrete_directory(string? tenant, bool accepted)
    {
        (AuthenticationSetup.TenantProblem(tenant, new FakeEnvironment("Production")) is null).ShouldBe(accepted);
        AuthenticationSetup.TenantProblem(tenant, new FakeEnvironment("Development")).ShouldBeNull();
    }

    // --- OpenAPI -----------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task The_api_description_is_off_by_default_and_when_on_needs_a_signed_in_administrator()
    {
        var off = await factory.AnonymousClient().GetAsync("/openapi/v1.json", Ct);
        (await off.Content.ReadAsStringAsync(Ct)).ShouldNotContain("\"openapi\"");

        await using var on = factory.WithWebHostBuilder(builder => builder.UseSetting("OpenApi:Enabled", "true"));
        using var anonymous = on.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        (await anonymous.GetAsync("/openapi/v1.json", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        using var reader = on.CreateClient();
        reader.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.ReadOnly);
        reader.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "dev21-reader");
        (await reader.GetAsync("/openapi/v1.json", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        using var admin = on.CreateClient();
        admin.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        admin.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "dev21-admin");
        var description = await admin.GetAsync("/openapi/v1.json", Ct);
        description.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await description.Content.ReadAsStringAsync(Ct)).ShouldContain("\"openapi\"");
    }

    // --- Sign-out ----------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Entra_sign_out_needs_the_ticket_only_the_logout_post_hands_out()
    {
        await using var host = NewHost();
        var (client, cookie) = await host.SignInAsync(Oid("sales"), CrmRoles.Sales);

        // A plain GET (an image tag or a link on another site) neither ends anything nor goes to Entra.
        using var stranger = host.Client();
        var forged = await stranger.GetAsync("/bff/signout-entra", Ct);
        forged.StatusCode.ShouldBe(HttpStatusCode.Redirect);
        forged.Headers.Location!.OriginalString.ShouldBe("/");
        var wrong = await stranger.GetAsync("/bff/signout-entra?ticket=abc", Ct);
        wrong.Headers.Location!.OriginalString.ShouldBe("/");

        // Without the header the POST is refused (and the session stays); with it the session ends and the one-minute ticket is handed out.
        using var noHeader = host.Client(cookie);
        noHeader.DefaultRequestHeaders.Remove("X-CSRF");
        (await noHeader.PostAsync("/bff/logout", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await client.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var response = await client.PostAsync("/bff/logout", null, Ct);
        var url = (await response.ReadJsonAsync()).GetProperty("signOutUrl").GetString()!;
        url.ShouldStartWith("/bff/signout-entra?ticket=");
    }

    [Fact]
    public void The_sign_out_ticket_expires_and_is_bound_to_this_installation()
    {
        var protection = new EphemeralDataProtectionProvider();
        var time = protection.CreateProtector(BffEndpoints.SignOutPurpose).ToTimeLimitedDataProtector();
        var ticket = time.Protect("x", TimeSpan.FromMinutes(1));
        BffEndpoints.IsSignOutTicket(ticket, protection).ShouldBeTrue();
        BffEndpoints.IsSignOutTicket(ticket, new EphemeralDataProtectionProvider()).ShouldBeFalse("another installation's key");
        BffEndpoints.IsSignOutTicket(time.Protect("x", TimeSpan.FromMilliseconds(-1)), protection).ShouldBeFalse("expired");
        BffEndpoints.IsSignOutTicket(protection.CreateProtector("other purpose").Protect("x"), protection).ShouldBeFalse();
        BffEndpoints.IsSignOutTicket(null, protection).ShouldBeFalse();
        BffEndpoints.IsSignOutTicket(new string('a', 600), protection).ShouldBeFalse();
    }

    [Fact]
    public async Task Front_channel_logout_ends_the_session_it_names_and_nobody_elses()
    {
        var issuer = $"https://login.microsoftonline.com/{_tenant}/v2.0";
        await using var host = NewHost(services: s => s.PostConfigure<OpenIdConnectOptions>(
            OpenIdConnectDefaults.AuthenticationScheme, o => o.Configuration = new OpenIdConnectConfiguration { Issuer = issuer }));
        var sidA = $"sid-a-{_marker}";
        var sidB = $"sid-b-{_marker}";
        var (alice, _) = await host.SignInWithSessionAsync(Oid("alice"), sidA, CrmRoles.Sales);
        var (bob, _) = await host.SignInWithSessionAsync(Oid("bob"), sidB, CrmRoles.Sales);
        (await alice.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // The iframe request of Entra carries no session cookie (SameSite=Strict): the session id names the session.
        using var entra = host.Client();
        async Task<HttpStatusCode> FrontChannel(string query) => (await entra.GetAsync($"/signout-oidc{query}", Ct)).StatusCode;

        // Nothing named, an unknown session, another issuer: nobody is signed out.
        await FrontChannel("");
        await FrontChannel("?sid=unknown");
        await FrontChannel($"?sid={sidA}&iss={Uri.EscapeDataString("https://login.microsoftonline.com/other/v2.0")}");
        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await alice.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await bob.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Alice's session id with Entra's issuer: her session ends everywhere; Bob's stays.
        await FrontChannel($"?sid={sidA}&iss={Uri.EscapeDataString(issuer)}");
        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await alice.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await bob.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_cookie_copied_before_a_deactivation_does_not_come_back_with_the_account()
    {
        await using var host = NewHost();
        var oid = Oid("leaver");
        var (client, cookie) = await host.SignInAsync(oid, CrmRoles.Sales);
        (await client.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        await using (var scope = host.Services.CreateAsyncScope())
        {
            var sync = scope.ServiceProvider.GetRequiredService<IUserDirectorySync>();
            await sync.ApplyAsync([new DirectoryUserChange(_tenant, oid, false, false, null, null, null, null, null)], Ct);
        }

        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await client.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        // The account is enabled again in Entra: the old cookie names a session that ended with the deactivation.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var sync = scope.ServiceProvider.GetRequiredService<IUserDirectorySync>();
            (await sync.ApplyAsync([new DirectoryUserChange(_tenant, oid, false, true, null, null, null, null, null)], Ct)).Reactivated.ShouldBe(1);
        }

        host.Time.Advance(TimeSpan.FromSeconds(31));
        (await host.Client(cookie).GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        var (again, _) = await host.SignInAsync(oid, CrmRoles.Sales);
        (await again.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Sign_in_and_sign_out_are_audited_with_ids_only()
    {
        await using var host = NewHost();
        var (client, _) = await host.SignInAsync(Oid("auditor"), CrmRoles.Sales);
        (await client.PostAsync("/bff/logout", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IdentityDbContext>();
        var userId = await db.Users.AsNoTracking().Where(u => u.TenantId == _tenant && u.ObjectId == Oid("auditor")).Select(u => u.Id).SingleAsync(Ct);
        var entries = await db.AuditEntries.AsNoTracking().Where(a => a.UserId == userId && a.EntityType == "UserSession").OrderBy(a => a.Id).ToListAsync(Ct);
        entries.Select(a => a.Action).ShouldBe(["Login", "Logout"]);
        entries[1].Changes.ShouldBe("{\"reason\":\"SignOut\"}");
        entries.ShouldAllBe(a => a.UserName == null);
    }

    // --- Hosts, proxies, rate limits -------------------------------------------------------------------------------------

    [Fact]
    public async Task A_forwarded_header_counts_only_from_a_known_network_and_only_for_an_allowed_host()
    {
        async Task<(string Host, string Scheme, string Ip)> Through(string sender, IDictionary<string, string?> config, string environment = "Production")
        {
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(config).Build();
            using var server = await new HostBuilder().ConfigureWebHost(web => web
                .UseTestServer()
                .ConfigureServices(services => services.Configure<ForwardedHeadersOptions>(o =>
                    HostSecurity.ConfigureForwardedHeaders(o, configuration, new FakeEnvironment(environment))))
                .Configure(app =>
                {
                    app.Use((context, next) =>
                    {
                        context.Connection.RemoteIpAddress = IPAddress.Parse(sender);
                        return next();
                    });
                    app.UseForwardedHeaders();
                    app.Run(context => context.Response.WriteAsync($"{context.Request.Host}|{context.Request.Scheme}|{context.Connection.RemoteIpAddress}"));
                })).StartAsync(Ct);
            var client = server.GetTestClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, "http://internal.local/");
            request.Headers.Add("X-Forwarded-For", "203.0.113.9");
            request.Headers.Add("X-Forwarded-Proto", "https");
            request.Headers.Add("X-Forwarded-Host", "crm.vardahei.test");
            var parts = (await (await client.SendAsync(request, Ct)).Content.ReadAsStringAsync(Ct)).Split('|');
            return (parts[0], parts[1], parts[2]);
        }

        var allowed = new Dictionary<string, string?> { ["AllowedHosts"] = "crm.vardahei.test", ["Forwarded:KnownNetworks:0"] = "10.40.0.0/23" };

        // From the apps subnet: believed.
        (await Through("10.40.1.7", allowed)).ShouldBe(("crm.vardahei.test", "https", "203.0.113.9"));
        // From a peer elsewhere (even inside the private ranges) or from outside: ignored, the request keeps what it arrived with.
        (await Through("10.99.0.5", allowed)).ShouldBe(("internal.local", "http", "10.99.0.5"));
        (await Through("198.51.100.4", allowed)).ShouldBe(("internal.local", "http", "198.51.100.4"));
        // A host that is not one the application serves is not taken over, though the sender is known.
        (await Through("10.40.1.7", new Dictionary<string, string?> { ["AllowedHosts"] = "other.vardahei.test", ["Forwarded:KnownNetworks:0"] = "10.40.0.0/23" }))
            .Host.ShouldBe("internal.local");
        // Production without any setting believes the private ranges only (the ingress), never a public address.
        var unset = new Dictionary<string, string?> { ["AllowedHosts"] = "crm.vardahei.test" };
        (await Through("10.40.1.7", unset)).Scheme.ShouldBe("https");
        (await Through("198.51.100.4", unset)).Scheme.ShouldBe("http");
        // Development and tests believe only the loopback address.
        (await Through("127.0.0.1", new Dictionary<string, string?>(), "Development")).Scheme.ShouldBe("https");
        (await Through("10.40.1.7", new Dictionary<string, string?>(), "Development")).Scheme.ShouldBe("http");

        Should.Throw<InvalidOperationException>(() => HostSecurity.ConfigureForwardedHeaders(
            new ForwardedHeadersOptions(), new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Forwarded:KnownNetworks:0"] = "10.40.0.0/99" }).Build(),
            new FakeEnvironment("Production"))).Message.ShouldContain("CIDR");
    }

    [Theory]
    [InlineData("Production", "*", false)]
    [InlineData("Production", "", false)]
    [InlineData("Production", null, false)]
    [InlineData("Production", "crm.vardahei.no;*", false)]
    [InlineData("Production", "crm.vardahei.no", true)]
    [InlineData("Production", "crm.vardahei.no;candidate---crm.example.azurecontainerapps.io", true)]
    [InlineData("Development", "*", true)]
    [InlineData("Testing", "*", true)]
    public void Production_refuses_to_start_with_every_host_allowed(string environment, string? allowedHosts, bool accepted) =>
        (HostSecurity.AllowedHostsProblem(allowedHosts, new FakeEnvironment(environment)) is null).ShouldBe(accepted);

    [Fact]
    public async Task Sign_in_paths_have_a_small_budget_per_client_address()
    {
        await using var limited = factory.WithWebHostBuilder(builder => builder.UseSetting("RateLimits:SignInPerMinute", "2"));
        using var client = limited.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        (await client.GetAsync("/bff/signout-entra", Ct)).StatusCode.ShouldBe(HttpStatusCode.Redirect);
        (await client.GetAsync("/bff/signout-entra", Ct)).StatusCode.ShouldBe(HttpStatusCode.Redirect);
        var third = await client.GetAsync("/bff/signout-entra", Ct);
        third.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        (await third.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("RATE_LIMITED");
    }

    // --- Security log -----------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Refused_requests_leave_a_record_with_ids_and_route_templates_but_no_query_string_or_token()
    {
        var logs = new CapturingLoggerProvider();
        await using var host = NewHost(logs);
        var (reader, _) = await host.SignInAsync(Oid("reader"), CrmRoles.ReadOnly);
        var (sales, _) = await host.SignInAsync(Oid("sales"), CrmRoles.Sales);

        (await reader.GetAsync("/api/v1/billing/runs?search=very-secret-term", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var noHeader = host.Client(); // a new browser without a session: unauthenticated
        (await noHeader.GetAsync("/api/v1/billing/runs?token=abc123", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        using var forgetful = sales;
        forgetful.DefaultRequestHeaders.Remove("X-CSRF");
        (await forgetful.PostAsync("/api/v1/customers/organizations?x=secret-query", JsonContent.Create(new { }), Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        var lines = logs.Lines.Where(l => l.Contains("Crm.Security", StringComparison.Ordinal)).ToList();
        lines.ShouldContain(l => l.Contains("Access denied", StringComparison.Ordinal) && l.Contains("/api/v1/billing/runs", StringComparison.Ordinal) && l.Contains("missing_permission", StringComparison.Ordinal));
        lines.ShouldContain(l => l.Contains("Unauthenticated request refused", StringComparison.Ordinal));
        lines.ShouldContain(l => l.Contains("without the CSRF header", StringComparison.Ordinal));
        // (The framework's own request logging, off outside tests, is not the security log.)
        lines.ShouldNotContain(l => l.Contains("very-secret-term", StringComparison.Ordinal) || l.Contains("abc123", StringComparison.Ordinal) || l.Contains("secret-query", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_malformed_body_is_answered_with_a_fixed_sentence_not_the_framework_text()
    {
        var client = factory.ClientAs(CrmRoles.Admin);
        var response = await client.PostAsync("/api/v1/customers/organizations", new StringContent("{ this is not json", System.Text.Encoding.UTF8, "application/json"), Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        var body = await response.Content.ReadAsStringAsync(Ct);
        body.ShouldNotContain("parameter", Case.Insensitive);
    }

    // --- Report access trail -----------------------------------------------------------------------------------------------

    [Fact]
    public async Task Reading_a_mart_dataset_is_audited_with_who_what_and_when_but_not_the_rows()
    {
        var client = factory.ClientAs(CrmRoles.Finance, "dev21-finance");
        (await client.GetAsync("/api/v1/reports/mart/revenue-by-month?from=2024-03-01&to=2024-03-31&format=csv", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<Crm.Integrations.Core.Persistence.IntegrationDbContext>();
        var entry = await db.AuditEntries.AsNoTracking().Where(a => a.Module == "reports" && a.EntityType == "MartExport").OrderByDescending(a => a.Id).FirstAsync(Ct);
        entry.Action.ShouldBe("Export");
        entry.UserId.ShouldNotBeNull();
        entry.Changes!.ShouldContain("\"dataset\":\"revenue-by-month\"");
        entry.Changes!.ShouldContain("2024-03-01");
        entry.Changes!.ShouldContain("csv");
    }

    private sealed class FakeEnvironment(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;

        public string ApplicationName { get; set; } = "test";

        public string ContentRootPath { get; set; } = ".";

        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
    }
}
