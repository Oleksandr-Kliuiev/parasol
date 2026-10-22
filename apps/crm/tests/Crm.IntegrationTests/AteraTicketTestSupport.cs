using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>A ticket of the tests: its CRM organization, the Atera customer it belongs to, its Atera id and its mirror row.</summary>
internal sealed record TestTicket(Guid OrganizationId, long CustomerId, long TicketId, Guid MirrorId);

/// <summary>
/// A CRM host of its own talking to an Atera stub of its own (M39.2), with the action switches of the test, so faults and counts never
/// mix with other tests. The clients sign in as one user per host, who can be mapped to an Atera technician.
/// </summary>
internal sealed class AteraTicketHost(WebApplicationFactory<Program> host, WireMockServer atera, string user) : IAsyncDisposable
{
    /// <summary>The Atera technician this host's user writes as; one per host, because a technician maps to the first user it is seen with.</summary>
    public long Technician { get; } = TestData.AteraId();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public IServiceProvider Services => host.Services;

    public WireMockServer Atera => atera;

    public string User => user;

    public static AteraTicketHost Start(CrmWebFactory factory, bool write = true, bool dryRun = false, string[]? kinds = null)
    {
        var atera = WireMockServer.Start();
        var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Integrations:Atera:BaseUrl", atera.Url + "/api/v3/");
            builder.UseSetting("Integrations:Atera:WriteEnabled", write ? "true" : "false");
            builder.UseSetting("Integrations:Atera:DryRun", dryRun ? "true" : "false");
            builder.UseSetting("Integrations:Atera:RetryDelay", "00:00:00.020");
            var enabled = kinds ?? AteraTicketKinds.All;
            for (var i = 0; i < enabled.Length; i++)
            {
                builder.UseSetting($"Integrations:Atera:EnabledActions:{i}", enabled[i]);
            }
        });
        return new AteraTicketHost(host, atera, $"tickets-{Guid.NewGuid():N}"[..20]);
    }

    public HttpClient Client(string role = CrmRoles.Admin)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, user);
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    /// <summary>A linked organization with one mirrored open ticket (at <paramref name="url"/> in Atera); the stub answers the ticket's live read.</summary>
    public async Task<TestTicket> TicketAsync(string status = "Open", string priority = "Medium", long? technician = 4001, string? url = null)
    {
        var admin = Client();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"Sak {Guid.NewGuid():N}"[..20], status = "Customer" });
        var customerId = TestData.AteraId();
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
        {
            system = "atera", externalType = "Customer", externalId = customerId.ToString(CultureInfo.InvariantCulture), entityId = organizationId,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var ticketId = TestData.AteraId();
        await using var scope = host.Services.CreateAsyncScope();
        var link = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.AsNoTracking()
            .SingleAsync(l => l.System == "atera" && l.ExternalType == "Customer" && l.ExternalId == customerId.ToString(CultureInfo.InvariantCulture), Ct);
        var service = scope.ServiceProvider.GetRequiredService<IServiceApi>();
        await service.UpsertTicketsAsync([new ExternalTicket(
            "atera", ticketId, organizationId, null, "Printer is down", status, priority, null, "Incident", "Email", null,
            technician is null ? null : "Tor Tekniker", "Kari Kunde", "kari@example.no", DateTimeOffset.UtcNow.AddHours(-3), null, null, null, url,
            customerId, link.Id)], Ct);
        var mirror = (await service.GetTicketAsync("atera", ticketId, Ct))!.Id;
        Live(new TestTicket(organizationId, customerId, ticketId, mirror), status, priority, technician);
        return new TestTicket(organizationId, customerId, ticketId, mirror);
    }

    /// <summary>The stub of one route; a later stub of the same route replaces it (one mapping id per method and path).</summary>
    public IRespondWithAProvider On(string method, string path) =>
        atera.Given(Request.Create().WithPath(path).UsingMethod(method)).WithGuid(new Guid(SHA256.HashData(Encoding.UTF8.GetBytes($"{method} {path}"))[..16]));

    /// <summary>What Atera answers for the ticket now.</summary>
    public void Live(TestTicket ticket, string status = "Open", string priority = "Medium", long? technician = 4001, long? customer = null) =>
        On("GET", $"/api/v3/tickets/{ticket.TicketId}").RespondWith(JsonReply(new
        {
            TicketID = ticket.TicketId, CustomerID = customer ?? ticket.CustomerId, TicketTitle = "Printer is down", TicketStatus = status, TicketPriority = priority,
            TechnicianContactID = technician, TechnicianFullName = technician is null ? null : "Tor Tekniker", EndUserFirstName = "Kari", EndUserLastName = "Kunde",
            EndUserEmail = "kari@example.no", TicketCreatedDate = DateTimeOffset.UtcNow.AddHours(-3),
        }));

    /// <summary>Maps the Atera technician <see cref="Technician"/> to this host's user, as the ticket sync does by e-mail.</summary>
    public async Task MapTechnicianAsync()
    {
        (await Client().GetAsync("/api/v1/actions?limit=1", Ct)).EnsureSuccessStatusCode();
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<ITechnicianDirectory>().ResolveAsync(
            [new TechnicianRef("atera", Technician.ToString(CultureInfo.InvariantCulture), $"{user}@test.local", "Test Technician")], Ct);
    }

    /// <summary>Preview and command of a ticket action by this host's user; the action's id.</summary>
    public async Task<Guid> AskAsync(string kind, TestTicket ticket, object parameters)
    {
        var client = Client();
        var body = new { system = "atera", kind, targetType = "ticket", targetId = ticket.TicketId.ToString(CultureInfo.InvariantCulture), parameters };
        var preview = await (await client.PostAsJsonAsync("/api/v1/actions/preview", body, Ct)).ReadJsonAsync();
        preview.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null, preview.ToString());
        var command = await client.PostAsJsonAsync("/api/v1/actions", new
        {
            body.system, body.kind, body.targetType, body.targetId, parameters, previewToken = preview.GetProperty("previewToken").GetString(),
            commandKey = Guid.NewGuid(),
        }, Ct);
        command.StatusCode.ShouldBe(HttpStatusCode.Accepted, await command.Content.ReadAsStringAsync(Ct));
        return (await command.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    public async Task<VendorAction> RunAsync(Guid actionId)
    {
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var operation = (await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct)).OutboundOperationId;
            await host.Services.GetRequiredService<VendorActionRunner>().RunOneAsync(operation, Ct);
        }

        await using var read = host.Services.CreateAsyncScope();
        return await read.ServiceProvider.GetRequiredService<IntegrationDbContext>().VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct);
    }

    public int Count(string method, string path) =>
        atera.LogEntries.Count(e => e.RequestMessage!.Method == method && e.RequestMessage.Path == path);

    public JsonElement Posted(string path) =>
        JsonDocument.Parse(atera.LogEntries.Last(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == path).RequestMessage!.Body!).RootElement;

    public async ValueTask DisposeAsync()
    {
        await host.DisposeAsync();
        atera.Dispose();
    }
}
