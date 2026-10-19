using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

// These provider fixtures share the real persisted PowerOffice cursors with the existing sync suite. Keep their
// deliberately interrupted passes out of other classes' fixed-timestamp scenarios; races are exercised explicitly below.
[CollectionDefinition(nameof(PowerOfficeResumeCollection), DisableParallelization = true)]
public sealed class PowerOfficeResumeCollection { }

[Collection(nameof(PowerOfficeResumeCollection))]
public class PowerOfficeResumeTests(CrmWebFactory factory)
{
    [Theory]
    [InlineData("CreateMatcherAsync")]
    [InlineData("ApplyExternalBillingDetailsAsync")]
    public async Task Customer_replay_finishes_work_after_payload_was_committed(string failureAt)
    {
        using var po = StartProvider();
        await using var host = Host(po);
        var admin = host.CreateClient();
        admin.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        admin.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "admin");
        admin.DefaultRequestHeaders.Add("X-CSRF", "1");
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = "Synthetic resume customer", orgNumber, status = "Customer" });
        var externalId = Random.Shared.NextInt64(730000000, 739999999);
        var externalKey = externalId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var customer = new PoCustomer(externalId, 7300101, "Synthetic resume customer", null, null, null, false,
            orgNumber, null, "synthetic-invoices@example.invalid", "EHF", null, null, null, true, false, null,
            DateTimeOffset.Parse("2026-10-18T00:00:00Z"));
        Pages(po, "Customers", new[] { customer });
        var before = await Cursor(host.Services, "customers");

        await using (var scope = host.Services.CreateAsyncScope())
        {
            var proxy = DispatchProxy.Create<ICustomersApi, CustomerFault>();
            ((CustomerFault)(object)proxy).Target = scope.ServiceProvider.GetRequiredService<ICustomersApi>();
            ((CustomerFault)(object)proxy).FailureAt = failureAt;
            var job = ActivatorUtilities.CreateInstance<PowerOfficeCustomerSyncJob>(scope.ServiceProvider, proxy);
            await Should.ThrowAsync<SyncFailedException>(() => job.RunAsync(CancellationToken.None));
        }
        (await Cursor(host.Services, "customers")).ShouldBe(before);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            (await db.ExternalRecords.CountAsync(r => r.System == "poweroffice" && r.ExternalType == "Customer" && r.ExternalId == externalKey)).ShouldBe(1);
        }

        // A fresh job scope stands in for the restarted worker. No payload changes are made.
        await RunCustomer(host.Services);
        await RunCustomer(host.Services);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            (await db.ExternalLinks.Where(l => l.System == "poweroffice" && l.ExternalType == "Customer" && l.EntityId == organizationId).ToListAsync())
                .ShouldHaveSingleItem().ExternalId.ShouldBe(externalKey);
            var saved = await scope.ServiceProvider.GetRequiredService<ICustomersApi>().GetOrganizationForSyncAsync(organizationId, CancellationToken.None);
            saved!.Billing.InvoiceEmail.ShouldBe(customer.InvoiceEmailAddress);
        }
        AssertReadOnly(po);
    }

    [Fact]
    public async Task Contact_replay_finishes_matching_after_payload_was_committed()
    {
        using var po = StartProvider();
        await using var host = Host(po);
        var admin = host.CreateClient();
        admin.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        admin.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "admin");
        admin.DefaultRequestHeaders.Add("X-CSRF", "1");
        var org = await admin.CreateOrganizationAsync(new { name = "Synthetic resume contact", status = "Customer" });
        var email = $"synthetic-{Guid.NewGuid():N}@example.invalid";
        var created = await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{org}/contacts",
            new { firstName = "Synthetic", lastName = "Contact", email, roles = new[] { "Billing" }, isPrimary = true });
        created.EnsureSuccessStatusCode();
        var contactId = (await created.ReadJsonAsync()).GetProperty("contactId").GetGuid();
        var person = new PoContactPerson(7, 7300201, "Synthetic", "Contact", email, null, null, true, true,
            DateTimeOffset.Parse("2026-10-18T00:00:00Z"));
        Pages(po, "ContactPersons", new[] { person });
        var before = await Cursor(host.Services, "contact-persons");

        await using (var scope = host.Services.CreateAsyncScope())
        {
            var proxy = DispatchProxy.Create<ICustomersApi, CustomerFault>();
            ((CustomerFault)(object)proxy).Target = scope.ServiceProvider.GetRequiredService<ICustomersApi>();
            ((CustomerFault)(object)proxy).FailureAt = "FindContactsByEmailAsync";
            var job = ActivatorUtilities.CreateInstance<PowerOfficeContactPersonSyncJob>(scope.ServiceProvider, proxy);
            await Should.ThrowAsync<SyncFailedException>(() => job.RunAsync(CancellationToken.None));
        }
        (await Cursor(host.Services, "contact-persons")).ShouldBe(before);
        for (var i = 0; i < 2; i++)
        {
            await using var scope = host.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<PowerOfficeContactPersonSyncJob>().RunAsync(CancellationToken.None);
        }
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            (await db.ExternalLinks.Where(l => l.System == "poweroffice" && l.ExternalType == "ContactPerson" && l.EntityId == contactId).ToListAsync())
                .ShouldHaveSingleItem().ExternalId.ShouldBe("7300201:7");
            (await db.ExternalRecords.CountAsync(r => r.System == "poweroffice" && r.ExternalType == "ContactPerson" && r.ExternalId == "7300201:7")).ShouldBe(1);
        }
        AssertReadOnly(po);
    }

    private Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> Host(WireMockServer po) => factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Integrations:PowerOffice:BaseUrl", po.Url + "/v2/");
        builder.UseSetting("Integrations:PowerOffice:TokenUrl", po.Url + "/OAuth/Token");
        builder.UseSetting("Integrations:PowerOffice:WriteEnabled", "false");
        builder.UseSetting("Integrations:PowerOffice:RetryDelay", "00:00:00.020");
        builder.UseSetting("Customers:BillingDetailsMaster", "PowerOffice");
    });

    [Theory]
    [InlineData(503, false)]
    [InlineData(200, true)]
    public async Task Incomplete_page_does_not_advance_cursor_and_replay_has_no_duplicate_records(int status, bool nullPage)
    {
        using var po = StartProvider();
        await using var host = Host(po);
        var id = Random.Shared.NextInt64(740000000, 749999999);
        var externalId = id.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var changedAt = DateTimeOffset.Parse("2026-10-18T00:30:00Z");
        var product = new PoProduct(id, "SYNTHETIC-RESUME", "Synthetic replay product", null, null, null, 100m, 50m, false, changedAt);
        Pages(po, "Products", new[] { product, product });
        var brokenPage = Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "2");
        po.Given(brokenPage).RespondWith(nullPage
            ? Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/json").WithBody("null")
            : Response.Create().WithStatusCode(status));
        var before = await Cursor(host.Services, "products");
        await Should.ThrowAsync<SyncFailedException>(async () =>
        {
            await using var scope = host.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<PowerOfficeProductSyncJob>().RunAsync(CancellationToken.None);
        });
        (await Cursor(host.Services, "products")).ShouldBe(before);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalRecords
                .CountAsync(r => r.System == "poweroffice" && r.ExternalType == "Product" && r.ExternalId == externalId)).ShouldBe(1);
        }
        po.Given(brokenPage).RespondWith(Response.Create().WithStatusCode(204));
        for (var i = 0; i < 2; i++)
        {
            await using var scope = host.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<PowerOfficeProductSyncJob>().RunAsync(CancellationToken.None);
        }
        await using (var scope = host.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalRecords
                .CountAsync(r => r.System == "poweroffice" && r.ExternalType == "Product" && r.ExternalId == externalId)).ShouldBe(1);
        }
        var cursor = PowerOfficeCursor.Parse(await Cursor(host.Services, "products"));
        cursor.ShouldNotBeNull();
        (cursor >= changedAt).ShouldBeTrue();
        AssertReadOnly(po);
    }

    private static WireMockServer StartProvider()
    {
        var po = WireMockServer.Start();
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost())
            .RespondWith(JsonReply(new { access_token = "synthetic-resume-token", token_type = "bearer", expires_in = 1200 }));
        return po;
    }

    private static void Pages(WireMockServer po, string resource, object items)
    {
        po.Given(Request.Create().WithPath($"/v2/{resource}").UsingGet().WithParam("PageNumber", "1")).RespondWith(JsonReply(items));
        po.Given(Request.Create().WithPath($"/v2/{resource}").UsingGet().WithParam("PageNumber", "2")).RespondWith(Response.Create().WithStatusCode(204));
    }

    private static async Task RunCustomer(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<PowerOfficeCustomerSyncJob>().RunAsync(CancellationToken.None);
    }

    private static async Task<string?> Cursor(IServiceProvider services, string stream)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<SyncRunner>().GetCursorAsync("poweroffice", stream, CancellationToken.None);
    }

    private static void AssertReadOnly(WireMockServer po) => po.LogEntries
        .Where(e => e.RequestMessage!.Path!.StartsWith("/v2/", StringComparison.Ordinal))
        .ShouldAllBe(e => e.RequestMessage!.Method == "GET");

    public class CustomerFault : DispatchProxy
    {
        public ICustomersApi Target { get; set; } = null!;
        public string FailureAt { get; set; } = string.Empty;

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod!.Name == FailureAt) throw new InvalidOperationException("Synthetic interruption after payload commit.");
            return targetMethod.Invoke(Target, args);
        }
    }
}
