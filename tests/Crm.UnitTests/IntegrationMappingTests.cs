using System.Text.Json;
using Crm.Customers.Contracts;
using Crm.Integrations.Atera;
using Crm.Integrations.PartnerCenter;
using Crm.Integrations.PowerOffice;

namespace Crm.UnitTests;

public class PowerOfficeMappingTests
{
    private static PoCustomer Customer(
        string name = "Fjord IT AS", string? orgNumber = "923 609 016", string? invoiceEmail = "faktura@fjordit.no", string? delivery = "EHF",
        PoAddress? address = null, string? phone = "22 00 00 00", string? website = "https://www.fjordit.no") =>
        new(42, 10042, name, null, null, null, false, orgNumber, "post@fjordit.no", invoiceEmail, delivery, phone, website,
            address ?? new PoAddress("Storgata 1", "Postboks 5", "0155", "OSLO", "NO"), true, false, null, DateTimeOffset.Parse("2026-09-15T10:00:00Z"));

    private static OrganizationSyncView Organization(
        string name = "Fjord IT AS", string? orgNumber = "923609016", string? invoiceEmail = "faktura@fjordit.no", bool? ehf = true,
        AddressData? billing = null, string? phone = "22 00 00 00") =>
        new(Guid.NewGuid(), name, orgNumber, OrganizationStatus.Customer, "post@fjordit.no", phone, "https://www.fjordit.no", ["fjordit.no"],
            new AddressData(null, null, null, null), new AddressData(null, null, null, null),
            new BillingData(invoiceEmail, ehf, billing ?? new AddressData("Storgata 1, Postboks 5", "0155", "Oslo", "NO")), false);

    [Fact]
    public void Customer_maps_to_organization_data()
    {
        var data = PowerOfficeMapping.ToOrganizationData(Customer());

        data.OrgNumber.ShouldBe("923609016");
        data.Domains.ShouldBe(["fjordit.no"]);
        data.PostalAddress.ShouldBe(new AddressData("Storgata 1, Postboks 5", "0155", "OSLO", "NO"));
        data.Billing!.EhfEnabled.ShouldBe(true);
        data.Billing.InvoiceEmail.ShouldBe("faktura@fjordit.no");
    }

    [Fact]
    public void No_patch_when_nothing_owned_by_the_crm_differs()
    {
        CustomerPatchBuilder.Build(Customer(), Organization(), BillingDetailsMaster.Crm).ShouldBeEmpty();
    }

    [Fact]
    public void Patch_contains_only_changed_fields()
    {
        var ops = CustomerPatchBuilder.Build(Customer(), Organization(name: "Fjord IT Service AS", phone: "22 11 11 11", ehf: false), BillingDetailsMaster.Crm);

        ops.Select(o => (o.Op, o.Path, o.Value)).ShouldBe(
        [
            ("replace", "/Name", (object?)"Fjord IT Service AS"),
            ("replace", "/PhoneNumber", "22 11 11 11"),
            ("replace", "/InvoiceDeliveryType", "PdfByEmail"),
        ]);
    }

    [Fact]
    public void Billing_fields_are_not_pushed_when_poweroffice_is_the_billing_master()
    {
        var ops = CustomerPatchBuilder.Build(Customer(), Organization(invoiceEmail: "other@fjordit.no", ehf: false), BillingDetailsMaster.PowerOffice);
        ops.ShouldBeEmpty();
    }

    [Fact]
    public void Patch_serializes_as_json_patch_document()
    {
        var json = JsonSerializer.Serialize(new[] { new PatchOperation("replace", "/Name", "X") });
        json.ShouldBe("""[{"op":"replace","path":"/Name","value":"X"}]""");
    }

    [Fact]
    public void A_field_the_crm_has_empty_never_clears_what_poweroffice_holds()
    {
        // PowerOffice has a phone number, a web site and an invoice address; the CRM has none of them. Nothing is pushed.
        var customer = Customer();
        var organization = Organization(phone: null, invoiceEmail: null, ehf: null) with { Website = null };

        CustomerPatchBuilder.Build(customer, organization, BillingDetailsMaster.Crm).ShouldBeEmpty();
        CustomerPatchBuilder.Build(customer, organization with { Email = "  " }, BillingDetailsMaster.Crm).ShouldBeEmpty();
    }

    [Fact]
    public void A_field_the_crm_has_still_replaces_a_different_value_in_poweroffice()
    {
        var ops = CustomerPatchBuilder.Build(Customer(), Organization(phone: "22 99 99 99") with { Website = null }, BillingDetailsMaster.Crm);

        ops.Select(o => o.Path).ShouldBe(["/PhoneNumber"]);
    }

    [Fact]
    public void A_field_edited_in_poweroffice_is_reported_by_name_only_when_it_differs_from_both_the_crm_and_the_last_known_value()
    {
        var lastKnown = Customer();
        var live = Customer(phone: "99 88 77 66", name: "Fjord IT Renamed AS");
        // The CRM now wants the old name back (equals the last known) and a third phone number.
        var organization = Organization(phone: "22 11 11 11");

        CustomerPatchBuilder.Discrepancies(live, lastKnown, organization, BillingDetailsMaster.Crm)
            .ShouldBe(["Name", "PhoneNumber"]);

        // Unchanged since the last sync: nothing to report even though the CRM wants a different value.
        CustomerPatchBuilder.Discrepancies(lastKnown, lastKnown, organization, BillingDetailsMaster.Crm).ShouldBeEmpty();
        // The live value already equals what the CRM wants: the push is a no-op, not a discrepancy.
        CustomerPatchBuilder.Discrepancies(Customer(phone: "22 11 11 11"), lastKnown, organization, BillingDetailsMaster.Crm).ShouldBeEmpty();
    }

    [Theory]
    [InlineData("GET", 429, null, true)]
    [InlineData("POST", 429, null, true)]
    [InlineData("PATCH", 429, null, true)]
    [InlineData("GET", 503, null, true)]
    [InlineData("GET", 500, null, true)]
    [InlineData("GET", null, "http", true)]
    [InlineData("GET", null, "timeout", true)]
    [InlineData("POST", 503, null, false)]
    [InlineData("POST", 500, null, false)]
    [InlineData("POST", 502, null, false)]
    [InlineData("POST", null, "http", false)]
    [InlineData("POST", null, "timeout", false)]
    [InlineData("PATCH", 503, null, false)]
    [InlineData("GET", 404, null, false)]
    [InlineData("GET", 200, null, false)]
    public void Only_reads_are_repeated_on_server_errors_and_only_429_repeats_a_write(string method, int? status, string? failure, bool retried)
    {
        Exception? exception = failure switch
        {
            "http" => new HttpRequestException("connection reset"),
            "timeout" => new TimeoutException(),
            _ => null,
        };

        PowerOfficeModule.ShouldRetry(new HttpMethod(method), (System.Net.HttpStatusCode?)status, exception).ShouldBe(retried);
    }

    [Fact]
    public void A_sync_reads_from_five_minutes_before_its_cursor_and_everything_without_one()
    {
        var cursor = DateTimeOffset.Parse("2026-09-12T10:00:00+00:00");

        PowerOfficeCursor.ReadFrom(cursor).ShouldBe(DateTimeOffset.Parse("2026-09-12T09:55:00+00:00"));
        PowerOfficeCursor.ReadFrom(null).ShouldBeNull();
    }
}

public class AteraParsingTests
{
    [Fact]
    public void Reads_customer_fields_with_documented_names()
    {
        using var doc = JsonDocument.Parse("""
            {"CustomerID": 17, "CustomerName": "Nordlys Drift AS", "BusinessNumber": "NO 923609016 MVA", "Domain": "nordlys.no",
             "Address": "Kirkegata 5", "City": "Tromsø", "ZipCodeStr": "9008", "Country": "Norway", "Phone": "+47 77 00 00 00",
             "Website": "nordlys.no", "LastModified": "2026-09-01T08:00:00"}
            """);

        var customer = AteraClient.ReadCustomer(doc.RootElement)!;

        customer.CustomerId.ShouldBe(17);
        customer.ZipCode.ShouldBe("9008");
        AteraMapping.ToOrganizationData(customer).OrgNumber.ShouldBe("923609016");
        AteraMapping.ToOrganizationData(customer).VisitAddress!.CountryCode.ShouldBe("NO");
    }

    [Theory]
    [InlineData("""{"EndUserID": 5, "CustomerID": 17, "Firstname": "Kari", "Lastname": "Nordmann", "Email": "kari@nordlys.no"}""")]
    [InlineData("""{"ContactID": 5, "CustomerID": "17", "FirstName": "Kari", "LastName": "Nordmann", "Email": "kari@nordlys.no"}""")]
    public void Reads_contacts_with_either_naming(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var contact = AteraClient.ReadContact(doc.RootElement)!;

        contact.ContactId.ShouldBe(5);
        contact.CustomerId.ShouldBe(17);
        contact.FirstName.ShouldBe("Kari");
        contact.LastName.ShouldBe("Nordmann");
    }

    [Theory]
    [InlineData("923609016", "923609016")]
    [InlineData("SE556677-8899", null)]
    [InlineData(null, null)]
    public void Business_number_is_used_only_when_it_looks_norwegian(string? input, string? expected) =>
        AteraMapping.OrgNumber(input).ShouldBe(expected);
}

public class PartnerCenterMappingTests
{
    [Fact]
    public void Subscribed_skus_are_read_in_both_the_partner_center_and_the_graph_spelling()
    {
        var partnerCenter = JsonSerializer.Deserialize<JsonElement>(
            """{"skuId":"05e9a617","skuPartNumber":"SPE_E3","prepaidUnits":{"enabled":25,"suspended":0},"consumedUnits":21}""");
        var graph = JsonSerializer.Deserialize<JsonElement>(
            """{"id":"05e9a617","productSku":"SPE_E3","activeUnits":25,"assignedUnits":21}""");

        var fromPartnerCenter = PartnerCenterClient.ReadSubscribedSku(partnerCenter).ShouldNotBeNull();
        fromPartnerCenter.SkuPartNumber.ShouldBe("SPE_E3");
        fromPartnerCenter.Purchased.ShouldBe(25);
        fromPartnerCenter.Assigned.ShouldBe(21);

        var fromGraph = PartnerCenterClient.ReadSubscribedSku(graph).ShouldNotBeNull();
        fromGraph.Purchased.ShouldBe(25);
        fromGraph.Assigned.ShouldBe(21);

        // A row without a SKU says nothing and is skipped rather than stored as an empty reading.
        PartnerCenterClient.ReadSubscribedSku(JsonSerializer.Deserialize<JsonElement>("""{"consumedUnits":3}""")).ShouldBeNull();
    }

    [Fact]
    public void An_invoice_needs_an_id_and_keeps_its_date_and_total()
    {
        var invoice = PartnerCenterClient.ReadInvoice(JsonSerializer.Deserialize<JsonElement>(
            """{"id":"G012345","invoiceDate":"2026-08-05T00:00:00Z","currencyCode":"NOK","totalCharges":124500.25}""")).ShouldNotBeNull();

        invoice.Id.ShouldBe("G012345");
        invoice.InvoiceDate.ShouldBe(new DateOnly(2026, 8, 5));
        invoice.Total.ShouldBe(124500.25m);
        PartnerCenterClient.ReadInvoice(JsonSerializer.Deserialize<JsonElement>("""{"totalCharges":10}""")).ShouldBeNull();
    }
}
