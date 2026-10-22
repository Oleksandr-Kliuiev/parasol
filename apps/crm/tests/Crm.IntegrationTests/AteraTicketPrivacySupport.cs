using System.Globalization;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using Crm.Authorization;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.Integrations.Atera;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crm.IntegrationTests;

internal static class AteraTicketPrivacySupport
{
    private static long _nextId = 8_800_000;
    private static long NextId() => Interlocked.Increment(ref _nextId);
    internal static CancellationToken Ct => TestContext.Current.CancellationToken;
    internal sealed record Fixture(Guid OrganizationId, Guid OtherOrganizationId, Guid ContactId, Guid RequestId, long CustomerId, long EndUserId);

    internal static WebApplicationFactory<Program> Host(CrmWebFactory factory, Provider provider) => factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Integrations:Atera:WriteEnabled", "true");
        builder.ConfigureTestServices(services => { services.RemoveAll<IAteraClient>(); services.AddScoped<IAteraClient>(_ => provider); });
    });

    internal static async Task<Fixture> Create(CrmWebFactory factory, WebApplicationFactory<Program> host, Provider provider, bool linked)
    {
        using var admin = factory.ClientAs(CrmRoles.Admin);
        var org = await admin.CreateOrganizationAsync(new { name = "Ticket privacy " + Guid.NewGuid().ToString("N"), status = "Customer" });
        var other = await admin.CreateOrganizationAsync(new { name = "Other customer " + Guid.NewGuid().ToString("N"), status = "Customer" });
        var contact = (await (await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{org}/contacts", new
        { firstName = "Synthetic", lastName = "Person", email = Guid.NewGuid().ToString("N") + "@example.invalid", roles = Array.Empty<string>(), isPrimary = true }, Ct)).ReadJsonAsync()).GetProperty("contactId").GetGuid();
        var customerId = NextId(); var endUserId = NextId();
        await using var scope = host.Services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<ExternalLinkService>();
        (await links.LinkAsync(EntityTypes.Organization, org, "atera", "Customer", customerId.ToString(CultureInfo.InvariantCulture), LinkMethod.Manual, null, Ct)).IsSuccess.ShouldBeTrue();
        if (linked)
        {
            (await links.LinkAsync(EntityTypes.Contact, contact, "atera", "Contact", endUserId.ToString(CultureInfo.InvariantCulture), LinkMethod.Manual, null, Ct)).IsSuccess.ShouldBeTrue();
            provider.Contacts.Add(Person(endUserId, customerId));
        }
        var request = TicketRequest.Create(org, contact, "Synthetic private request", "Synthetic description", "High", "Incident");
        request.ClearDomainEvents();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>(); db.TicketRequests.Add(request); await db.SaveChangesAsync(Ct);
        return new(org, other, contact, request.Id, customerId, endUserId);
    }

    internal static AteraContact Person(long id, long customer, bool ignored = false) => new(id, customer, "Synthetic", "Person", null, null, null, null, ignored, null);
    internal static async Task<OutboundResult> Run(WebApplicationFactory<Program> host, Guid requestId, CancellationToken? cancellation = null)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await ActivatorUtilities.CreateInstance<AteraCreateTicketHandler>(scope.ServiceProvider).ExecuteAsync(new OutboundOperation
        { Id = Guid.NewGuid(), System = "atera", Operation = AteraTypes.CreateTicket, EntityType = EntityTypes.TicketRequest, EntityId = requestId, IdempotencyKey = "synthetic" }, cancellation ?? Ct);
    }
    internal static async Task Mutate(WebApplicationFactory<Program> host, Fixture f, string kind)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
        var contact = await db.Contacts.IgnoreQueryFilters().Include(c => c.Affiliations).SingleAsync(c => c.Id == f.ContactId, Ct);
        switch (kind)
        {
            case "deleted-contact": contact.MarkDeleted(); break;
            case "foreign":
                contact.Affiliations.Single(a => a.OrganizationId == f.OrganizationId).MarkDeleted();
                contact.Affiliate(f.OtherOrganizationId, new AffiliationDetails(null, ContactRoles.None, false)).IsSuccess.ShouldBeTrue(); break;
            case "inactive": contact.UpdateAffiliation(f.OrganizationId, new AffiliationDetails(null, ContactRoles.None, false, false)).IsSuccess.ShouldBeTrue(); break;
            case "deleted-affiliation": contact.Affiliations.Single(a => a.OrganizationId == f.OrganizationId).MarkDeleted(); break;
            case "deleted-customer": (await db.Organizations.SingleAsync(o => o.Id == f.OrganizationId, Ct)).MarkDeleted(); break;
            case "merged-customer":
                var organization = await db.Organizations.SingleAsync(o => o.Id == f.OrganizationId, Ct);
                organization.MarkMergedInto(Guid.NewGuid(), f.OtherOrganizationId); organization.ClearDomainEvents(); break;
            case "relinked-customer":
                var links = scope.ServiceProvider.GetRequiredService<ExternalLinkService>();
                var old = (await links.FindByEntityAsync(EntityTypes.Organization, f.OrganizationId, "atera", "Customer", Ct))!;
                await links.UnlinkAsync(old.Id, Ct);
                (await links.LinkAsync(EntityTypes.Organization, f.OrganizationId, "atera", "Customer", old.ExternalId, LinkMethod.Manual, null, Ct)).IsSuccess.ShouldBeTrue();
                break;
            case "relinked-contact":
            case "rebound-contact":
                var contacts = scope.ServiceProvider.GetRequiredService<ExternalLinkService>();
                var previous = (await contacts.FindByEntityAsync(EntityTypes.Contact, f.ContactId, "atera", "Contact", Ct))!;
                await contacts.UnlinkAsync(previous.Id, Ct);
                (await contacts.LinkAsync(EntityTypes.Contact, f.ContactId, "atera", "Contact", kind == "relinked-contact" ? previous.ExternalId : NextId().ToString(CultureInfo.InvariantCulture), LinkMethod.Manual, null, Ct)).IsSuccess.ShouldBeTrue();
                break;
            default: throw new InvalidOperationException("Unknown synthetic mutation.");
        }
        contact.ClearDomainEvents(); await db.SaveChangesAsync(Ct);
    }
    internal static async Task<TicketRequest> Request(WebApplicationFactory<Program> host, Guid id)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().TicketRequests.AsNoTracking().SingleAsync(r => r.Id == id, Ct);
    }

    internal sealed class Provider : IAteraClient
    {
        internal List<AteraContact> Contacts { get; } = [];
        internal List<AteraTicket> Tickets { get; } = [];
        internal List<AteraContactWrite> ContactWrites { get; } = [];
        internal List<AteraTicketWrite> TicketWrites { get; } = [];
        internal long NewContactId { get; set; } = NextId();
        internal Func<Task>? BeforeOwnerRead { get; set; }
        internal Func<Task>? AfterContactCreate { get; set; }
        internal int OwnerRows { get; private set; }
        internal int OwnerReads { get; private set; }
        public async IAsyncEnumerable<AteraContact> GetContactsAsync([EnumeratorCancellation] CancellationToken ct)
        {
            OwnerReads++; if (BeforeOwnerRead is { } action) await action();
            foreach (var contact in Contacts) { ct.ThrowIfCancellationRequested(); OwnerRows++; yield return contact; }
        }
        public Task<AteraTicket?> GetTicketAsync(long ticketId, CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraTicket> GetModifiedTicketsAsync(DateTimeOffset since, CancellationToken ct) => throw new NotSupportedException();
        public Task<IReadOnlyList<AteraComment>> GetTicketCommentsAsync(long ticketId, CancellationToken ct) => throw new NotSupportedException();
        public Task<string?> CreateTicketCommentAsync(long ticketId, AteraCommentWrite comment, CancellationToken ct) => throw new NotSupportedException();
        public Task UpdateTicketAsync(long ticketId, AteraTicketUpdate update, CancellationToken ct) => throw new NotSupportedException();
        public Task<string?> CreateWorkHoursAsync(long ticketId, AteraWorkHoursWrite hours, CancellationToken ct) => throw new NotSupportedException();
        public async Task<long> CreateContactAsync(AteraContactWrite contact, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested(); ContactWrites.Add(contact); Contacts.Add(Person(NewContactId, contact.CustomerID));
            if (AfterContactCreate is { } action) await action(); return NewContactId;
        }
        public Task<long> CreateTicketAsync(AteraTicketWrite ticket, CancellationToken ct)
        { ct.ThrowIfCancellationRequested(); TicketWrites.Add(ticket); return Task.FromResult(NextId()); }
        public async IAsyncEnumerable<AteraTicket> GetCustomerTicketsAsync(long customerId, [EnumeratorCancellation] CancellationToken ct)
        { await Task.CompletedTask; foreach (var ticket in Tickets) { ct.ThrowIfCancellationRequested(); yield return ticket; } }
        public IAsyncEnumerable<AteraCustomer> GetCustomersAsync(CancellationToken ct) => throw new NotSupportedException();
        public Task<AteraCustomer?> GetCustomerAsync(long id, CancellationToken ct) => throw new NotSupportedException();
        public Task<long> CreateCustomerAsync(AteraCustomerWrite customer, CancellationToken ct) => throw new NotSupportedException();
        public Task UpdateCustomerAsync(long id, AteraCustomerWrite customer, CancellationToken ct) => throw new NotSupportedException();
        public Task<string?> GetCustomerFieldAsync(long id, string field, CancellationToken ct) => throw new NotSupportedException();
        public Task SetCustomerFieldAsync(long id, string field, string value, CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraTicket> GetTicketsAsync(string? status, CancellationToken ct) => throw new NotSupportedException();
        public Task<AteraWorkHoursResult> GetWorkHoursAsync(long id, CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken ct) => throw new NotSupportedException();
        public Task<AteraPatchList?> GetPatchesAsync(string deviceGuid, bool installed, CancellationToken ct) => throw new NotSupportedException();
    }
}
