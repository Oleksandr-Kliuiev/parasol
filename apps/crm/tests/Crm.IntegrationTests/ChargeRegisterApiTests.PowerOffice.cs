using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.Extensions.DependencyInjection;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Types;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>The send of a sales order when the answer is lost, and the product code it carries (DEV-19).</summary>
public partial class ChargeRegisterApiTests
{
    /// <summary>The unknown outcome of an earlier send stays unknown for a while; tests that want the end of that wait age it.</summary>
    private async Task AgeTheSendAsync(params Guid[] basisIds)
    {
        foreach (var basisId in basisIds)
        {
            await factory.AdminSqlWithoutBillingTriggersAsync($"""
                UPDATE billing.BillingBases SET SendStartedAt = DATEADD(MINUTE, -30, SYSDATETIMEOFFSET()) WHERE Id = {basisId} AND SendStartedAt IS NOT NULL;
                """);
        }
    }

    [Fact]
    public async Task DEV19_AC01_an_order_created_just_before_the_answer_was_lost_is_found_by_the_next_attempt_and_never_posted_twice()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2036, 1, 1);
        var customer = await CustomerAsync(admin, finance, "A", period, period.AddMonths(1).AddDays(-1), 3_100m);
        var runId = await RunAsync(finance, period, customer.Marker);
        var basisId = (await BasisOfAsync(finance, runId, customer))!.Value.GetProperty("id").GetGuid();
        var reference = await ReferenceAsync(basisId);

        // PowerOffice creates the order and the connection drops before the answer arrives. From then on the order is searchable.
        var scenario = $"lost-answer-{customer.Marker}";
        var po = factory.PowerOffice;
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost().WithBody(new WildcardMatcher($"*{customer.OrganizationId:N}*"))).AtPriority(1)
            .InScenario(scenario).WillSetStateTo("Created")
            .RespondWith(Response.Create().WithFault(FaultType.EMPTY_RESPONSE));
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost().WithBody(new WildcardMatcher($"*{customer.OrganizationId:N}*"))).AtPriority(1)
            .InScenario(scenario).WhenStateIs("Created")
            .RespondWith(Response.Create().WithStatusCode(409).WithBody("a second order would be created"));
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet().WithParam("externalImportReferences", reference)).AtPriority(1)
            .InScenario(scenario)
            .RespondWith(Response.Create().WithStatusCode(204));
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet().WithParam("externalImportReferences", reference)).AtPriority(1)
            .InScenario(scenario).WhenStateIs("Created")
            .RespondWith(JsonReply(new[] { new { Id = 36_001, OrderNo = 36_001, CustomerId = 1, ExternalImportReference = reference, Status = "Draft" } }));

        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        await factory.ProcessEventsAndOutboundAsync();

        // The first attempt got no answer: the send is marked, nothing is exported, and one order was posted.
        var (afterLoss, _) = await BasisAsync(finance, basisId);
        afterLoss.GetProperty("status").GetString().ShouldBe("Approved");
        afterLoss.GetProperty("sendStarted").GetBoolean().ShouldBeTrue();
        OrdersPosted(customer).ShouldBe(1);

        // The next attempt looks the order up by its reference before anything else and adopts it.
        await RunPendingOperationsAsync(basisId);

        var (exported, _) = await BasisAsync(finance, basisId);
        exported.GetProperty("status").GetString().ShouldBe("Exported");
        exported.GetProperty("orderNo").GetString().ShouldBe("36001");
        OrdersPosted(customer).ShouldBe(1);
    }

    [Fact]
    public async Task DEV19_AC01_an_order_that_cannot_be_found_is_looked_for_again_for_ten_minutes_before_a_person_is_asked()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2036, 2, 1);
        var customer = await CustomerAsync(admin, finance, "G", period, period.AddMonths(1).AddDays(-1), 3_200m);
        var runId = await RunAsync(finance, period, customer.Marker);
        var basisId = (await BasisOfAsync(finance, runId, customer))!.Value.GetProperty("id").GetGuid();
        var reference = await ReferenceAsync(basisId);
        StubOrders(customer, 0, status: 500);
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet().WithParam("externalImportReferences", reference)).AtPriority(1)
            .RespondWith(Response.Create().WithStatusCode(204));

        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        await factory.ProcessEventsAndOutboundAsync();
        (await BasisAsync(finance, basisId)).Basis.GetProperty("sendStarted").GetBoolean().ShouldBeTrue();

        // Within the grace period the lookup finds nothing, the attempt fails like any other and is repeated later: no hold, no second post.
        await RunPendingOperationsAsync(basisId);
        var (waiting, _) = await BasisAsync(finance, basisId);
        waiting.GetProperty("status").GetString().ShouldBe("Approved");
        (await OperationAsync(basisId)).Status.ShouldBe(OutboundStatus.Pending);
        OrdersPosted(customer).ShouldBe(1);

        // Ten minutes after the send, still nothing found: now the basis is handed to a person, as before.
        await AgeTheSendAsync(basisId);
        await RunPendingOperationsAsync(basisId);
        (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("ReconciliationRequired");
        OrdersPosted(customer).ShouldBe(1);
    }

    [Fact]
    public async Task DEV19_AC04_the_order_line_carries_the_product_code_of_the_linked_poweroffice_product_not_the_crm_sku()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2036, 3, 1);
        var customer = await CustomerAsync(admin, finance, "C", period, period.AddMonths(1).AddDays(-1), 3_300m);
        StubOrders(customer, 36_301);

        // The product in Go keeps its code while the CRM SKU is renamed: the stored record is what the order follows.
        var links = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/integrations/links?entityType=Product&entityId={customer.ProductId}");
        var externalId = links.EnumerateArray().Single().GetProperty("externalId").GetString()!;
        var goCode = $"GO-{customer.Marker}";
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ExternalRecordStore>().UpsertAsync(
                PowerOfficeMapping.ToRecord(new PoProduct(long.Parse(externalId, CultureInfo.InvariantCulture), goCode, "Managed services", null, null, null, 3_300m, null, false,
                    DateTimeOffset.Parse("2036-02-01T10:00:00+00:00"))), CancellationToken.None);
        }

        var runId = await RunAsync(finance, period, customer.Marker);
        await ApproveExportAndCloseAsync(finance, runId);

        var body = factory.PowerOffice.LogEntries
            .Single(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == "/v2/SalesOrders" &&
                         e.RequestMessage.Body!.Contains(customer.OrganizationId.ToString("N"), StringComparison.Ordinal)).RequestMessage!.Body!;
        body.ShouldContain($"\"ProductCode\":\"{goCode}\"");
    }
}
