using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Integrations.Atera;
using Crm.Integrations.Huntress;
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
    public void Huntress_responses_are_understood_by_the_readers()
    {
        var f = Load("huntress");
        Assert.Equal(4401, HuntressClient.ReadAccount(f.GetProperty("account").GetProperty("account"))!.Id);
        Assert.Equal("Fjord IT AS", HuntressClient.ReadOrganization(f.GetProperty("organizations").GetProperty("organizations")[0])!.Name);
        Assert.Equal(42, HuntressClient.ReadUsage(f.GetProperty("organization").GetProperty("organization"))!.BillableAgents);

        var agent = HuntressClient.ReadAgent(f.GetProperty("agents")[0])!;
        Assert.Equal(("SRV-01", 4410L, "Unhealthy", "Disabled"), (agent.Hostname, agent.OrganizationId, agent.DefenderStatus, agent.FirewallStatus));

        var incident = HuntressClient.ReadIncident(f.GetProperty("incidentReport"))!;
        Assert.Equal(("sent", 2), (incident.Status, incident.Remediations.Count));
        Assert.Equal(2, f.GetProperty("comments").GetProperty("comments").EnumerateArray().Count(c => HuntressClient.ReadComment(c) is not null));

        var escalation = HuntressClient.ReadNotice(HuntressNoticeKind.Escalation, f.GetProperty("escalation").GetProperty("escalation"))!;
        Assert.Equal(("unexpected_country_access", 4), (escalation.TypeCode, escalation.Entities!.Count));
        Assert.Equal("Defender Disabled", HuntressClient.ReadNotice(HuntressNoticeKind.PlatformAction, f.GetProperty("platformAction").GetProperty("platform_action"))!.Subject);
        Assert.Equal(new DateOnly(2026, 9, 1), HuntressClient.ReadReport(f.GetProperty("report"))!.PeriodStart);
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
    public void Poweroffice_invoices_deserialize_with_uuid_credit_note_kind_and_client_balance()
    {
        var invoice = JsonSerializer.Deserialize<PoOutgoingInvoice>(Load("poweroffice").GetProperty("invoices")[0].GetRawText(), PoJson.Options);
        Assert.Equal((-5000m, -2000m, "OutgoingCreditNote"), (invoice!.TotalAmount, invoice.Balance, invoice.VoucherType));
        Assert.Equal(Guid.Parse("11111111-2222-4333-8444-555555555555"), invoice.Id);
        Assert.Equal(new DateOnly(2026, 9, 30), invoice.VoucherDate);
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
