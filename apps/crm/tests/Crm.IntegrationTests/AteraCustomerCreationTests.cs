using System.Globalization;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Actions;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.CustomerCreationCalls;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M43 on SQL Server: the "Connect services" wizard creates the customer in Atera (<c>customer.create</c>) on the action path. Atera keeps
/// no reference of ours, so the organization number is our key; the request is journaled with the kind the mapping screen's export
/// uses, so an export that got no answer is adopted by the wizard instead of creating the customer twice.
/// </summary>
[Collection(AteraCollection.Name)]
public sealed class AteraCustomerCreationTests(CrmWebFactory factory)
{
    private const string Kind = AteraCustomerKinds.Create;
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_customer_is_created_in_atera_from_the_card_and_linked_at_once()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraCustomerKinds.All);
        var admin = host.Client();
        var (organizationId, name, orgNumber) = await NewCustomerAsync(admin);
        var ateraId = TestData.AteraId();
        Customers(host, []);
        host.Atera.Given(Request.Create().WithPath("/api/v3/customers").UsingPost()).RespondWith(JsonReply(new { ActionID = ateraId }));
        host.Atera.Given(Request.Create().WithPath($"/api/v3/customers/{ateraId}").UsingGet())
            .RespondWith(JsonReply(new { CustomerID = ateraId, CustomerName = name, BusinessNumber = orgNumber }));

        var atera = (await admin.ServicesAsync(organizationId))[AteraTypes.System];
        (atera.GetProperty("kind").GetString(), atera.GetProperty("consoleUrl").GetString()).ShouldBe((Kind, "https://app.atera.com/"));
        var preview = await admin.PreviewCreateAsync(AteraTypes.System, Kind, organizationId);
        preview.EffectCodes().ShouldBe(["VND_EFFECT_ATERA_CUSTOMER_CREATE", "VND_EFFECT_CUSTOMER_LINKED"]);
        var effect = preview.GetProperty("effects")[0].GetProperty("values");
        (effect.GetProperty("name").GetString(), effect.GetProperty("orgNumber").GetString()).ShouldBe((name, orgNumber));

        var action = await host.RunAsync(await admin.AskCreateAsync(AteraTypes.System, Kind, organizationId));

        (action.Status, action.OutcomeCode, action.Reference).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED", ateraId.ToString(CultureInfo.InvariantCulture)));
        host.Count("POST", "/api/v3/customers").ShouldBe(1);
        var posted = host.Posted("/api/v3/customers");
        (posted.GetProperty("customerName").GetString(), posted.GetProperty("businessNumber").GetString()).ShouldBe((name, orgNumber));
        (await LinkAsync(host.Services, organizationId, AteraTypes.System))!.ExternalId.ShouldBe(ateraId.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task A_customer_atera_already_has_with_the_organization_number_is_not_created_again()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraCustomerKinds.All);
        var admin = host.Client();
        var (organizationId, _, orgNumber) = await NewCustomerAsync(admin);
        Customers(host, [new { CustomerID = TestData.AteraId(), CustomerName = "Laget for hånd", BusinessNumber = $"NO {orgNumber} MVA" }]);

        var action = await host.RunAsync(await admin.AskCreateAsync(AteraTypes.System, Kind, organizationId));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Rejected, "VND_EXISTS_AT_VENDOR"));
        host.Count("POST", "/api/v3/customers").ShouldBe(0);
        (await LinkAsync(host.Services, organizationId, AteraTypes.System)).ShouldBeNull();
    }

    [Fact]
    public async Task An_export_from_the_mapping_screen_that_got_no_answer_is_adopted_by_the_wizard()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraCustomerKinds.All);
        var admin = host.Client();
        var (organizationId, name, orgNumber) = await NewCustomerAsync(admin);
        // The export's POST left without an answer: its journal entry is open, and Atera has the customer.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IExternalEffectJournal>()
                .BeginAsync(new ExternalEffect(AteraTypes.System, AteraCreateCustomerHandler.CustomerEffect, "Organization", organizationId), Ct);
        }

        var ateraId = TestData.AteraId();
        Customers(host, [new { CustomerID = ateraId, CustomerName = name, BusinessNumber = orgNumber }]);

        var action = await host.RunAsync(await admin.AskCreateAsync(AteraTypes.System, Kind, organizationId));

        (action.Status, action.OutcomeCode, action.Reference).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED_EARLIER", ateraId.ToString(CultureInfo.InvariantCulture)));
        host.Count("POST", "/api/v3/customers").ShouldBe(0);
        (await LinkAsync(host.Services, organizationId, AteraTypes.System))!.ExternalId.ShouldBe(ateraId.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task A_lost_answer_followed_by_a_customer_atera_does_not_show_waits_for_a_person()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraCustomerKinds.All);
        var admin = host.Client();
        var (organizationId, _, _) = await NewCustomerAsync(admin);
        Customers(host, []);
        host.Atera.Given(Request.Create().WithPath("/api/v3/customers").UsingPost()).RespondWith(Response.Create().WithFault(WireMock.ResponseBuilders.FaultType.EMPTY_RESPONSE));

        var actionId = await admin.AskCreateAsync(AteraTypes.System, Kind, organizationId);
        (await host.RunAsync(actionId)).Status.ShouldBe(VendorActionStatus.Queued);
        await DueNowAsync(host.Services, actionId);
        var settled = await host.RunAsync(actionId);

        (settled.Status, settled.OutcomeCode).ShouldBe((VendorActionStatus.Uncertain, "VND_CREATE_NOT_FOUND"));
        host.Count("POST", "/api/v3/customers").ShouldBe(1);
    }

    [Fact]
    public async Task A_customer_someone_made_in_atera_without_the_organization_number_is_not_created_again()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraCustomerKinds.All);
        var admin = host.Client();
        var (organizationId, name, _) = await NewCustomerAsync(admin);
        // Made by hand in Atera, named like the customer but without the number, so the key search does not find it; a namesake
        // with another number is another company and stands in nobody's way.
        Customers(host, [
            new { CustomerID = TestData.AteraId(), CustomerName = name.ToLowerInvariant(), BusinessNumber = (string?)null },
            new { CustomerID = TestData.AteraId(), CustomerName = name, BusinessNumber = TestData.OrgNumber() },
        ]);

        var action = await host.RunAsync(await admin.AskCreateAsync(AteraTypes.System, Kind, organizationId));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Rejected, "VND_EXISTS_AT_VENDOR"));
        host.Count("POST", "/api/v3/customers").ShouldBe(0);
        (await LinkAsync(host.Services, organizationId, AteraTypes.System)).ShouldBeNull("a person links it on the mapping screen");
    }

    private static void Customers(AteraTicketHost host, object[] customers) =>
        host.Atera.Given(Request.Create().WithPath("/api/v3/customers").UsingGet().WithParam("page", "1"))
            .RespondWith(JsonReply(new { items = customers, totalPages = 1 }));

    private static async Task<(Guid Id, string Name, string OrgNumber)> NewCustomerAsync(HttpClient admin)
    {
        var name = $"Nykunde {Guid.NewGuid():N}"[..16] + " AS";
        var orgNumber = TestData.OrgNumber();
        return (await admin.CreateOrganizationAsync(new { name, orgNumber, status = "Customer" }), name, orgNumber);
    }
}
