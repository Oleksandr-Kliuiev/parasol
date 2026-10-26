using Crm.Integrations.CloudAlly;
using Crm.Integrations.Core.Actions;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.CustomerCreationCalls;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M43 on SQL Server: the "Connect services" wizard creates the customer's CloudAlly account (<c>account.create</c>) in a data center of
/// the EU. CloudAlly keeps one account per address, so the address is our key, searched for first; the password CloudAlly requires is
/// made for the request and kept nowhere.
/// </summary>
[Collection(CloudAllyCollection.Name)]
public sealed class CloudAllyAccountCreationTests(CrmWebFactory factory)
{
    private const string Kind = CloudAllyActionKinds.AccountCreate;

    [Fact]
    public async Task An_account_is_created_in_the_eu_with_a_password_kept_nowhere_and_linked_at_once()
    {
        await using var host = CloudAllyHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, name) = await NewCustomerAsync(admin);
        var email = $"backup+{Guid.NewGuid():N}"[..19] + "@kunde.test";
        var accountId = Guid.NewGuid().ToString();
        host.Publish();
        host.On("POST", "/v2/resellers/accounts").RespondWith(JsonReply(new
        {
            id = accountId, name, email, status = "TRIAL", region = "EU_STOCKHOLM", partnerID = "PID-TEST", currency = "EUR",
        }));

        var cloudAlly = (await admin.ServicesAsync(organizationId))[CloudAllyTypes.System];
        cloudAlly.GetProperty("defaults").GetProperty("region").GetString().ShouldBe("EU");
        cloudAlly.GetProperty("consoleUrl").ValueKind.ShouldBe(System.Text.Json.JsonValueKind.Null, "the portal's address is not configured");
        var preview = await admin.PreviewCreateAsync(CloudAllyTypes.System, Kind, organizationId, new { email = email.ToUpperInvariant(), region = "EU_STOCKHOLM" });
        preview.EffectCodes().ShouldBe(["VND_EFFECT_CLOUDALLY_ACCOUNT_CREATE", "VND_EFFECT_CUSTOMER_LINKED", "VND_EFFECT_CLOUDALLY_PASSWORD", "VND_EFFECT_CLOUDALLY_CONSENT_LATER"]);
        preview.GetProperty("effects")[0].GetProperty("values").GetProperty("email").GetString().ShouldBe(email, "the address is kept in lower case");

        var action = await host.RunAsync(await admin.AskCreateAsync(CloudAllyTypes.System, Kind, organizationId, new { email, region = "EU_STOCKHOLM" }));

        (action.Status, action.OutcomeCode, action.Reference).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED", accountId));
        action.Parameters.ShouldNotContain("password", Case.Insensitive);
        host.Count("POST", "/v2/resellers/accounts").ShouldBe(1);
        var posted = host.Posted("/v2/resellers/accounts");
        (posted.GetProperty("email").GetString(), posted.GetProperty("displayName").GetString(), posted.GetProperty("region").GetString())
            .ShouldBe((email, name, "EU_STOCKHOLM"));
        var password = posted.GetProperty("password").GetString()!;
        password.Length.ShouldBe(24);
        password.ShouldMatch("[a-z]");
        password.ShouldMatch("[A-Z]");
        password.ShouldMatch("[0-9]");
        var headers = host.Headers("POST", "/v2/resellers/accounts");
        (headers["client-id"], headers["client-secret"]).ShouldBe(("test-client", "test-secret"));
        (await LinkAsync(host.Services, organizationId, CloudAllyTypes.System))!.ExternalId.ShouldBe(accountId);
    }

    [Fact]
    public async Task An_address_another_account_has_is_not_created_twice_and_a_region_outside_the_eu_is_refused()
    {
        await using var host = CloudAllyHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, _) = await NewCustomerAsync(admin);
        var existing = host.Account("Laget for hand", null);
        host.Publish();

        (await admin.PreviewCreateAsync(CloudAllyTypes.System, Kind, organizationId, new { email = "backup@kunde.test", region = "US_EST" }))
            .BlockCode().ShouldBe("VND_REGION_INVALID");
        (await admin.PreviewCreateAsync(CloudAllyTypes.System, Kind, organizationId, new { email = "ikke en adresse", region = "EU" }))
            .BlockCode().ShouldBe("VND_EMAIL_INVALID");

        var action = await host.RunAsync(await admin.AskCreateAsync(CloudAllyTypes.System, Kind, organizationId, new { email = existing.Email, region = "EU" }));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Rejected, "VND_EXISTS_AT_VENDOR"));
        host.Count("POST", "/v2/resellers/accounts").ShouldBe(0);
        (await LinkAsync(host.Services, organizationId, CloudAllyTypes.System)).ShouldBeNull();
    }

    private static async Task<(Guid Id, string Name)> NewCustomerAsync(HttpClient admin)
    {
        var name = $"Kopikunde {Guid.NewGuid():N}"[..16] + " AS";
        return (await admin.CreateOrganizationAsync(new { name, status = "Customer" }), name);
    }
}
