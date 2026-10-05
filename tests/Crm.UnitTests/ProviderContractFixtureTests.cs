using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Integrations.Atera;
using Crm.Integrations.PartnerCenter;
using Crm.Integrations.PowerOffice;

namespace Crm.UnitTests;

/// <summary>
/// DEV-19: provider responses as files. The readers are tolerant of several spellings because the real contract is unknown
/// until a sandbox has been read (EXT-03); these tests pin the shapes the files hold, so a reader change that stops
/// understanding a recorded response fails here. The files are synthetic until sanitized sandbox captures replace them.
/// </summary>
public class ProviderContractFixtureTests
{
    private static JsonElement Load(string provider)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "providers", provider + ".json");
        return JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone();
    }

    [Fact]
    public void Atera_responses_are_understood_by_the_readers()
    {
        var f = Load("atera");
        var customer = AteraClient.ReadCustomer(f.GetProperty("customers")[0]);
        Assert.Equal(("Testfirma Alfa AS", "999111222"), (customer!.Name, customer.BusinessNumber));

        var contact = AteraClient.ReadContact(f.GetProperty("contacts")[0]);
        Assert.Equal((501L, 101L, "kari@alfa.example.no"), (contact!.ContactId, contact.CustomerId, contact.Email));

        var ticket = AteraClient.ReadTicket(f.GetProperty("tickets")[0]);
        Assert.Equal(9001, ticket!.TicketId);
        Assert.Contains("[CRM-TR:11111111-1111-1111-1111-111111111111]", ticket.Description);

        var hours = AteraClient.ReadWorkHours(f.GetProperty("workHours")[0], 9001);
        Assert.Equal(1.5m, hours!.Hours);

        var agent = AteraClient.ReadAgent(f.GetProperty("agents")[0]);
        Assert.Equal("PC-ALFA-01", agent!.MachineName);
    }

    [Fact]
    public void A_work_hours_row_without_a_duration_is_dropped_not_read_as_zero()
    {
        Assert.Null(AteraClient.ReadWorkHours(Load("atera").GetProperty("workHoursWithoutDuration")[0], 9001));
    }

    [Fact]
    public void Partner_center_responses_are_understood_by_the_readers()
    {
        var f = Load("partnercenter");
        var customer = PartnerCenterClient.ReadCustomer(f.GetProperty("customers")[0]);
        Assert.Equal(("Testfirma Alfa AS", "999111222"), (customer!.Name, customer.OrganizationNumber));

        var skus = f.GetProperty("subscribedSkus").EnumerateArray().Select(PartnerCenterClient.ReadSubscribedSku).ToList();
        Assert.Equal((25, 21), (skus[0]!.Purchased, skus[0]!.Assigned));
        Assert.Equal((5, 4), (skus[1]!.Purchased, skus[1]!.Assigned));

        var invoice = PartnerCenterClient.ReadInvoice(f.GetProperty("invoices")[0]);
        Assert.Equal(12345.67m, invoice!.Total);
    }

    [Fact]
    public void Poweroffice_invoices_deserialize_with_the_credit_flag_and_remaining_amount()
    {
        var invoice = JsonSerializer.Deserialize<PoOutgoingInvoice>(Load("poweroffice").GetProperty("invoices")[0].GetRawText(), PoJson.Options);
        Assert.Equal((5000m, 2000m, true), (invoice!.TotalAmount, invoice.RemainingAmount, invoice.IsCredited));
    }

    [Theory]
    [InlineData("atera")]
    [InlineData("partnercenter")]
    [InlineData("poweroffice")]
    public void Fixtures_hold_no_secrets_and_no_real_addresses(string provider)
    {
        var text = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "providers", provider + ".json"));
        Assert.DoesNotMatch(new Regex(@"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), text); // JWT
        Assert.DoesNotMatch(new Regex(@"(?i)bearer\s+[a-z0-9._-]{12,}"), text);
        Assert.DoesNotMatch(new Regex(@"(?i)(secret|password|apikey|subscription-?key|client-?key)""\s*:\s*""[^""]{6,}"), text);
        // Only reserved example domains: a real customer's address must never reach the repository.
        foreach (Match m in Regex.Matches(text, @"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})"))
        {
            Assert.Matches(@"(?i)(\.|^)example\.(no|com|org)$", m.Groups[1].Value);
        }

        Assert.Contains("\"source\"", text);
    }
}
