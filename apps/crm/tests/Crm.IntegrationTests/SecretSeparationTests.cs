using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// crm-web runs without provider credentials (DEV-04-AC05, infra/modules/apps.bicep): a second instance of the application
/// with every PowerOffice, Atera and Partner Center secret removed plays crm-web, the suite's host plays crm-worker. In the
/// administration collection because it counts the requests the mock providers receive.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public class SecretSeparationTests(CrmWebFactory factory)
{
    private static readonly string[] ProviderSecrets =
    [
        "Integrations:PowerOffice:ApplicationKey",
        "Integrations:PowerOffice:ClientKey",
        "Integrations:PowerOffice:SubscriptionKey",
        "Integrations:Atera:ApiKey",
        "Integrations:PartnerCenter:ClientSecret",
        "Integrations:PartnerCenter:RefreshToken",
    ];

    private static HttpClient ClientAs(WebApplicationFactory<Program> host, string role, string userKey)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, userKey);
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    private int ProviderRequests() => factory.PowerOffice.LogEntries.Count + factory.Atera.LogEntries.Count + factory.PartnerCenter.LogEntries.Count;

    [Fact]
    public async Task AC05_crm_web_without_provider_secrets_serves_integrations_and_billing_and_the_worker_alone_calls_the_providers()
    {
        await using var web = factory.WithWebHostBuilder(builder =>
        {
            foreach (var secret in ProviderSecrets)
            {
                builder.UseSetting(secret, string.Empty);
            }
        });
        var admin = ClientAs(web, CrmRoles.Admin, "secrets-admin");
        var finance = ClientAs(web, CrmRoles.Finance, "secrets-finance");
        var requestsBefore = ProviderRequests();

        // The switches are what the web host goes by: the integrations show as connected and can take work for the worker.
        var status = (await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/status")).EnumerateArray().ToList();
        status.Single(s => s.GetProperty("system").GetString() == "poweroffice").GetProperty("enabled").GetBoolean().ShouldBeTrue();
        status.Single(s => s.GetProperty("system").GetString() == "atera").GetProperty("enabled").GetBoolean().ShouldBeTrue();
        status.Single(s => s.GetProperty("system").GetString() == "partnercenter").GetProperty("enabled").GetBoolean().ShouldBeTrue();
        var capabilities = (await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/capabilities")).EnumerateArray().ToList();
        capabilities.Single(c => c.GetProperty("system").GetString() == "poweroffice").GetProperty("canCreateOrganization").GetBoolean().ShouldBeTrue();

        // Billing readiness is answered from stored links: a customer that is not linked is flagged before approval.
        var marker = $"S{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Hemmelig AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("SEC"), "Managed services", 900m, 450m));
        var period = new DateOnly(2039, 3, 1);
        var contractId = (await (await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = period, endDate = period.AddMonths(1).AddDays(-1), autoRenew = false,
            renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"/api/v1/contracts/{contractId}/lines", new { productId, quantityModel = "Fixed", quantity = 1m, unitPrice = 900m, validFrom = period }))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"/api/v1/contracts/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var created = await finance.PostAsJsonAsync("/api/v1/billing/runs", new { year = period.Year, month = period.Month, notes = marker });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var basisId = (await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/runs/{runId}/bases?search={marker}")).EnumerateArray().Single().GetProperty("id").GetGuid();
        var basis = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/bases/{basisId}");
        basis.GetProperty("anomalies").EnumerateArray().ShouldContain(a => a.GetProperty("code").GetString() == "BIL_CUSTOMER_NOT_LINKED");

        // The web host holds no credentials: its adapters refuse to call out, and nothing it did reached a provider.
        await using (var scope = web.Services.CreateAsyncScope())
        {
            foreach (var adapter in scope.ServiceProvider.GetServices<IIntegrationAdapter>())
            {
                var result = await adapter.TestConnectionAsync(CancellationToken.None);
                result.Success.ShouldBeFalse(adapter.System);
                result.Message.ShouldContain("not configured on this instance", Case.Insensitive, adapter.System);
            }
        }

        ProviderRequests().ShouldBe(requestsBefore);

        // The connection test is queued by the web host and answered by the worker, which calls PowerOffice.
        BillingApiTests.StubToken(factory);
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/Products").UsingGet()).AtPriority(20).RespondWith(JsonReply(Array.Empty<object>()));
        var queued = await admin.PostAsync("/api/v1/integrations/poweroffice/test", null);
        queued.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        var test = await queued.ReadJsonAsync();
        test.GetProperty("status").GetString().ShouldBe("Running");
        var testId = test.GetProperty("id").GetGuid();
        queued.Headers.Location!.ToString().ShouldBe($"/api/v1/integrations/poweroffice/test/{testId}");
        ProviderRequests().ShouldBe(requestsBefore);

        JsonElement answer = default;
        await factory.EventuallyAsync(async () =>
        {
            answer = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/integrations/poweroffice/test/{testId}");
            return answer.GetProperty("status").GetString() != "Running";
        });
        answer.GetProperty("status").GetString().ShouldBe("Succeeded");
        answer.GetProperty("success").GetBoolean().ShouldBeTrue();
        answer.GetProperty("message").GetString()!.ShouldStartWith("Connected to PowerOffice");
        ProviderRequests().ShouldBeGreaterThan(requestsBefore);

        // Only the manager of integrations may ask, and only about a system that exists.
        (await ClientAs(web, CrmRoles.Sales, "secrets-sales").PostAsync("/api/v1/integrations/poweroffice/test", null)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await admin.PostAsync("/api/v1/integrations/nowhere/test", null)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await admin.GetAsync($"/api/v1/integrations/atera/test/{testId}")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }
}
