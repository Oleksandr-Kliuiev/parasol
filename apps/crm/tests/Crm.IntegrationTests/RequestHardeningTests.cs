using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using ClosedXML.Excel;
using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using FluentValidation;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>Guards on how requests are read and validated (ASVS V2, V1). The endpoint list comes from the running application.</summary>
public class RequestHardeningTests(CrmWebFactory factory)
{
    /// <summary>
    /// JSON-body endpoints that deliberately have no <c>.Validate&lt;T&gt;()</c>: every other body endpoint needs a validator,
    /// because the filter silently does nothing for a type without one (F-G1-07). Each entry says why it is safe.
    /// </summary>
    private static readonly Dictionary<string, string> WithoutValidator = new(StringComparer.Ordinal)
    {
        ["POST /api/v1/contracts/{id:guid}/end"] = "one date; the contract domain checks it against the term",
        ["POST /api/v1/contracts/{id:guid}/lines/{lineId:guid}/end"] = "one date; the contract domain checks it against the line",
        ["POST /api/v1/contracts/{id:guid}/notice"] = "two dates; the contract domain checks their order",
        ["POST /api/v1/custom-fields/definitions/{id:guid}/active"] = "one boolean",
        ["POST /api/v1/customers/organizations/{id:guid}/merge"] = "one id; the merge service resolves it",
        ["POST /api/v1/customers/organizations/duplicates/dismissals"] = "two ids",
        ["POST /api/v1/integrations/monitoring/outbound/retry"] = "reason 10-500, 1-100 messages and the confirmed count are checked in the handler",
        ["POST /api/v1/integrations/outbound/{id:guid}/retry"] = "reason 10-500 is checked in the handler",
        ["POST /api/v1/integrations/outbox/replay"] = "reason 10-500, at most 100 messages and the confirmed count are checked in the handler",
        ["POST /api/v1/operations/restore/reconcile"] = "a timestamp and a boolean",
        ["POST /api/v1/parasol/customers/{customerId:guid}/observations/{observationId}/task"] = "an employee id, a due date and the preview hash; the service refuses an empty id, a date outside 2000-2100 or a hash that is not 64 lower-case hex digits (PARASOL_TASK_INVALID)",
        ["POST /api/v1/projects/{id:guid}/phases/{phaseId:guid}/status"] = "an enum; the project domain refuses a transition it does not know",
        ["POST /api/v1/projects/{id:guid}/status"] = "an enum; the project domain refuses a transition it does not know",
        ["PUT /api/v1/activities/{id:guid}/ticket"] = "two ids; the ticket service checks the customer and that the ticket belongs to it",
        ["PUT /api/v1/customers/organizations/{id:guid}/parent"] = "an id and a boolean; the group rules are checked in the service",
        ["PUT /api/v1/identity/me/preferences"] = "the language is checked against the supported list in the handler",
        ["PUT /api/v1/identity/technicians/{id:guid}"] = "one id",
        ["PUT /api/v1/integrations/monitoring/triage"] = "key 256, status list and comment 2000 are checked in the handler",
        ["PUT /api/v1/operations/maintenance"] = "reason 10-500 is checked in the handler and the reference is clipped to 100",
    };

    [Fact]
    public void Every_endpoint_with_a_json_body_has_a_validator_or_is_listed_with_a_reason()
    {
        var bodyEndpoints = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => e.RoutePattern.RawText?.StartsWith("/api", StringComparison.Ordinal) == true)
            .Select(e => new
            {
                Key = $"{string.Join(",", e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [])} {e.RoutePattern.RawText}",
                Type = e.Metadata.GetMetadata<IAcceptsMetadata>()?.RequestType,
                // .Validate<T>() declares the 400 validation problem; ValidationFilter<T> then needs a registered IValidator<T>.
                Wired = e.Metadata.OfType<IProducesResponseTypeMetadata>().Any(p => p.Type == typeof(HttpValidationProblemDetails)),
            })
            .Where(e => e.Type is not null)
            .ToList();
        bodyEndpoints.Count.ShouldBeGreaterThan(80);

        var problems = new List<string>();
        foreach (var endpoint in bodyEndpoints)
        {
            var hasValidator = factory.Services.GetService(typeof(IValidator<>).MakeGenericType(endpoint.Type!)) is not null;
            var allowed = WithoutValidator.ContainsKey(endpoint.Key);
            if (endpoint.Wired && !hasValidator)
            {
                problems.Add($"{endpoint.Key}: .Validate<{endpoint.Type!.Name}>() is chained but no validator is registered, so it does nothing");
            }
            else if (!endpoint.Wired && !allowed)
            {
                problems.Add($"{endpoint.Key}: {endpoint.Type!.Name} has no .Validate<T>(); add a validator or list the endpoint with a reason");
            }
            else if (endpoint.Wired && allowed)
            {
                problems.Add($"{endpoint.Key}: validated now, remove it from the allowlist");
            }
        }

        foreach (var stale in WithoutValidator.Keys.Where(k => bodyEndpoints.All(e => e.Key != k)))
        {
            problems.Add($"{stale}: listed without a validator but no such endpoint exists");
        }

        problems.ShouldBeEmpty();
    }

    [Fact]
    public void Every_endpoint_that_exports_data_is_under_the_export_rate_limit()
    {
        // The limiter is per replica (fixed window, up to four replicas), so the effective ceiling is a multiple of the setting;
        // that is documented, not changed here (F-G1-14).
        var exporting = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => e.Metadata.GetMetadata<ExportsDataMetadata>() is not null)
            .ToList();
        exporting.Count.ShouldBeGreaterThanOrEqualTo(7);

        // Export: files and bulk reads (10 per hour). Migration: the pages of a migration run's report, one request per page of a
        // one-off job (60 per hour); a file-export limit would make a 5 000-row run unreadable.
        exporting
            .Where(e => e.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName is not (RateLimitPolicies.Export or RateLimitPolicies.Migration))
            .Select(e => e.RoutePattern.RawText)
            .ShouldBeEmpty("an endpoint marked ExportsData() also needs .RequireRateLimiting(Export), or Migration for the run reports");
    }

    // ---------- F-G1-06: free text longer than its column is a 400, never a 500 ----------

    [Fact]
    public async Task A_reason_longer_than_its_column_is_refused_with_a_validation_problem_before_anything_is_looked_up()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "hardening-sales");
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "hardening-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "hardening-finance");
        var unknown = Guid.NewGuid();
        var tooLong = new string('x', 600);
        var fits = new string('x', 200);

        async Task ShouldBeValidationAsync(Task<HttpResponseMessage> request, string field)
        {
            var response = await request;
            response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
            var body = await response.ReadJsonAsync();
            body.GetProperty("code").GetString().ShouldBe("VALIDATION_FAILED");
            body.GetProperty("errors").EnumerateObject().Select(e => e.Name.ToLowerInvariant()).ShouldContain(field.ToLowerInvariant());
        }

        await ShouldBeValidationAsync(sales.PostAsJsonAsync($"/api/v1/sales/leads/{unknown}/disqualify", new { reason = new string('x', 257) }), "reason");
        await ShouldBeValidationAsync(sales.PostAsJsonAsync($"/api/v1/sales/opportunities/{unknown}/stage", new { stageId = Guid.NewGuid(), lostReason = new string('x', 257) }), "lostReason");
        await ShouldBeValidationAsync(sales.PostAsJsonAsync($"/api/v1/sales/quotes/{unknown}/decline", new { reason = new string('x', 513) }), "reason");
        await ShouldBeValidationAsync(admin.PostAsJsonAsync("/api/v1/integrations/atera/pause", new { paused = true, reason = new string('x', 513) }), "reason");
        await ShouldBeValidationAsync(finance.PostAsJsonAsync("/api/v1/time/periods/2020/1/reopen", new { reason = new string('x', 513) }), "reason");
        await ShouldBeValidationAsync(sales.PostAsJsonAsync($"/api/v1/sales/leads/{unknown}/convert", new { createOpportunity = true, opportunityName = tooLong, termMonths = 5000 }), "opportunityName");

        // A reason that fits gets past validation to the lookup, which does not find the record.
        (await sales.PostAsJsonAsync($"/api/v1/sales/leads/{unknown}/disqualify", new { reason = fits })).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await admin.PostAsJsonAsync("/api/v1/integrations/atera/pause", new { paused = false, reason = (string?)null })).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Lists of ids and key/value bodies are bounded as well.
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "hardening-lead");
        (await lead.PostAsJsonAsync("/api/v1/time/approve", new { entryIds = Enumerable.Range(0, 1001).Select(_ => Guid.NewGuid()) })).StatusCode
            .ShouldBe(HttpStatusCode.BadRequest);
        (await lead.PostAsync("/api/v1/time/approve", JsonContent.Create(new { }))).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await admin.PutAsJsonAsync($"/api/v1/custom-fields/Organization/{unknown}", new { values = new Dictionary<string, string?> { ["k"] = new string('x', 1001) } }))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_truncation_error_that_reaches_the_database_is_answered_as_a_400_not_a_500()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        db.IntegrationSwitches.Add(new IntegrationSwitch { System = new string('s', 200) });
        var failure = await Should.ThrowAsync<DbUpdateException>(() => db.SaveChangesAsync());

        var context = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
        context.Response.Body = new MemoryStream();
        var handler = new Crm.Web.Http.PersistenceExceptionHandler(scope.ServiceProvider.GetRequiredService<IProblemDetailsService>());
        (await handler.TryHandleAsync(context, failure, CancellationToken.None)).ShouldBeTrue();

        context.Response.StatusCode.ShouldBe(StatusCodes.Status400BadRequest);
        context.Response.Body.Position = 0;
        var problem = await JsonDocument.ParseAsync(context.Response.Body);
        problem.RootElement.GetProperty("code").GetString().ShouldBe("VALIDATION_FAILED");
        problem.RootElement.ToString().ShouldNotContain("IntegrationSwitches", Case.Insensitive);
    }

    // ---------- F-G1-08 and F-G1-05: patterns end with \z, and a website is an http(s) address ----------

    [Fact]
    public async Task A_trailing_line_break_does_not_pass_a_sku_a_price_list_code_or_a_domain()
    {
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "hardening-finance");
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "hardening-sales");
        var sku = CatalogApiTests.Sku("NL");

        (await finance.PostAsJsonAsync("/api/v1/catalog/products", CatalogApiTests.Product(sku + "\n"))).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await finance.PostAsJsonAsync("/api/v1/catalog/products", CatalogApiTests.Product(sku))).StatusCode.ShouldBe(HttpStatusCode.Created);
        (await finance.PostAsJsonAsync("/api/v1/catalog/categories", new { code = "NL" + Guid.NewGuid().ToString("N")[..8] + "\n", name = "x", licenseMarkupPct = 0m, isDefault = false }))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await sales.PostAsJsonAsync("/api/v1/customers/organizations", new { name = "Domain AS", status = "Customer", domains = new[] { "havbris.no\n" } }))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_website_must_be_an_http_or_https_address()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "hardening-sales");
        foreach (var website in new[] { "javascript:alert(1)", "javascript://x%0Aalert(1)", "data:text/html,<script>1</script>", "vbscript:x", "ftp://havbris.no" })
        {
            var response = await sales.PostAsJsonAsync("/api/v1/customers/organizations", new { name = "Nettside AS", status = "Customer", website });
            response.StatusCode.ShouldBe(HttpStatusCode.BadRequest, website);
            (await response.ReadJsonAsync()).GetProperty("errors").EnumerateObject().Select(e => e.Name.ToLowerInvariant()).ShouldContain("website");
        }

        var created = await sales.PostAsJsonAsync("/api/v1/customers/organizations", new { name = $"Nettside {Guid.NewGuid():N}"[..24], status = "Customer", website = "havbris.no" });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        (await created.ReadJsonAsync()).GetProperty("website").GetString().ShouldBe("https://havbris.no");
    }

    // ---------- F-G1-10: exports ----------

    [Fact]
    public async Task A_cell_that_starts_a_formula_or_holds_a_line_break_is_neutralized_in_the_csv_and_the_workbook()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "hardening-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "hardening-finance");
        var marker = $"X{Guid.NewGuid():N}"[..10];
        var names = new[] { $"=HYPERLINK(\"http://evil.example\",\"{marker}\")", $"+1+1 {marker}", $"-2 {marker}", $"@SUM(1) {marker}", $"multi\nline {marker}", $"semi;colon {marker}" };
        foreach (var name in names)
        {
            await admin.CreateOrganizationAsync(new { name, status = "Customer" });
        }

        var csv = await (await finance.GetAsync("/api/v1/reports/mart/organizations?format=csv")).Content.ReadAsStringAsync();
        // No cell begins with a formula character (a quoted cell begins with the quote, an apostrophe protects the rest).
        var ours = csv.Split("\r\n", StringSplitOptions.None).Where(l => l.Contains(marker, StringComparison.Ordinal)).ToList();
        ours.ShouldNotBeEmpty();
        csv.ShouldContain("\"'=HYPERLINK(");
        csv.ShouldContain($"'+1+1 {marker}");
        csv.ShouldContain($"'-2 {marker}");
        csv.ShouldContain($"'@SUM(1) {marker}");
        csv.ShouldContain($"\"multi\nline {marker}\"", customMessage: "a line break stays inside one quoted cell");
        csv.ShouldContain($"\"semi;colon {marker}\"");
        ours.Where(l => l.Length > 0 && !l.StartsWith("line ", StringComparison.Ordinal)).ShouldAllBe(l => !"=+-@\t".Contains(l[0]));

        var sheet = await factory.ClientAs(CrmRoles.Admin, userKey: $"hardening-{Guid.NewGuid():N}").GetAsync($"/api/v1/customers/organizations/export?search={marker}");
        sheet.StatusCode.ShouldBe(HttpStatusCode.OK);
        using var workbook = new XLWorkbook(await sheet.Content.ReadAsStreamAsync());
        var cells = workbook.Worksheet(1).Column(1).CellsUsed().Skip(1).ToList();
        cells.Count.ShouldBe(names.Length);
        foreach (var cell in cells)
        {
            cell.HasFormula.ShouldBeFalse(cell.GetString());
            cell.DataType.ShouldBe(XLDataType.Text);
            names.ShouldContain(cell.GetString());
            if ("=+-@".Contains(cell.GetString()[0]))
            {
                cell.Style.IncludeQuotePrefix.ShouldBeTrue(cell.GetString());
            }
        }
    }

    // ---------- F-G2-05, F-G5-08: import bodies ----------

    [Fact]
    public async Task An_import_takes_only_text_up_to_the_size_limit()
    {
        // The export and migration limiters count per user, so every request here comes from a user of its own.
        HttpClient Admin() => factory.ClientAs(CrmRoles.Admin, userKey: $"hardening-{Guid.NewGuid():N}");
        var csv = "customerId;subscriptionId;offerId;quantity\nA;B;C;1\n";
        string[] urls = ["/api/v1/licensing/import?dryRun=true", "/api/v1/licensing/ms-billing/import?dryRun=true", "/api/v1/customers/organizations/import?dryRun=true", "/api/v1/customers/organizations/import/reconcile"];

        foreach (var url in urls)
        {
            var json = await Admin().PostAsync(url, new StringContent("{}", Encoding.UTF8, "application/json"));
            json.StatusCode.ShouldBe(HttpStatusCode.UnsupportedMediaType, url);
            (await json.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("UNSUPPORTED_MEDIA_TYPE");
            (await Admin().PostAsync(url, new ByteArrayContent(Encoding.UTF8.GetBytes(csv)))).StatusCode.ShouldBe(HttpStatusCode.UnsupportedMediaType, url + " without a content type");
            (await Admin().PostAsync(url, new StringContent(csv, Encoding.UTF8, "text/plain"))).StatusCode.ShouldNotBe(HttpStatusCode.UnsupportedMediaType, url);
        }

        // The default limit is 10 MB: a larger declared length is refused without reading the body.
        var big = new string('a', 11 * 1024 * 1024);
        foreach (var url in urls)
        {
            var response = await Admin().PostAsync(url, new StringContent(big, Encoding.UTF8, "text/csv"));
            response.StatusCode.ShouldBe(HttpStatusCode.RequestEntityTooLarge, url);
            (await response.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("PAYLOAD_TOO_LARGE");
        }

        // The limit is a setting; a body without a declared length is counted while it is read.
        using var small = factory.WithWebHostBuilder(builder => builder.UseSetting("Imports:MaxRequestBytes", "2000"));
        var client = small.CreateClient(new() { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, $"hardening-{Guid.NewGuid():N}");
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        var chunked = new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes(new string('b', 5000))));
        chunked.Headers.ContentType = new("text/csv");
        (await client.PostAsync("/api/v1/licensing/import?dryRun=true", chunked)).StatusCode.ShouldBe(HttpStatusCode.RequestEntityTooLarge);
        (await client.PostAsync("/api/v1/licensing/import?dryRun=true", new StringContent(csv, Encoding.UTF8, "text/csv"))).StatusCode.ShouldNotBe(HttpStatusCode.RequestEntityTooLarge);
    }

    [Fact]
    public async Task A_distributor_file_with_more_rows_than_the_cap_is_refused()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "hardening-admin");
        var csv = new StringBuilder("customerId;subscriptionId;offerId;quantity\n");
        for (var i = 0; i < Crm.SharedKernel.Text.CsvTable.MaxImportRows + 1; i++)
        {
            csv.Append("A;").Append(i.ToString(CultureInfo.InvariantCulture)).Append(";C;1\n");
        }

        var response = await admin.PostAsync("/api/v1/licensing/import?dryRun=true", new StringContent(csv.ToString(), Encoding.UTF8, "text/csv"));
        var text = await response.Content.ReadAsStringAsync();
        text.ShouldContain("more than");
    }

    // ---------- F-G3-10 ----------

    [Fact]
    public async Task Acknowledging_a_reminder_needs_a_write_right()
    {
        var readOnly = factory.ClientAs(CrmRoles.ReadOnly, userKey: "hardening-readonly");
        (await readOnly.PostAsync($"/api/v1/contracts/reminders/{Guid.NewGuid()}/acknowledge", null)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "hardening-sales");
        (await sales.PostAsync($"/api/v1/contracts/reminders/{Guid.NewGuid()}/acknowledge", null)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    // ---------- F-G3-01 class: the price list item ----------

    [Fact]
    public async Task A_caller_who_cannot_see_the_cost_cannot_overwrite_it_on_a_price_list_item()
    {
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "hardening-finance");
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("HC")));
        var category = (await finance.GetFromJsonAsync<JsonElement>("/api/v1/catalog/categories")).EnumerateArray().First();
        var listId = (await (await finance.PostAsJsonAsync("/api/v1/catalog/price-lists", new
        {
            name = $"Cost {Guid.NewGuid():N}"[..20], customerCategory = category.GetProperty("code").GetString(),
            validFrom = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd"), validTo = (string?)null, currency = "NOK",
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        var url = $"/api/v1/catalog/price-lists/{listId}/items/{productId}";
        (await finance.PutAsJsonAsync(url, new { unitPrice = 500m, unitCost = 321m })).StatusCode.ShouldBe(HttpStatusCode.OK);

        // The same Finance token on a host whose caller lacks finance.cost.read, as a role without it would be (none holds
        // catalog.write today; this pins the handler, not the matrix).
        using var restricted = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            var original = services.Single(d => d.ServiceType == typeof(ICurrentUser));
            services.Replace(ServiceDescriptor.Scoped<ICurrentUser>(sp =>
                new WithoutPermissions((ICurrentUser)ActivatorUtilities.CreateInstance(sp, original.ImplementationType!), Permissions.FinanceCostRead)));
        }));
        var client = restricted.CreateClient(new() { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Finance);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "hardening-finance");
        client.DefaultRequestHeaders.Add("X-CSRF", "1");

        (await client.PutAsJsonAsync(url, new { unitPrice = 510m })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await client.PutAsJsonAsync(url, new { partnerPrice = 10m, partnerCurrency = "USD", exchangeRate = 10m })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        var item = (await finance.GetFromJsonAsync<JsonElement>($"/api/v1/catalog/price-lists/{listId}")).GetProperty("items").EnumerateArray().Single();
        item.GetProperty("unitPrice").GetDecimal().ShouldBe(510m);
        item.GetProperty("unitCost").GetDecimal().ShouldBe(321m);
    }

    private sealed class WithoutPermissions(ICurrentUser inner, params string[] hidden) : ICurrentUser
    {
        public Guid? UserId => inner.UserId;
        public string DisplayName => inner.DisplayName;
        public bool IsAuthenticated => inner.IsAuthenticated;
        public bool HasPermission(string permission) => !hidden.Contains(permission) && inner.HasPermission(permission);
    }
}
