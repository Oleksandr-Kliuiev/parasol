using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.PowerOffice;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

public class PowerOfficeSyncTests(CrmWebFactory factory)
{
    private const string Integrations = "/api/v1/integrations";

    [Fact]
    public async Task Customers_are_imported_linked_updated_and_exported()
    {
        var po = factory.PowerOffice;
        var admin = factory.ClientAs(CrmRoles.Admin);
        var marker = $"PO{Guid.NewGuid():N}"[..10];
        var existingOrgNumber = TestData.OrgNumber();
        var newOrgNumber = TestData.OrgNumber();
        var existingId = await admin.CreateOrganizationAsync(new { name = $"{marker} Alpha AS", orgNumber = existingOrgNumber, status = "Customer" });

        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes("test-application-key:test-client-key"));
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost().WithHeader("Authorization", $"Basic {basic}").WithHeader("Ocp-Apim-Subscription-Key", "test-subscription-key"))
            .RespondWith(JsonReply(new { access_token = "po-token", token_type = "bearer", expires_in = 1200 }));

        object Customer(long id, string name, string? orgNumber, string changed, string? invoiceDelivery = null) => new
        {
            Id = id, Number = 10000 + id, Name = name, OrganizationNumber = orgNumber, EmailAddress = $"post@{marker.ToLowerInvariant()}.no",
            InvoiceEmailAddress = "faktura@example.no", InvoiceDeliveryType = invoiceDelivery, PhoneNumber = "22 00 00 00",
            MailAddress = new { AddressLine1 = "Storgata 1", ZipCode = "0155", City = "OSLO", CountryCode = "NO" },
            IsActive = true, IsArchived = false, LastChangedDateTimeOffset = changed,
        };

        po.Given(Request.Create().WithPath("/v2/Customers").UsingGet().WithParam("PageNumber", "1").WithHeader("Authorization", "Bearer po-token")).AtPriority(10)
            .RespondWith(JsonReply(new[]
            {
                Customer(101, $"{marker} Alpha AS", existingOrgNumber, "2026-09-10T10:00:00+00:00", "EHF"),
                Customer(102, $"{marker} Beta AS", newOrgNumber, "2026-09-11T10:00:00+00:00"),
            }));
        po.Given(Request.Create().WithPath("/v2/Customers").UsingGet().WithParam("PageNumber", "2")).AtPriority(10)
            .RespondWith(JsonReply(new[] { Customer(103, $"{marker} Gamma", null, "2026-09-12T10:00:00+00:00") }));
        // A page shorter than the page size does not end the enumeration; only an empty answer does.
        po.Given(Request.Create().WithPath("/v2/Customers").UsingGet().WithParam("PageNumber", "3")).AtPriority(10)
            .RespondWith(Response.Create().WithStatusCode(204));
        po.Given(Request.Create().WithPath("/v2/ContactPersons").UsingGet().WithParam("PageNumber", "2")).AtPriority(10)
            .RespondWith(Response.Create().WithStatusCode(204));
        po.Given(Request.Create().WithPath("/v2/Customers").UsingGet().WithParam("lastChangedDateTimeOffsetGreaterThan")).AtPriority(1)
            .RespondWith(Response.Create().WithStatusCode(204));
        po.Given(Request.Create().WithPath("/v2/ContactPersons").UsingGet().WithParam("PageNumber", "1")).AtPriority(10)
            .RespondWith(JsonReply(new[]
            {
                new { Id = 1, ContactId = 102, FirstName = "Per", LastName = marker, EmailAddress = $"per@{marker.ToLowerInvariant()}.no", Title = "CFO", IsActive = true, LastChangedDateTimeOffset = "2026-09-12T11:00:00+00:00" },
            }));

        // 1. Customer sync: three customers across two pages; the one with a known org number is linked automatically.
        await factory.RunJobAsync<PowerOfficeCustomerSyncJob>(j => j.RunAsync(CancellationToken.None));

        var unlinked = await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/records?system=poweroffice&type=Customer&state=Unlinked&search={marker}");
        unlinked.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("externalId").GetString()).Order().ShouldBe(["102", "103"]);
        var links = await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/links?entityType=Organization&entityId={existingId}");
        var link = links.EnumerateArray().ShouldHaveSingleItem();
        link.GetProperty("externalId").GetString().ShouldBe("101");
        link.GetProperty("method").GetString().ShouldBe("Automatic");

        // 2. Import an unmatched customer and its contact person.
        var imported = await admin.PostAsync($"{Integrations}/records/poweroffice/Customer/102/import", null);
        imported.StatusCode.ShouldBe(HttpStatusCode.OK);
        var importedId = (await imported.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("entityId").GetGuid();
        var importedOrg = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/customers/organizations/{importedId}");
        importedOrg.GetProperty("orgNumber").GetString().ShouldBe(newOrgNumber);
        importedOrg.GetProperty("postalAddress").GetProperty("city").GetString().ShouldBe("OSLO");

        await factory.RunJobAsync<PowerOfficeContactPersonSyncJob>(j => j.RunAsync(CancellationToken.None));
        po.Given(Request.Create().WithPath("/v2/ContactPersons/102/1").UsingGet())
            .RespondWith(JsonReply(new { Id = 1, ContactId = 102, FirstName = "Per", LastName = marker, EmailAddress = $"per@{marker.ToLowerInvariant()}.no", Title = "CFO", IsActive = true, LastChangedDateTimeOffset = "2026-09-12T11:00:00+00:00" }));
        (await admin.PostAsync($"{Integrations}/records/poweroffice/ContactPerson/102:1/import", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var contacts = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/customers/organizations/{importedId}/contacts");
        contacts.EnumerateArray().ShouldHaveSingleItem().GetProperty("title").GetString().ShouldBe("CFO");

        // 3. Editing a linked organization in the CRM patches only what changed.
        po.Given(Request.Create().WithPath("/v2/Customers/101").UsingGet())
            .RespondWith(JsonReply(Customer(101, $"{marker} Alpha AS", existingOrgNumber, "2026-09-10T10:00:00+00:00", "EHF")));
        po.Given(Request.Create().WithPath("/v2/Customers/101").UsingPatch())
            .RespondWith(JsonReply(Customer(101, $"{marker} Alpha Renamed AS", existingOrgNumber, "2026-09-15T10:00:00+00:00", "EHF")));

        var read = await admin.GetAsync($"/api/v1/customers/organizations/{existingId}");
        var current = await read.Content.ReadFromJsonAsync<JsonElement>();
        var edit = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/customers/organizations/{existingId}")
        {
            Content = JsonContent.Create(new
            {
                name = $"{marker} Alpha Renamed AS", orgNumber = existingOrgNumber, status = "Customer",
                email = current.GetProperty("email").GetString(), phone = current.GetProperty("phone").GetString(),
                invoiceEmail = current.GetProperty("invoiceEmail").GetString(), ehfEnabled = current.GetProperty("ehfEnabled").GetBoolean(),
                postalAddress = new { street = "Storgata 1", postalCode = "0155", city = "OSLO", countryCode = "NO" },
                billingAddress = new { street = "Storgata 1", postalCode = "0155", city = "OSLO", countryCode = "NO" },
            }),
        };
        edit.Headers.IfMatch.ParseAdd(read.Headers.ETag!.Tag);
        (await admin.SendAsync(edit)).EnsureSuccessStatusCode();

        await factory.ProcessEventsAndOutboundAsync();

        var patch = po.LogEntries.Single(e => e.RequestMessage!.Method == "PATCH" && e.RequestMessage.Path == "/v2/Customers/101");
        patch.RequestMessage!.Headers!["Content-Type"].ShouldContain(h => h.StartsWith("application/json-patch+json", StringComparison.Ordinal));
        var ops = JsonDocument.Parse(patch.RequestMessage.Body!).RootElement.EnumerateArray().Select(o => o.GetProperty("path").GetString()).ToList();
        ops.ShouldContain("/Name");
        ops.ShouldNotContain("/OrganizationNumber");

        // 4. Creating a CRM organization in PowerOffice looks for an existing customer first, then posts it with a CRM reference.
        var newId = await admin.CreateOrganizationAsync(new { name = $"{marker} Delta AS", status = "Customer", email = "post@delta.no" });
        po.Given(Request.Create().WithPath("/v2/Customers").UsingGet().WithParam("externalImportReference")).AtPriority(1)
            .RespondWith(Response.Create().WithStatusCode(204));
        po.Given(Request.Create().WithPath("/v2/Customers").UsingPost())
            .RespondWith(JsonReply(Customer(200, $"{marker} Delta AS", null, "2026-09-15T12:00:00+00:00"), 201));

        var export = await admin.PostAsync($"{Integrations}/poweroffice/organizations/{newId}/export", null);
        export.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        await factory.ProcessEventsAndOutboundAsync();

        var post = po.LogEntries.Single(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == "/v2/Customers");
        post.RequestMessage!.Body!.ShouldContain($"crm:{newId}");
        (await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/links?entityType=Organization&entityId={newId}"))
            .EnumerateArray().ShouldHaveSingleItem().GetProperty("method").GetString().ShouldBe("Exported");
        (await admin.PostAsync($"{Integrations}/poweroffice/organizations/{newId}/export", null)).StatusCode.ShouldBe(HttpStatusCode.Conflict);

        // 5. The next run continues from the cursor, five minutes back so a record changed while a page was read is not missed.
        await factory.RunJobAsync<PowerOfficeCustomerSyncJob>(j => j.RunAsync(CancellationToken.None));
        po.LogEntries.ShouldContain(e => e.RequestMessage!.Path == "/v2/Customers" && e.RequestMessage.Url.Contains("lastChangedDateTimeOffsetGreaterThan=2026-09-12T09"));

        // 6. A merge moves the link to the surviving organization.
        var survivorId = await admin.CreateOrganizationAsync(new { name = $"{marker} Survivor AS", status = "Customer" });
        (await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{survivorId}/merge", new { sourceOrganizationId = existingId })).EnsureSuccessStatusCode();
        await factory.ProcessEventsAndOutboundAsync();
        // A parallel class's outbox run may hold the merge event a moment longer than this drain.
        await factory.EventuallyAsync(async () =>
            (await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/links?entityType=Organization&entityId={survivorId}"))
                .EnumerateArray().Any(l => l.GetProperty("externalId").GetString() == "101"));
        (await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/links?entityType=Organization&entityId={survivorId}"))
            .EnumerateArray().ShouldContain(l => l.GetProperty("externalId").GetString() == "101");
    }

    [Fact]
    public async Task Billing_contacts_are_created_in_poweroffice_and_kept_up_to_date()
    {
        var po = factory.PowerOffice;
        var admin = factory.ClientAs(CrmRoles.Admin);
        var customerId = Random.Shared.Next(800_000, 899_999);
        var marker = $"cp{Guid.NewGuid():N}"[..10];
        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes("test-application-key:test-client-key"));
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost().WithHeader("Authorization", $"Basic {basic}"))
            .RespondWith(JsonReply(new { access_token = "po-token", token_type = "bearer", expires_in = 1200 }));

        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Faktura AS", status = "Customer" });
        (await admin.PostAsJsonAsync($"{Integrations}/links", new { system = "poweroffice", externalType = "Customer", externalId = customerId.ToString(System.Globalization.CultureInfo.InvariantCulture), entityId = organizationId }))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        object Person(string email) => new
        {
            Id = 9, ContactId = customerId, FirstName = "Kari", LastName = marker, EmailAddress = email, IsActive = true,
            LastChangedDateTimeOffset = "2026-09-15T12:00:00+00:00",
        };
        po.Given(Request.Create().WithPath("/v2/ContactPersons").UsingGet().WithParam("externalCodes")).AtPriority(1)
            .RespondWith(Response.Create().WithStatusCode(204));
        po.Given(Request.Create().WithPath($"/v2/ContactPersons/{customerId}").UsingPost())
            .RespondWith(JsonReply(Person($"kari@{marker}.no"), 201));

        var created = await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts",
            new { firstName = "Kari", lastName = marker, email = $"kari@{marker}.no", roles = new[] { "Billing" }, isPrimary = true });
        created.EnsureSuccessStatusCode();
        var contactId = (await created.ReadJsonAsync()).GetProperty("contactId").GetGuid();
        await factory.ProcessEventsAndOutboundAsync();

        var post = po.LogEntries.Single(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == $"/v2/ContactPersons/{customerId}");
        post.RequestMessage!.Body!.ShouldContain($"crm:{contactId}");
        (await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/links?entityType=Contact&entityId={contactId}"))
            .EnumerateArray().ShouldHaveSingleItem().GetProperty("externalId").GetString().ShouldBe($"{customerId}:9");

        po.Given(Request.Create().WithPath($"/v2/ContactPersons/{customerId}/9").UsingGet()).RespondWith(JsonReply(Person($"kari@{marker}.no")));
        po.Given(Request.Create().WithPath($"/v2/ContactPersons/{customerId}/9").UsingPatch()).RespondWith(JsonReply(Person($"kari.new@{marker}.no")));
        var read = await admin.GetAsync($"/api/v1/customers/contacts/{contactId}");
        (await admin.PutWithETagAsync($"/api/v1/customers/contacts/{contactId}", new { firstName = "Kari", lastName = marker, email = $"kari.new@{marker}.no" }, read.Headers.ETag!.Tag))
            .EnsureSuccessStatusCode();
        await factory.ProcessEventsAndOutboundAsync();

        var patch = po.LogEntries.Single(e => e.RequestMessage!.Method == "PATCH" && e.RequestMessage.Path == $"/v2/ContactPersons/{customerId}/9");
        JsonDocument.Parse(patch.RequestMessage!.Body!).RootElement.EnumerateArray().Select(o => o.GetProperty("path").GetString()).ShouldBe(["/EmailAddress"]);
    }

    [Fact]
    public async Task Products_are_linked_to_the_catalog_by_sku_or_imported()
    {
        var po = factory.PowerOffice;
        var admin = factory.ClientAs(CrmRoles.Admin);
        var finance = factory.ClientAs(CrmRoles.Finance);
        var existingSku = CatalogApiTests.Sku("POLINK");
        var existingId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(existingSku, "Support hour"));
        var newCode = CatalogApiTests.Sku("PONEW");

        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes("test-application-key:test-client-key"));
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost().WithHeader("Authorization", $"Basic {basic}"))
            .RespondWith(JsonReply(new { access_token = "po-token", token_type = "bearer", expires_in = 1200 }));
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "1")).AtPriority(10)
            .RespondWith(JsonReply(new object[]
            {
                new { Id = 501, Code = existingSku.ToLowerInvariant(), Name = "Support", UnitOfMeasureCode = "HUR", UnitPrice = 1250m, IsArchived = false, LastChangedDateTimeOffset = "2026-09-10T10:00:00+00:00" },
                new { Id = 502, Code = newCode, Name = "Fakturagebyr", UnitOfMeasureCode = "EA", UnitPrice = 49m, UnitCost = 10m, IsArchived = false, LastChangedDateTimeOffset = "2026-09-10T10:00:00+00:00" },
            }));
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "2")).AtPriority(10)
            .RespondWith(Response.Create().WithStatusCode(204));

        await factory.RunJobAsync<PowerOfficeProductSyncJob>(j => j.RunAsync(CancellationToken.None));

        var records = await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/records?system=poweroffice&type=Product&search={existingSku}");
        var suggestion = records.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().GetProperty("suggestions").EnumerateArray().ShouldHaveSingleItem();
        suggestion.GetProperty("entityId").GetGuid().ShouldBe(existingId);
        suggestion.GetProperty("reasons").EnumerateArray().Select(r => r.GetString()).ShouldBe(["Sku"]);

        var autoLinked = await (await admin.PostAsync($"{Integrations}/records/poweroffice/Product/auto-link", null)).ReadJsonAsync();
        autoLinked.GetProperty("linked").GetInt32().ShouldBeGreaterThanOrEqualTo(1);
        var links = await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/links?entityType=Product&entityId={existingId}");
        links.EnumerateArray().ShouldHaveSingleItem().GetProperty("externalId").GetString().ShouldBe("501");

        var imported = await (await admin.PostAsync($"{Integrations}/records/poweroffice/Product/502/import", null)).ReadJsonAsync();
        var product = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/catalog/products/{imported.GetProperty("entityId").GetGuid()}");
        product.GetProperty("sku").GetString().ShouldBe(newCode);
        product.GetProperty("listPrice").GetDecimal().ShouldBe(49m);
        product.GetProperty("unitCost").GetDecimal().ShouldBe(10m);
    }

    [Fact]
    public async Task Mapping_endpoints_require_integration_permission()
    {
        (await factory.ClientAs(CrmRoles.Sales).GetAsync($"{Integrations}/records?system=poweroffice&type=Customer&state=All")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await factory.ClientAs(CrmRoles.Admin).GetAsync($"{Integrations}/records?system=poweroffice&type=Invoice&state=All")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }
}
