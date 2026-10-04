using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

public class ServiceAndTimeTests(CrmWebFactory factory)
{
    private const string Service = "/api/v1/service";
    private const string Time = "/api/v1/time";

    private static readonly DateOnly Today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);

    private async Task<(Guid OrganizationId, long CustomerId)> LinkedOrganizationAsync(HttpClient admin, string name)
    {
        var organizationId = await admin.CreateOrganizationAsync(new { name, status = "Customer" });
        var customerId = Random.Shared.NextInt64(500_000, 599_999);
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
        {
            system = "atera", externalType = "Customer", externalId = customerId.ToString(CultureInfo.InvariantCulture), entityId = organizationId,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        return (organizationId, customerId);
    }

    [Fact]
    public async Task Tickets_devices_alerts_and_work_hours_are_mirrored_from_atera()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var atera = factory.Atera;
        var (organizationId, customerId) = await LinkedOrganizationAsync(admin, $"Atera Speil {Guid.NewGuid():N}"[..28]);
        var ticketId = Random.Shared.NextInt64(9_000, 9_999);
        var technicianId = Random.Shared.NextInt64(70, 99);

        atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("page", "1").WithParam("ticketStatus", "Open")).AtPriority(5)
            .RespondWith(JsonReply(new
            {
                items = new object[]
                {
                    new
                    {
                        TicketID = ticketId, CustomerID = customerId, EndUserID = 501, TicketTitle = "Printer down", TicketStatus = "Open",
                        TicketPriority = "High", TicketType = "Incident", TicketSource = "Email", TechnicianContactID = technicianId,
                        TechnicianEmail = "tech@vardahei.no", TechnicianFullName = "Tor Tekniker", EndUserFirstName = "Kari", EndUserLastName = "Kunde",
                        EndUserEmail = "kari@example.no", TicketCreatedDate = "2026-09-15T08:00:00Z", FirstResponseDate = "2026-09-15T08:20:00Z",
                    },
                },
                totalPages = 1,
            }));
        atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("ticketStatus", "Pending")).AtPriority(5)
            .RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));
        atera.Given(Request.Create().WithPath("/api/v3/agents").UsingGet().WithParam("page", "1")).AtPriority(5)
            .RespondWith(JsonReply(new
            {
                items = new object[]
                {
                    new { AgentID = $"a{customerId}-1", CustomerID = customerId, MachineName = "PC-01", OSType = "Work Station", OS = "Windows 11 Pro", Online = true, LastSeen = "2026-09-16T06:00:00Z" },
                    new { AgentID = $"a{customerId}-2", CustomerID = customerId, MachineName = "SRV-01", OSType = "Server", OS = "Windows Server 2022", Online = false, LastSeen = "2026-09-16T05:00:00Z" },
                },
                totalPages = 1,
            }));
        atera.Given(Request.Create().WithPath("/api/v3/alerts").UsingGet().WithParam("page", "1")).AtPriority(5)
            .RespondWith(JsonReply(new
            {
                items = new object[]
                {
                    new { AlertID = $"al{customerId}", CustomerID = customerId, Title = "Disk almost full", Severity = "Critical", DeviceName = "SRV-01", Created = "2026-09-16T04:00:00Z" },
                    new { AlertID = $"al{customerId}-info", CustomerID = customerId, Title = "Reboot", Severity = "Information", DeviceName = "PC-01", Created = "2026-09-16T04:30:00Z" },
                },
                totalPages = 1,
            }));
        atera.Given(Request.Create().WithPath($"/api/v3/tickets/{ticketId}/workhoursrecords").UsingGet())
            .RespondWith(JsonReply(new object[]
            {
                new
                {
                    WorkHoursID = $"wh-{ticketId}-1", TechnicianContactID = technicianId, TechnicianEmail = "tech@vardahei.no", TechnicianFullName = "Tor Tekniker",
                    StartWorkHour = "2026-09-15T08:30:00Z", EndWorkHour = "2026-09-15T10:00:00Z", TimeSpentInMinutes = 90, Billable = true, IsOnsite = false, Description = "Replaced driver",
                },
            }));

        await factory.RunJobAsync<AteraTicketSyncJob>(j => j.RunAsync(false, CancellationToken.None));
        await factory.RunJobAsync<AteraAgentSyncJob>(j => j.RunAsync(CancellationToken.None));
        await factory.RunJobAsync<AteraAlertSyncJob>(j => j.RunAsync(CancellationToken.None));
        await factory.RunJobAsync<AteraWorkHoursSyncJob>(j => j.RunAsync(CancellationToken.None));

        var tickets = await admin.GetFromJsonAsync<JsonElement>($"{Service}/tickets?organizationId={organizationId}");
        tickets.GetProperty("totalCount").GetInt32().ShouldBe(1);
        var ticket = tickets.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        ticket.GetProperty("title").GetString().ShouldBe("Printer down");
        ticket.GetProperty("isOpen").GetBoolean().ShouldBeTrue();
        ticket.GetProperty("url").GetString().ShouldBe($"https://app.atera.com/new/ticket/{ticketId}");

        var summary = await admin.GetFromJsonAsync<JsonElement>($"{Service}/organizations/{organizationId}/summary");
        summary.GetProperty("openTickets").GetInt32().ShouldBe(1);
        summary.GetProperty("devices").GetProperty("Workstation").GetInt32().ShouldBe(1);
        summary.GetProperty("devices").GetProperty("Server").GetInt32().ShouldBe(1);
        summary.GetProperty("devicesOnline").GetInt32().ShouldBe(1);
        summary.GetProperty("criticalAlerts").GetInt32().ShouldBe(1);
        // Information alerts stay in Atera (BR-SRV-04).
        summary.GetProperty("warningAlerts").GetInt32().ShouldBe(0);

        var entries = await admin.GetFromJsonAsync<JsonElement>($"{Time}/entries?organizationId={organizationId}");
        var entry = entries.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        entry.GetProperty("hours").GetDecimal().ShouldBe(1.5m);
        entry.GetProperty("source").GetString().ShouldBe("Atera");
        entry.GetProperty("externalTicketId").GetInt64().ShouldBe(ticketId);
        entry.GetProperty("status").GetString().ShouldBe("New");
        entry.GetProperty("technicianName").GetString().ShouldBe("Tor Tekniker");

        // The technician is unknown until an administrator maps them; then earlier entries get the CRM user.
        var technicians = await admin.GetFromJsonAsync<JsonElement>("/api/v1/identity/technicians?unmappedOnly=true&limit=200");
        var mapping = technicians.GetProperty("items").EnumerateArray().Single(t => t.GetProperty("externalId").GetString() == technicianId.ToString(CultureInfo.InvariantCulture));
        var serviceLead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "atera-mirror-lead");
        var leadId = (await serviceLead.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        (await admin.PutAsJsonAsync($"/api/v1/identity/technicians/{mapping.GetProperty("id").GetGuid()}", new { userId = leadId })).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        await factory.ProcessEventsAsync();

        var mine = await serviceLead.GetFromJsonAsync<JsonElement>($"{Time}/entries?organizationId={organizationId}&mine=true");
        mine.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().GetProperty("technicianName").GetString().ShouldBe("Test atera-mirror-lead");

        // Running the sync again changes nothing.
        await factory.RunJobAsync<AteraWorkHoursSyncJob>(j => j.RunAsync(CancellationToken.None));
        (await admin.GetFromJsonAsync<JsonElement>($"{Time}/entries?organizationId={organizationId}")).GetProperty("items").EnumerateArray().Count().ShouldBe(1);
    }

    [Fact]
    public async Task Approval_covers_sla_hours_then_the_hour_bank_then_the_rate()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var finance = factory.ClientAs(CrmRoles.Finance);
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "tariff-lead");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "tariff-tech");
        var marker = $"T{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Timer AS", status = "Customer" });
        var product = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(
            CatalogApiTests.Sku("HOUR"), "Support hour", 1100m, 400m, type: "HourlyService", billingPeriod: "OneTime"));
        (await finance.PutWithETagAsync(
            $"/api/v1/catalog/products/{product}",
            new
            {
                sku = CatalogApiTests.Sku("HOUR2"), name = "Support hour", type = "HourlyService", businessLine = "Consulting", unit = "Hour",
                billingPeriod = "OneTime", vatRate = 25m, listPrice = 1100m, unitCost = 400m, ateraWorkType = "Remote",
            },
            (await finance.GetAsync($"/api/v1/catalog/products/{product}")).Headers.ETag!.Tag)).EnsureSuccessStatusCode();

        var sla = await (await admin.PostAsJsonAsync("/api/v1/contracts/sla-policies", new
        {
            name = $"{marker} SLA", coverage = "Business8x5",
            p1 = new { responseMinutes = 60, resolutionMinutes = 240 }, p2 = new { responseMinutes = 120, resolutionMinutes = 480 },
            p3 = new { responseMinutes = 480, resolutionMinutes = 1440 }, p4 = new { responseMinutes = 960, resolutionMinutes = 2880 },
            includedHoursPerMonth = 2m, overageRate = 1250m, afterHoursMultiplier = 1.5m, coveredWorkTypes = "Remote",
        })).ReadJsonAsync();
        var contract = await (await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = "Drift", type = "Msp", startDate = Today.AddMonths(-2), autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30,
            slaPolicyId = sla.GetProperty("id").GetGuid(), invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync();
        var contractId = contract.GetProperty("id").GetGuid();
        (await admin.PostAsync($"/api/v1/contracts/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var bank = await (await admin.PostAsJsonAsync("/api/v1/contracts/hour-banks", new
        {
            organizationId, contractId, name = $"{marker} klippekort", hours = 1m, validFrom = Today.AddMonths(-1), overageRate = 1400m,
        })).ReadJsonAsync();
        var bankId = bank.GetProperty("id").GetGuid();

        // A technician books 5 hours: 2 are covered by the SLA, 1 comes from the bank, 2 are billed at the bank's overage rate.
        var created = await technician.PostAsJsonAsync($"{Time}/entries", new
        {
            organizationId, workDate = Today, hours = 5m, workType = "Remote", billable = true, onsite = false, afterHours = false, description = "Feilsøking",
        });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var entryId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();

        (await technician.PostAsJsonAsync($"{Time}/approve", new { entryIds = new[] { entryId } })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var approved = await (await lead.PostAsJsonAsync($"{Time}/approve", new { entryIds = new[] { entryId } })).ReadJsonAsync();
        approved.GetProperty("approved").GetInt32().ShouldBe(1);

        // The service lead approves but does not see money; Finance does.
        var leadView = (await lead.GetFromJsonAsync<JsonElement>($"{Time}/entries?organizationId={organizationId}")).GetProperty("items").EnumerateArray().Single();
        leadView.TryGetProperty("amount", out _).ShouldBeFalse();
        var entry = (await finance.GetFromJsonAsync<JsonElement>($"{Time}/entries?organizationId={organizationId}")).GetProperty("items").EnumerateArray().Single();
        entry.GetProperty("status").GetString().ShouldBe("Approved");
        var allocations = entry.GetProperty("allocations").EnumerateArray().ToList();
        allocations.Select(a => a.GetProperty("classification").GetString()).ShouldBe(["Covered", "HourBank", "Rate"]);
        allocations[0].GetProperty("hours").GetDecimal().ShouldBe(2m);
        allocations[1].GetProperty("hours").GetDecimal().ShouldBe(1m);
        allocations[2].GetProperty("hours").GetDecimal().ShouldBe(2m);
        allocations[2].GetProperty("rate").GetDecimal().ShouldBe(1400m);
        entry.GetProperty("amount").GetDecimal().ShouldBe(2800m);

        (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/contracts/hour-banks/{bankId}")).GetProperty("remainingHours").GetDecimal().ShouldBe(0m);

        // A technician does not see prices at all.
        var asTechnician = (await technician.GetFromJsonAsync<JsonElement>($"{Time}/entries?mine=true&organizationId={organizationId}")).GetProperty("items").EnumerateArray().Single();
        asTechnician.TryGetProperty("amount", out _).ShouldBeFalse();
        asTechnician.GetProperty("allocations")[2].TryGetProperty("rate", out _).ShouldBeFalse();

        // Withdrawing the approval gives the bank hours back.
        (await lead.PostAsJsonAsync($"{Time}/withdraw", new { entryIds = new[] { entryId } })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/contracts/hour-banks/{bankId}")).GetProperty("remainingHours").GetDecimal().ShouldBe(1m);
    }

    [Fact]
    public async Task A_closed_period_is_locked_until_finance_reopens_it()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "period-lead");
        var finance = factory.ClientAs(CrmRoles.Finance);
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"Periode {Guid.NewGuid():N}"[..24], status = "Customer" });
        var workDate = new DateOnly(2031, 3, 10);
        var entryId = (await (await lead.PostAsJsonAsync($"{Time}/entries", new
        {
            organizationId, workDate, hours = 2m, workType = "Remote", billable = true, onsite = false, afterHours = false, description = "Arbeid",
        })).ReadJsonAsync()).GetProperty("id").GetGuid();

        var tooEarly = await lead.PostAsync($"{Time}/periods/2031/3/close", null);
        tooEarly.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await tooEarly.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("TIM_UNAPPROVED_ENTRIES");

        (await lead.PostAsJsonAsync($"{Time}/approve", new { entryIds = new[] { entryId } })).StatusCode.ShouldBe(HttpStatusCode.OK);
        var closed = await lead.PostAsync($"{Time}/periods/2031/3/close", null);
        closed.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await closed.ReadJsonAsync()).GetProperty("isClosed").GetBoolean().ShouldBeTrue();

        // BR-TIM-05: approved entries of a closed period cannot be changed, and only Finance reopens it.
        var withdraw = await lead.PostAsJsonAsync($"{Time}/withdraw", new { entryIds = new[] { entryId } });
        withdraw.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await withdraw.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("TIM_PERIOD_CLOSED");
        (await lead.PostAsJsonAsync($"{Time}/periods/2031/3/reopen", new { reason = "Correction" })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        (await finance.PostAsJsonAsync($"{Time}/periods/2031/3/reopen", new { reason = "Correction after invoice" })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await lead.PostAsJsonAsync($"{Time}/withdraw", new { entryIds = new[] { entryId } })).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Creating_a_ticket_is_refused_while_writing_to_atera_is_off()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var (organizationId, _) = await LinkedOrganizationAsync(admin, $"Tikett {Guid.NewGuid():N}"[..24]);
        var contactId = (await (await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts", new
        {
            firstName = "Kari", lastName = "Kunde", email = $"kari.{Guid.NewGuid():N}"[..20] + "@example.no", roles = new[] { "Technical" }, isPrimary = true,
        })).ReadJsonAsync()).GetProperty("contactId").GetGuid();

        var requested = await admin.PostAsJsonAsync($"{Service}/ticket-requests", new
        {
            organizationId, contactId, title = "Ny sak fra CRM", description = "Beskrivelse", priority = "High", type = "Incident",
        });
        requested.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        await factory.ProcessEventsAsync();

        // The organization's banner asks only for requests that need attention; a failed one does.
        var requests = await admin.GetFromJsonAsync<JsonElement>($"{Service}/ticket-requests?organizationId={organizationId}&attentionOnly=true");
        var request = requests.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        request.GetProperty("status").GetString().ShouldBe("Failed");
        request.GetProperty("error").GetString()!.ShouldContain("switched off");

        (await factory.ClientAs(CrmRoles.ReadOnly).PostAsJsonAsync($"{Service}/ticket-requests", new
        {
            organizationId, contactId, title = "Ikke lov", description = "x", priority = "Low", type = "Request",
        })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }
}
