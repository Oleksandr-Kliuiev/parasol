using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

[Collection(AteraCollection.Name)]
public class AteraSyncTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Customers_and_contacts_are_read_and_linked_while_writes_stay_disabled()
    {
        var atera = factory.Atera;
        var admin = factory.ClientAs(CrmRoles.Admin);
        var marker = $"AT{Guid.NewGuid():N}"[..10];
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Kyst AS", orgNumber, status = "Customer" });
        var email = $"kari@{marker.ToLowerInvariant()}.no";
        (await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts",
            new { firstName = "Kari", lastName = marker, email, roles = Array.Empty<string>(), isPrimary = true })).EnsureSuccessStatusCode();

        atera.Given(Request.Create().WithPath("/api/v3/customers").UsingGet().WithParam("page", "1").WithHeader("X-API-KEY", "test-atera-key"))
            .RespondWith(JsonReply(new
            {
                items = new object[]
                {
                    new { CustomerID = 501, CustomerName = $"{marker} Kyst", BusinessNumber = $"NO {orgNumber} MVA", Domain = $"{marker.ToLowerInvariant()}.no", City = "Bergen", Country = "Norway" },
                    new { CustomerID = 502, CustomerName = $"{marker} Fjell AS" },
                },
                totalItemCount = 3, page = 1, itemsInPage = 2, totalPages = 2,
            }));
        atera.Given(Request.Create().WithPath("/api/v3/customers").UsingGet().WithParam("page", "2"))
            .RespondWith(JsonReply(new { items = new object[] { new { CustomerID = 503, CustomerName = $"{marker} Vidde" } }, totalItemCount = 3, page = 2, itemsInPage = 2, totalPages = 2 }));
        atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingGet().WithParam("page", "1"))
            .RespondWith(JsonReply(new
            {
                items = new object[] { new { EndUserID = 9001, CustomerID = 501, Firstname = "Kari", Lastname = marker, Email = email.ToUpperInvariant() } },
                totalItemCount = 1, page = 1, itemsInPage = 2, totalPages = 1,
            }));

        await factory.RunJobAsync<AteraCustomerSyncJob>(j => j.RunAsync(CancellationToken.None));
        await factory.RunJobAsync<AteraContactSyncJob>(j => j.RunAsync(CancellationToken.None));

        var links = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/integrations/links?entityType=Organization&entityId={organizationId}");
        links.EnumerateArray().ShouldHaveSingleItem().GetProperty("externalId").GetString().ShouldBe("501");

        var contactRecords = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/integrations/records?system=atera&type=Contact&state=Linked&search={marker}");
        contactRecords.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().GetProperty("link").GetProperty("entityName").GetString().ShouldBe($"Kari {marker}");

        var unmatched = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/integrations/records?system=atera&type=Customer&state=Unlinked&search={marker}");
        unmatched.GetProperty("items").GetArrayLength().ShouldBe(2);

        // A second full scan with identical data changes nothing.
        await factory.RunJobAsync<AteraCustomerSyncJob>(j => j.RunAsync(CancellationToken.None));
        var runs = await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/runs?system=atera");
        runs.EnumerateArray().First(r => r.GetProperty("job").GetString() == "atera-customers").GetProperty("message").GetString()!.ShouldStartWith("changed 0");

        var export = await admin.PostAsync($"/api/v1/integrations/atera/organizations/{organizationId}/export", null);
        export.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await export.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("INT_EXPORT_UNAVAILABLE");
        // Other tests push custom values with writes enabled explicitly; customer writes must never happen here.
        atera.LogEntries.ShouldNotContain(e => e.RequestMessage!.Method != "GET" && e.RequestMessage.Path.Contains("/customers", StringComparison.Ordinal));

        var capabilities = await factory.ClientAs(CrmRoles.Sales).GetFromJsonAsync<JsonElement>("/api/v1/integrations/capabilities");
        var ateraCapability = capabilities.EnumerateArray().Single(c => c.GetProperty("system").GetString() == "atera");
        ateraCapability.GetProperty("enabled").GetBoolean().ShouldBeTrue();
        ateraCapability.GetProperty("canCreateOrganization").GetBoolean().ShouldBeFalse();
        var status = await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/status");
        status.EnumerateArray().Single(c => c.GetProperty("system").GetString() == "atera").GetProperty("records").GetInt32().ShouldBeGreaterThanOrEqualTo(4);
    }

    [Fact]
    public async Task Sla_level_of_the_active_contract_is_written_to_the_atera_custom_field()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var atera = factory.Atera;
        var customerId = Random.Shared.Next(700_000, 799_999);
        var organizationId = await admin.CreateOrganizationAsync(TestData.Organization("Atera SLA Kunde AS"));
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new { system = "atera", externalType = "Customer", externalId = customerId.ToString(System.Globalization.CultureInfo.InvariantCulture), entityId = organizationId }))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var sla = await (await admin.PostAsJsonAsync("/api/v1/contracts/sla-policies", new
        {
            name = $"Platinum {Guid.NewGuid():N}", coverage = "Always24x7",
            p1 = new { responseMinutes = 15, resolutionMinutes = 120 }, p2 = new { responseMinutes = 30, resolutionMinutes = 240 },
            p3 = new { responseMinutes = 60, resolutionMinutes = 480 }, p4 = new { responseMinutes = 240, resolutionMinutes = 1440 },
            includedHoursPerMonth = 4m, afterHoursMultiplier = 2m, ateraValue = "Platinum",
        })).ReadJsonAsync();
        var contract = await (await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = "MSP", type = "Msp", startDate = "2026-01-01", autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30,
            slaPolicyId = sla.GetProperty("id").GetGuid(), invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync();
        (await admin.PostAsync($"/api/v1/contracts/{contract.GetProperty("id").GetGuid()}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var fieldPath = $"/api/v3/customvalues/customerfield/{customerId}/SLA";
        atera.Given(Request.Create().WithPath(fieldPath).UsingGet())
            .RespondWith(JsonReply(new[] { new { ItemId = customerId, FieldName = "SLA", ValueAsString = "Bronze" } }));
        atera.Given(Request.Create().WithPath(fieldPath).UsingPut()).RespondWith(WireMock.ResponseBuilders.Response.Create().WithStatusCode(200));

        await using var scope = factory.Services.CreateAsyncScope();
        var options = Options.Create(new AteraOptions { Enabled = true, ApiKey = "test-atera-key", WriteEnabled = true, SlaCustomFieldName = "SLA" });
        var handler = ActivatorUtilities.CreateInstance<AteraSetSlaHandler>(scope.ServiceProvider, options);
        var result = await handler.ExecuteAsync(
            new OutboundOperation { System = "atera", Operation = AteraTypes.SetSla, EntityType = EntityTypes.Organization, EntityId = organizationId, IdempotencyKey = "test" },
            TestContext.Current.CancellationToken);

        result.Message.ShouldBe($"Set SLA = Platinum for Atera customer {customerId}.");
        var put = atera.LogEntries.Last(e => e.RequestMessage!.Path == fieldPath && e.RequestMessage.Method == "PUT");
        JsonDocument.Parse(put.RequestMessage!.Body!).RootElement.GetProperty("Value").GetString().ShouldBe("Platinum");
    }
}
