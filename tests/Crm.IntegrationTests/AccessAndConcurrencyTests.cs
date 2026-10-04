using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Authorization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// Negative rights for every endpoint and the guarantees that must hold under parallel requests. The endpoint list is read
/// from the running application, so a new endpoint is covered without editing this file.
/// </summary>
public partial class AccessAndConcurrencyTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";

    [GeneratedRegex(@"\{(?<name>\*{0,2}[^}:?]+)(?<constraint>:[^}?]+)?\??\}")]
    private static partial Regex RouteParameter();

    [Fact]
    public async Task Every_endpoint_refuses_every_role_that_lacks_its_permission()
    {
        var clients = CrmRoles.All.ToDictionary(role => role, role => factory.ClientAs(role, userKey: $"matrix-{role}"));
        var endpoints = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(e => e.RoutePattern.RawText?.StartsWith("/api", StringComparison.Ordinal) == true)
            .Select(e => new
            {
                Pattern = e.RoutePattern.RawText!,
                Methods = e.Metadata.GetMetadata<Microsoft.AspNetCore.Routing.HttpMethodMetadata>()?.HttpMethods ?? [],
                // Each policy is one requirement; within a policy any listed permission is enough (PermissionRequirement).
                Policies = e.Metadata.OfType<IAuthorizeData>()
                    .Select(a => a.Policy)
                    .Where(p => p?.StartsWith("perm:", StringComparison.Ordinal) == true)
                    .Select(p => p!["perm:".Length..].Split('|'))
                    .ToList(),
            })
            .Where(e => e.Policies.Count > 0)
            .ToList();
        endpoints.Count.ShouldBeGreaterThan(100);

        var checkedRequests = 0;
        var violations = new List<string>();
        foreach (var endpoint in endpoints)
        {
            var url = RouteParameter().Replace(endpoint.Pattern, match =>
                match.Groups["constraint"].Value.Contains("guid", StringComparison.Ordinal) ? Guid.NewGuid().ToString()
                : match.Groups["constraint"].Value.Contains("int", StringComparison.Ordinal) ? "1"
                : "x");
            foreach (var role in CrmRoles.All)
            {
                var held = Permissions.ForRoles([role]);
                if (endpoint.Policies.All(alternatives => alternatives.Any(held.Contains)))
                {
                    continue;
                }

                foreach (var method in endpoint.Methods)
                {
                    using var request = new HttpRequestMessage(new HttpMethod(method), url);
                    if (method is "POST" or "PUT" or "PATCH")
                    {
                        request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
                    }

                    using var response = await clients[role].SendAsync(request);
                    checkedRequests++;
                    if (response.StatusCode != HttpStatusCode.Forbidden)
                    {
                        violations.Add($"{method} {endpoint.Pattern} as {role}: {(int)response.StatusCode}");
                    }
                }
            }
        }

        TestContext.Current.TestOutputHelper?.WriteLine($"{checkedRequests} refused requests checked on {endpoints.Count} endpoints.");
        checkedRequests.ShouldBeGreaterThan(100);
        violations.ShouldBeEmpty();
    }

    [Fact]
    public async Task Parallel_requests_for_the_same_period_open_exactly_one_run()
    {
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "concurrency-finance");
        var period = new DateOnly(2029, 6, 1);

        var responses = await Task.WhenAll(Enumerable.Range(0, 10).Select(i =>
            finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = $"parallel {i}" })));

        // BR-BIL-01: one open run per period, whatever the timing; no request may end in a server error.
        responses.Count(r => r.StatusCode == HttpStatusCode.Created).ShouldBe(1);
        responses.Where(r => r.StatusCode != HttpStatusCode.Created).Select(r => r.StatusCode).Distinct()
            .ShouldBe([HttpStatusCode.Conflict]);
        var runs = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs?year={period.Year}&limit=200");
        runs.GetProperty("items").EnumerateArray().Count(r => r.GetProperty("periodStart").GetString() == "2029-06-01").ShouldBe(1);
    }

    [Fact]
    public async Task A_basis_change_needs_the_current_etag()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "concurrency-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "concurrency-finance");
        var period = new DateOnly(2029, 7, 1);
        var marker = $"E{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Samtidig AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("ETAG"), "Drift", 2_000m, 1_000m));
        var contractId = (await (await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = period, endDate = period.AddMonths(1).AddDays(-1),
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance",
            indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"/api/v1/contracts/{contractId}/lines", new
        {
            productId, quantityModel = "Fixed", quantity = 1m, unitPrice = 2_000m, validFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"/api/v1/contracts/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var runId = (await (await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month })).ReadJsonAsync())
            .GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var basisId = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={marker}"))
            .EnumerateArray().Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == organizationId)
            .GetProperty("id").GetGuid();
        var line = new { description = "Ekstra", quantity = 1m, unitPrice = 100m };

        // Without If-Match the change is refused before anything is read or written (428).
        (await finance.PostAsJsonAsync($"{Billing}/bases/{basisId}/lines", line)).StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired);

        // Two tabs read the same version; the first change wins, the second gets 412 and changes nothing.
        var etag = (await finance.GetAsync($"{Billing}/bases/{basisId}")).Headers.ETag!.Tag;
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", line, etag)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", line, etag)).StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}")).GetProperty("totalExVat").GetDecimal().ShouldBe(2_100m);
    }
}
