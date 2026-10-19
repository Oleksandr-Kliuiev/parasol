using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using WireMock.Types;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// Atera's write and read paths when an answer is lost, a page is long or the provider throttles (DEV-19). Each test talks to an
/// Atera stub of its own through a host of its own, so faults and counts never mix with other tests. Atera has no sandbox
/// (EXT-03): the stub encodes the assumptions the tests make about it, listed in the DEV-19 report.
/// </summary>
[Collection(AteraCollection.Name)]
public class AteraResilienceTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class TestHost(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> host, WireMockServer atera) : IAsyncDisposable
    {
        public IServiceProvider Services => host.Services;

        public WireMockServer Atera => atera;

        public async ValueTask DisposeAsync()
        {
            await host.DisposeAsync();
            atera.Dispose();
        }
    }

    private TestHost Host(bool writeEnabled = true)
    {
        var atera = WireMockServer.Start();
        var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Integrations:Atera:BaseUrl", atera.Url + "/api/v3/");
            builder.UseSetting("Integrations:Atera:WriteEnabled", writeEnabled ? "true" : "false");
            builder.UseSetting("Integrations:Atera:RetryDelay", "00:00:00.020");
        });
        return new TestHost(host, atera);
    }

    private static int Count(WireMockServer atera, string method, string path) =>
        atera.LogEntries.Count(e => e.RequestMessage!.Method == method && e.RequestMessage.Path == path);

    private async Task<(Guid OrganizationId, long CustomerId)> LinkedOrganizationAsync(HttpClient admin, string name, string? orgNumber = null)
    {
        var organizationId = await admin.CreateOrganizationAsync(new { name, orgNumber, status = "Customer" });
        var customerId = Random.Shared.NextInt64(800_000, 899_999);
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
        {
            system = "atera", externalType = "Customer", externalId = customerId.ToString(CultureInfo.InvariantCulture), entityId = organizationId,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return (organizationId, customerId);
    }

    private static async Task<Guid> CreateContactAsync(HttpClient admin, Guid organizationId, string email) =>
        (await (await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts", new
        {
            firstName = "Kari", lastName = "Kunde", email, roles = new[] { "Technical" }, isPrimary = true,
        }, Ct)).ReadJsonAsync()).GetProperty("contactId").GetGuid();

    /// <summary>The request is stored without its event: other tests drain the shared outbox with a host that has writing off.</summary>
    private static async Task<Guid> CreateRequestAsync(TestHost host, Guid organizationId, Guid contactId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var request = TicketRequest.Create(organizationId, contactId, "Printer is down", "The second floor printer", "High", "Incident");
        request.ClearDomainEvents();
        db.TicketRequests.Add(request);
        await db.SaveChangesAsync(Ct);
        return request.Id;
    }

    private static async Task<TicketRequest> RequestAsync(TestHost host, Guid id)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().TicketRequests.AsNoTracking().SingleAsync(r => r.Id == id, Ct);
    }

    private static async Task<OutboundResult> RunCreateTicketAsync(TestHost host, Guid requestId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var handler = ActivatorUtilities.CreateInstance<AteraCreateTicketHandler>(scope.ServiceProvider);
        return await handler.ExecuteAsync(new OutboundOperation
        {
            Id = Guid.NewGuid(), System = "atera", Operation = AteraTypes.CreateTicket, EntityType = EntityTypes.TicketRequest, EntityId = requestId, IdempotencyKey = "test",
        }, Ct);
    }

    /// <summary>A property of the body Atera received, whatever its casing (the client writes camelCase, Atera reads either).</summary>
    private static JsonElement PostedProperty(WireMockServer atera, string path, string name) =>
        JsonDocument.Parse(atera.LogEntries.Single(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == path).RequestMessage!.Body!)
            .RootElement.EnumerateObject().Single(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)).Value;

    private static string PostedDescription(WireMockServer atera) => PostedProperty(atera, "/api/v3/tickets", "Description").GetString()!;

    private async Task<(Guid RequestId, long CustomerId, long ContactId)> TicketScenarioAsync(TestHost host)
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var (organizationId, customerId) = await LinkedOrganizationAsync(admin, $"Tikett {Guid.NewGuid():N}"[..24]);
        var contactId = await CreateContactAsync(admin, organizationId, $"kari.{Guid.NewGuid():N}"[..20] + "@example.no");
        var ateraContactId = Random.Shared.NextInt64(30_000, 39_999);
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
        {
            system = "atera", externalType = "Contact", externalId = ateraContactId.ToString(CultureInfo.InvariantCulture), entityId = contactId,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        // A stored global contact link does not prove which Atera customer currently owns that contact.
        host.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingGet())
            .RespondWith(JsonReply(new { items = new object[] { new { EndUserID = ateraContactId, CustomerID = customerId } }, totalPages = 1 }));
        return (await CreateRequestAsync(host, organizationId, contactId), customerId, ateraContactId);
    }

    [Fact]
    public async Task A_ticket_whose_answer_was_lost_is_found_by_its_marker_and_not_sent_again()
    {
        await using var host = Host();
        var (requestId, customerId, _) = await TicketScenarioAsync(host);
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingPost()).RespondWith(Response.Create().WithFault(FaultType.EMPTY_RESPONSE));

        await Should.ThrowAsync<Exception>(() => RunCreateTicketAsync(host, requestId));

        Count(host.Atera, "POST", "/api/v3/tickets").ShouldBe(1);
        PostedDescription(host.Atera).ShouldContain($"[CRM-TR:{requestId:D}]");
        (await RequestAsync(host, requestId)).Status.ShouldBe(TicketRequestStatus.Pending);

        // The ticket did get created: it is among the customer's tickets, carrying the marker.
        host.Atera.Given(Request.Create().WithPath($"/api/v3/tickets/customer/{customerId}").UsingGet()).RespondWith(JsonReply(new
        {
            items = new object[]
            {
                new { TicketID = 4242, CustomerID = customerId, TicketTitle = "Printer is down", TicketDescription = PostedDescription(host.Atera), TicketCreatedDate = DateTimeOffset.UtcNow },
            },
            totalPages = 1,
        }));

        var result = await RunCreateTicketAsync(host, requestId);

        result.Reference.ShouldBe("4242");
        Count(host.Atera, "POST", "/api/v3/tickets").ShouldBe(1);
        var request = await RequestAsync(host, requestId);
        request.Status.ShouldBe(TicketRequestStatus.Created);
        request.ExternalTicketId.ShouldBe(4242);
    }

    [Fact]
    public async Task A_ticket_that_cannot_be_found_after_a_lost_answer_waits_for_a_person_and_is_never_sent_twice()
    {
        await using var host = Host();
        var (requestId, customerId, _) = await TicketScenarioAsync(host);
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingPost()).RespondWith(Response.Create().WithFault(FaultType.EMPTY_RESPONSE));
        host.Atera.Given(Request.Create().WithPath($"/api/v3/tickets/customer/{customerId}").UsingGet())
            .RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));

        await Should.ThrowAsync<Exception>(() => RunCreateTicketAsync(host, requestId));
        var held = await Should.ThrowAsync<PermanentOutboundException>(() => RunCreateTicketAsync(host, requestId));

        held.Message.ShouldContain($"[CRM-TR:{requestId:D}]");
        Count(host.Atera, "POST", "/api/v3/tickets").ShouldBe(1);
        var request = await RequestAsync(host, requestId);
        request.Status.ShouldBe(TicketRequestStatus.Failed);
        request.Error!.ShouldContain("check Atera");

        // Failed is final for the queue: a further run sends nothing either.
        (await RunCreateTicketAsync(host, requestId)).ShouldBeSameAs(OutboundResult.NothingToDo);
        Count(host.Atera, "POST", "/api/v3/tickets").ShouldBe(1);
    }

    [Fact]
    public async Task A_ticket_id_the_journal_holds_completes_the_request_when_the_local_write_was_lost()
    {
        await using var host = Host();
        var (requestId, _, _) = await TicketScenarioAsync(host);
        // The ticket was created and its id journaled, then the write that completes the request failed.
        var journal = host.Services.GetRequiredService<IExternalEffectJournal>();
        var effect = await journal.BeginAsync(new ExternalEffect("atera", AteraCreateTicketHandler.TicketEffect, EntityTypes.TicketRequest, requestId), Ct);
        await journal.CompleteAsync(effect, EffectPhase.Sent, "5150", Ct);

        var result = await RunCreateTicketAsync(host, requestId);

        result.Reference.ShouldBe("5150");
        Count(host.Atera, "POST", "/api/v3/tickets").ShouldBe(0);
        Count(host.Atera, "GET", "/api/v3/tickets/customer/0").ShouldBe(0);
        (await RequestAsync(host, requestId)).ExternalTicketId.ShouldBe(5150);
    }

    [Fact]
    public async Task A_ticket_is_journaled_with_its_id_before_the_request_is_completed()
    {
        await using var host = Host();
        var (requestId, _, _) = await TicketScenarioAsync(host);
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingPost()).RespondWith(JsonReply(new { ActionID = 6001 }));

        var result = await RunCreateTicketAsync(host, requestId);

        result.Reference.ShouldBe("6001");
        var entries = (await host.Services.GetRequiredService<IExternalEffectJournal>().ForEntityAsync(EntityTypes.TicketRequest, requestId, Ct))
            .Where(e => e.Kind == AteraCreateTicketHandler.TicketEffect).ToList();
        entries.Select(e => e.Phase).ShouldBe([EffectPhase.Sending, EffectPhase.Sent]);
        entries[^1].Reference.ShouldBe("6001");
        (await RequestAsync(host, requestId)).Status.ShouldBe(TicketRequestStatus.Created);
    }

    [Fact]
    public async Task A_contact_whose_answer_was_lost_is_found_by_its_email_and_linked_before_the_ticket_is_sent()
    {
        await using var host = Host();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var (organizationId, customerId) = await LinkedOrganizationAsync(admin, $"Kontakt {Guid.NewGuid():N}"[..24]);
        var email = $"ola.{Guid.NewGuid():N}"[..20] + "@example.no";
        var contactId = await CreateContactAsync(admin, organizationId, email);
        var requestId = await CreateRequestAsync(host, organizationId, contactId);
        host.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingPost()).RespondWith(Response.Create().WithFault(FaultType.EMPTY_RESPONSE));

        await Should.ThrowAsync<Exception>(() => RunCreateTicketAsync(host, requestId));

        // The contact exists in Atera; the retry finds it by customer and e-mail instead of creating another.
        host.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingGet().WithParam("page", "1")).RespondWith(JsonReply(new
        {
            items = new object[] { new { EndUserID = 7007, CustomerID = customerId, Firstname = "Kari", Lastname = "Kunde", Email = email.ToUpperInvariant() } },
            totalPages = 1,
        }));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingPost()).RespondWith(JsonReply(new { ActionID = 6002 }));

        await RunCreateTicketAsync(host, requestId);

        Count(host.Atera, "POST", "/api/v3/contacts").ShouldBe(1);
        Count(host.Atera, "POST", "/api/v3/tickets").ShouldBe(1);
        PostedProperty(host.Atera, "/api/v3/tickets", "EndUserID").GetInt64().ShouldBe(7007);
        await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.AsNoTracking()
            .AnyAsync(l => l.System == "atera" && l.ExternalType == "Contact" && l.EntityId == contactId && l.ExternalId == "7007", Ct)).ShouldBeTrue();
    }

    [Fact]
    public async Task A_contact_that_cannot_be_found_after_a_lost_answer_fails_the_request_without_a_second_create()
    {
        await using var host = Host();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var (organizationId, _) = await LinkedOrganizationAsync(admin, $"Kontakt {Guid.NewGuid():N}"[..24]);
        var contactId = await CreateContactAsync(admin, organizationId, $"per.{Guid.NewGuid():N}"[..20] + "@example.no");
        var requestId = await CreateRequestAsync(host, organizationId, contactId);
        host.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingPost()).RespondWith(Response.Create().WithFault(FaultType.EMPTY_RESPONSE));
        host.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingGet()).RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));

        await Should.ThrowAsync<Exception>(() => RunCreateTicketAsync(host, requestId));
        await Should.ThrowAsync<PermanentOutboundException>(() => RunCreateTicketAsync(host, requestId));

        Count(host.Atera, "POST", "/api/v3/contacts").ShouldBe(1);
        Count(host.Atera, "POST", "/api/v3/tickets").ShouldBe(0);
        (await RequestAsync(host, requestId)).Status.ShouldBe(TicketRequestStatus.Failed);
    }

    private static async Task<OutboundResult> RunCreateCustomerAsync(TestHost host, Guid organizationId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var handler = ActivatorUtilities.CreateInstance<AteraCreateCustomerHandler>(scope.ServiceProvider);
        return await handler.ExecuteAsync(new OutboundOperation
        {
            Id = Guid.NewGuid(), System = "atera", Operation = AteraTypes.CreateCustomer, EntityType = EntityTypes.Organization, EntityId = organizationId, IdempotencyKey = "test",
        }, Ct);
    }

    [Fact]
    public async Task A_customer_whose_answer_was_lost_is_found_by_business_number_and_linked_without_a_second_create()
    {
        await using var host = Host();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"Ny kunde {Guid.NewGuid():N}"[..24], orgNumber, status = "Customer" });
        var ateraId = Random.Shared.NextInt64(900_000, 999_999);
        host.Atera.Given(Request.Create().WithPath("/api/v3/customers").UsingPost()).RespondWith(Response.Create().WithFault(FaultType.EMPTY_RESPONSE));

        await Should.ThrowAsync<Exception>(() => RunCreateCustomerAsync(host, organizationId));

        host.Atera.Given(Request.Create().WithPath("/api/v3/customers").UsingGet().WithParam("page", "1")).RespondWith(JsonReply(new
        {
            items = new object[] { new { CustomerID = ateraId, CustomerName = "Whatever", BusinessNumber = $"NO {orgNumber} MVA" } },
            totalPages = 1,
        }));
        host.Atera.Given(Request.Create().WithPath($"/api/v3/customers/{ateraId}").UsingGet())
            .RespondWith(JsonReply(new { CustomerID = ateraId, CustomerName = "Whatever", BusinessNumber = $"NO {orgNumber} MVA" }));

        var result = await RunCreateCustomerAsync(host, organizationId);

        result.Reference.ShouldBe(ateraId.ToString(CultureInfo.InvariantCulture));
        Count(host.Atera, "POST", "/api/v3/customers").ShouldBe(1);
        var links = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/integrations/links?entityType=Organization&entityId={organizationId}", Ct);
        links.EnumerateArray().ShouldHaveSingleItem().GetProperty("externalId").GetString().ShouldBe(ateraId.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task A_customer_that_cannot_be_found_after_a_lost_answer_is_not_created_again()
    {
        await using var host = Host();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"Ukjent kunde {Guid.NewGuid():N}"[..24], orgNumber = TestData.OrgNumber(), status = "Customer" });
        host.Atera.Given(Request.Create().WithPath("/api/v3/customers").UsingPost()).RespondWith(Response.Create().WithFault(FaultType.EMPTY_RESPONSE));
        host.Atera.Given(Request.Create().WithPath("/api/v3/customers").UsingGet()).RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));

        await Should.ThrowAsync<Exception>(() => RunCreateCustomerAsync(host, organizationId));
        var held = await Should.ThrowAsync<PermanentOutboundException>(() => RunCreateCustomerAsync(host, organizationId));

        held.Message.ShouldContain("check Atera");
        Count(host.Atera, "POST", "/api/v3/customers").ShouldBe(1);
    }

    [Fact]
    public async Task A_write_throttled_with_429_is_repeated_and_a_write_answered_with_503_is_sent_once()
    {
        await using var host = Host();
        const string scenario = "throttled";
        host.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingPost()).InScenario(scenario).WillSetStateTo("second")
            .RespondWith(Response.Create().WithStatusCode(429));
        host.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingPost()).InScenario(scenario).WhenStateIs("second").WillSetStateTo("third")
            .RespondWith(Response.Create().WithStatusCode(429));
        host.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingPost()).InScenario(scenario).WhenStateIs("third")
            .RespondWith(JsonReply(new { ActionID = 77 }));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingPost()).RespondWith(Response.Create().WithStatusCode(503));

        await using var scope = host.Services.CreateAsyncScope();
        var client = scope.ServiceProvider.GetRequiredService<IAteraClient>();
        (await client.CreateContactAsync(new AteraContactWrite(1, "A", "B", null, null), Ct)).ShouldBe(77);
        Count(host.Atera, "POST", "/api/v3/contacts").ShouldBe(3);

        await Should.ThrowAsync<AteraApiException>(() => client.CreateTicketAsync(new AteraTicketWrite("t", "d", "High", "Minor", "Open", "Incident", 1), Ct));
        Count(host.Atera, "POST", "/api/v3/tickets").ShouldBe(1);
    }

    [Fact]
    public async Task A_read_throttled_twice_succeeds_and_one_that_stays_throttled_fails_the_sync_without_moving_the_mirror()
    {
        await using var host = Host();
        const string scenario = "tickets";
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet()).InScenario(scenario).WillSetStateTo("second")
            .RespondWith(Response.Create().WithStatusCode(429));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet()).InScenario(scenario).WhenStateIs("second").WillSetStateTo("third")
            .RespondWith(Response.Create().WithStatusCode(429));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet()).InScenario(scenario).WhenStateIs("third")
            .RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var read = new List<AteraTicket>();
            await foreach (var ticket in scope.ServiceProvider.GetRequiredService<IAteraClient>().GetTicketsAsync("Open", Ct))
            {
                read.Add(ticket);
            }

            read.ShouldBeEmpty();
        }

        Count(host.Atera, "GET", "/api/v3/tickets").ShouldBe(3);

        host.Atera.Reset();
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet()).RespondWith(Response.Create().WithStatusCode(429));
        var startedAt = DateTimeOffset.UtcNow;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await Should.ThrowAsync<SyncFailedException>(() => scope.ServiceProvider.GetRequiredService<AteraTicketSyncJob>().RunAsync(false, Ct));
        }

        // One try and four repeats, then the run is recorded as failed: no partial list reached the mirror.
        Count(host.Atera, "GET", "/api/v3/tickets").ShouldBe(5);
        await using var check = host.Services.CreateAsyncScope();
        var runs = await check.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .Where(r => r.System == "atera" && r.Job == AteraTicketSyncJob.OpenJobId && r.StartedAt >= startedAt && r.Status == SyncRunStatus.Failed)
            .ToListAsync(Ct);
        runs.ShouldNotBeEmpty();
        runs.ShouldAllBe(r => r.Changed == 0);
    }

    [Fact]
    public async Task The_work_hours_of_every_page_are_read_and_a_ticket_that_cannot_be_read_does_not_cost_the_others()
    {
        await using var host = Host();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var (organizationId, customerId) = await LinkedOrganizationAsync(admin, $"Timer {Guid.NewGuid():N}"[..24]);
        long Id() => Random.Shared.NextInt64(1_000_000, 8_999_999);
        long good = Id(), broken = good + 1;
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("ticketStatus", "Open")).RespondWith(JsonReply(new
        {
            items = new object[]
            {
                new { TicketID = good, CustomerID = customerId, TicketTitle = "Good", TicketStatus = "Open", TicketCreatedDate = DateTimeOffset.UtcNow.AddDays(-1) },
                new { TicketID = broken, CustomerID = customerId, TicketTitle = "Broken", TicketStatus = "Open", TicketCreatedDate = DateTimeOffset.UtcNow.AddDays(-1) },
            },
            totalPages = 1,
        }));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("ticketStatus", "Pending"))
            .RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));
        await RunTicketSyncAsync(host);

        // Page one holds a usable row and one without a duration; page two (page size 2 in the tests) holds the rest.
        host.Atera.Given(Request.Create().WithPath($"/api/v3/tickets/{good}/workhoursrecords").UsingGet().WithParam("page", "1")).RespondWith(JsonReply(new
        {
            items = new object[]
            {
                new { WorkHoursID = $"wh-{good}-1", TimeSpentInMinutes = 60, TechnicianFullName = "Tor", Billable = true },
                new { WorkHoursID = $"wh-{good}-empty", TimeSpentInMinutes = 0 },
            },
            totalPages = 2,
        }));
        host.Atera.Given(Request.Create().WithPath($"/api/v3/tickets/{good}/workhoursrecords").UsingGet().WithParam("page", "2")).RespondWith(JsonReply(new
        {
            items = new object[] { new { WorkHoursID = $"wh-{good}-2", TimeSpentInMinutes = 30, TechnicianFullName = "Tor", Billable = true } },
            totalPages = 2,
        }));
        host.Atera.Given(Request.Create().WithPath($"/api/v3/tickets/{broken}/workhoursrecords").UsingGet()).RespondWith(Response.Create().WithStatusCode(500));

        var startedAt = DateTimeOffset.UtcNow;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<AteraWorkHoursSyncJob>().RunAsync(Ct);
        }

        Count(host.Atera, "GET", $"/api/v3/tickets/{good}/workhoursrecords").ShouldBe(2);
        // The broken ticket was tried and retried (one try, four repeats) before it was given up.
        Count(host.Atera, "GET", $"/api/v3/tickets/{broken}/workhoursrecords").ShouldBe(5);
        var entries = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/time/entries?organizationId={organizationId}", Ct);
        entries.GetProperty("items").EnumerateArray().Select(e => e.GetProperty("hours").GetDecimal()).Order().ShouldBe([0.5m, 1m]);

        await using var check = host.Services.CreateAsyncScope();
        var run = await check.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .Where(r => r.System == "atera" && r.Job == AteraWorkHoursSyncJob.JobId && r.StartedAt >= startedAt && r.Message!.Contains("rows without duration 1"))
            .SingleAsync(Ct);
        // One unreadable ticket and one row without a duration: the pass is not a complete success, so freshness does not advance.
        run.Failed.ShouldBe(2);
        run.Status.ShouldBe(SyncRunStatus.Succeeded);
        run.Message!.ShouldContain("tickets unreadable 1");
    }

    private static async Task RunTicketSyncAsync(TestHost host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<AteraTicketSyncJob>().RunAsync(false, Ct);
    }

    [Fact]
    public async Task The_recent_pass_keeps_reading_past_an_old_ticket_until_whole_pages_are_outside_the_window()
    {
        await using var host = Host();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var (_, customerId) = await LinkedOrganizationAsync(admin, $"Siste {Guid.NewGuid():N}"[..24]);
        var baseId = Random.Shared.NextInt64(2_000_000, 2_900_000);
        object Ticket(long id, int daysOld, int activityDaysOld) => new
        {
            TicketID = id, CustomerID = customerId, TicketTitle = $"T{id}", TicketStatus = "Closed",
            TicketCreatedDate = DateTimeOffset.UtcNow.AddDays(-daysOld), LastTechnicianCommentTimestamp = DateTimeOffset.UtcNow.AddDays(-activityDaysOld),
        };

        // Page size is 2 and the stop is three pages (6 tickets). An old ticket with recent activity sits behind two old ones.
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("page", "1")).RespondWith(JsonReply(new
            { items = new[] { Ticket(baseId, 1, 1), Ticket(baseId + 1, 200, 200) }, totalPages = 6 }));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("page", "2")).RespondWith(JsonReply(new
            { items = new[] { Ticket(baseId + 2, 200, 200), Ticket(baseId + 3, 200, 1) }, totalPages = 6 }));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("page", "3")).RespondWith(JsonReply(new
            { items = new[] { Ticket(baseId + 4, 300, 300), Ticket(baseId + 5, 300, 300) }, totalPages = 6 }));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("page", "4")).RespondWith(JsonReply(new
            { items = new[] { Ticket(baseId + 6, 300, 300), Ticket(baseId + 7, 300, 300) }, totalPages = 6 }));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("page", "5")).RespondWith(JsonReply(new
            { items = new[] { Ticket(baseId + 8, 300, 300), Ticket(baseId + 9, 300, 300) }, totalPages = 6 }));
        host.Atera.Given(Request.Create().WithPath("/api/v3/tickets").UsingGet().WithParam("page", "6")).RespondWith(JsonReply(new
            { items = new[] { Ticket(baseId + 10, 1, 1), Ticket(baseId + 11, 1, 1) }, totalPages = 6 }));

        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<AteraTicketSyncJob>().RunAsync(true, Ct);
        }

        // The old ticket with recent activity (baseId + 3) was kept although two old tickets came before it; the scan stopped in
        // the long run of old pages, so page 6 was never asked for.
        await using var check = host.Services.CreateAsyncScope();
        var service = check.ServiceProvider.GetRequiredService<Crm.Service.Contracts.IServiceApi>();
        var mirrored = await service.GetTicketsAsync("atera", [baseId, baseId + 1, baseId + 3, baseId + 10], Ct);
        mirrored.Keys.Order().ShouldBe([baseId, baseId + 3]);
        Count(host.Atera, "GET", "/api/v3/tickets").ShouldBeLessThan(12);
        host.Atera.LogEntries.ShouldNotContain(e => e.RequestMessage!.Path == "/api/v3/tickets" && e.RequestMessage.Query!.ContainsKey("page") && e.RequestMessage.Query["page"].Contains("6"));
    }
}
