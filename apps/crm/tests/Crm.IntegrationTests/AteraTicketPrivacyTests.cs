using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.AteraTicketPrivacySupport;

namespace Crm.IntegrationTests;

[Collection(AteraCollection.Name)]
public class AteraTicketPrivacyTests(CrmWebFactory factory)
{
    [Theory]
    [InlineData("missing-contact")]
    [InlineData("deleted-contact")]
    [InlineData("foreign")]
    [InlineData("inactive")]
    [InlineData("deleted-affiliation")]
    [InlineData("deleted-customer")]
    [InlineData("merged-customer")]
    public async Task Admission_refuses_unusable_customer_contacts_without_storing_a_request_or_event(string kind)
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, false);
        if (kind != "missing-contact") await Mutate(host, f, kind);
        using var admin = factory.ClientAs(CrmRoles.Admin);
        (await admin.GetAsync("/bff/user", Ct)).EnsureSuccessStatusCode();
        await using var scope = host.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var requests = await db.TicketRequests.CountAsync(r => r.OrganizationId == f.OrganizationId, Ct);
        // This customer's events only: other classes store alerts at the same time, and an urgent one queues an event too (M43).
        var events = await db.OutboxMessages.CountAsync(m => m.Payload.Contains(f.OrganizationId.ToString()), Ct);
        var result = await admin.PostAsJsonAsync("/api/v1/service/ticket-requests", new
        { organizationId = f.OrganizationId, contactId = kind == "missing-contact" ? Guid.NewGuid() : f.ContactId,
          title = "Refused request", description = "Synthetic description", priority = "High", type = "Incident" }, Ct);
        result.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        var body = await result.ReadJsonAsync();
        body.GetProperty("code").GetString().ShouldBe(kind is "deleted-customer" or "merged-customer" ? "SRV_UNKNOWN_ORGANIZATION" : "SRV_CONTACT_UNAVAILABLE");
        if (kind is not ("deleted-customer" or "merged-customer"))
            body.GetProperty("errors").GetProperty("ContactId").EnumerateArray().ShouldHaveSingleItem().GetString()
                .ShouldBe("Choose an active contact of this customer.");
        (await db.TicketRequests.CountAsync(r => r.OrganizationId == f.OrganizationId, Ct)).ShouldBe(requests);
        (await db.OutboxMessages.CountAsync(m => m.Payload.Contains(f.OrganizationId.ToString()), Ct)).ShouldBe(events);
        provider.ContactWrites.ShouldBeEmpty(); provider.TicketWrites.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(false, "deleted-contact")]
    [InlineData(true, "deleted-contact")]
    [InlineData(false, "foreign")]
    [InlineData(true, "foreign")]
    [InlineData(false, "inactive")]
    [InlineData(true, "inactive")]
    [InlineData(false, "deleted-affiliation")]
    [InlineData(true, "deleted-affiliation")]
    [InlineData(false, "deleted-customer")]
    [InlineData(true, "deleted-customer")]
    [InlineData(false, "merged-customer")]
    [InlineData(true, "merged-customer")]
    public async Task A_queued_request_rechecks_current_customer_and_affiliation_even_with_a_contact_link(bool linked, string kind)
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, linked);
        await Mutate(host, f, kind);
        await Should.ThrowAsync<PermanentOutboundException>(() => Run(host, f.RequestId));
        (await Request(host, f.RequestId)).Status.ShouldBe(TicketRequestStatus.Failed);
        provider.OwnerReads.ShouldBe(0); provider.ContactWrites.ShouldBeEmpty(); provider.TicketWrites.ShouldBeEmpty();
        (await Run(host, f.RequestId)).ShouldBeSameAs(OutboundResult.NothingToDo);
    }

    [Theory]
    [InlineData(false, "foreign")]
    [InlineData(false, "ignored")]
    [InlineData(false, "unknown")]
    [InlineData(true, "foreign")]
    [InlineData(true, "ignored")]
    [InlineData(true, "unknown")]
    public async Task Linked_and_known_journal_contacts_require_exact_current_atera_customer_ownership(bool journalReference, string owner)
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, !journalReference);
        provider.Contacts.Clear();
        if (owner != "unknown") provider.Contacts.Add(Person(f.EndUserId, owner == "foreign" ? f.CustomerId + 1 : f.CustomerId, owner == "ignored"));
        // The person may legitimately work for two CRM customers; the global Atera link still belongs to only one.
        if (owner == "foreign")
        {
            await using var scope = host.Services.CreateAsyncScope();
            var customers = scope.ServiceProvider.GetRequiredService<Crm.Customers.Contracts.ICustomersApi>();
            var contact = (await customers.GetContactForSyncAsync(f.ContactId, Ct))!;
            await customers.ImportContactAsync(f.OtherOrganizationId, new(contact.FirstName, contact.LastName, contact.Email, null, null, null), Ct);
        }
        var journal = host.Services.GetRequiredService<IExternalEffectJournal>();
        if (journalReference)
        {
            var effect = await journal.BeginAsync(new("atera", AteraCreateTicketHandler.ContactEffect, EntityTypes.Contact, f.ContactId), Ct);
            await journal.CompleteAsync(effect, EffectPhase.Sent, f.EndUserId.ToString(CultureInfo.InvariantCulture), Ct);
        }
        await Should.ThrowAsync<PermanentOutboundException>(() => Run(host, f.RequestId));
        provider.ContactWrites.ShouldBeEmpty(); provider.TicketWrites.ShouldBeEmpty();
        await using var check = host.Services.CreateAsyncScope();
        var link = await check.ServiceProvider.GetRequiredService<ExternalLinkService>().FindByEntityAsync(EntityTypes.Contact, f.ContactId, "atera", "Contact", Ct);
        if (journalReference) link.ShouldBeNull(); else link!.ExternalId.ShouldBe(f.EndUserId.ToString(CultureInfo.InvariantCulture));
        if (journalReference) (await journal.ForEntityAsync(EntityTypes.Contact, f.ContactId, Ct)).Count(e => e.Phase == EffectPhase.Sent).ShouldBe(1);
    }

    [Theory]
    [InlineData("inactive")]
    [InlineData("deleted-contact")]
    [InlineData("deleted-customer")]
    [InlineData("merged-customer")]
    [InlineData("relinked-customer")]
    public async Task Changes_after_creating_a_contact_preserve_its_journal_but_block_the_new_ticket(string kind)
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, false);
        provider.AfterContactCreate = () => Mutate(host, f, kind);
        await Should.ThrowAsync<PermanentOutboundException>(() => Run(host, f.RequestId));
        provider.ContactWrites.ShouldHaveSingleItem(); provider.TicketWrites.ShouldBeEmpty();
        var entries = await host.Services.GetRequiredService<IExternalEffectJournal>().ForEntityAsync(EntityTypes.Contact, f.ContactId, Ct);
        entries.Where(e => e.Kind == AteraCreateTicketHandler.ContactEffect).Select(e => e.Phase).ShouldBe([EffectPhase.Sending, EffectPhase.Sent]);
        (await Run(host, f.RequestId)).ShouldBeSameAs(OutboundResult.NothingToDo); provider.ContactWrites.Count.ShouldBe(1);
    }

    [Theory]
    [InlineData("inactive")]
    [InlineData("relinked-customer")]
    [InlineData("relinked-contact")]
    [InlineData("rebound-contact")]
    public async Task Changes_during_owner_read_cannot_license_a_fresh_ticket(string kind)
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, true);
        provider.BeforeOwnerRead = () => Mutate(host, f, kind);
        await Should.ThrowAsync<PermanentOutboundException>(() => Run(host, f.RequestId));
        provider.OwnerReads.ShouldBe(1); provider.ContactWrites.ShouldBeEmpty(); provider.TicketWrites.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Earlier_contact_effects_never_become_new_sends_after_the_affiliation_ends(bool knownReference)
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, false);
        provider.Contacts.Add(Person(f.EndUserId, f.CustomerId));
        var journal = host.Services.GetRequiredService<IExternalEffectJournal>();
        var effect = await journal.BeginAsync(new("atera", AteraCreateTicketHandler.ContactEffect, EntityTypes.Contact, f.ContactId), Ct);
        if (knownReference)
        {
            await journal.CompleteAsync(effect, EffectPhase.Sent, f.EndUserId.ToString(CultureInfo.InvariantCulture), Ct);
            provider.BeforeOwnerRead = () => Mutate(host, f, "inactive");
        }
        else await Mutate(host, f, "inactive");
        var before = await journal.ForEntityAsync(EntityTypes.Contact, f.ContactId, Ct);
        await Should.ThrowAsync<PermanentOutboundException>(() => Run(host, f.RequestId));
        provider.ContactWrites.ShouldBeEmpty(); provider.TicketWrites.ShouldBeEmpty();
        (await journal.ForEntityAsync(EntityTypes.Contact, f.ContactId, Ct)).ShouldBe(before);
    }

    [Theory]
    [InlineData("known")]
    [InlineData("marker")]
    [InlineData("missing")]
    public async Task An_earlier_ticket_is_settled_before_new_contact_eligibility_without_another_send(string outcome)
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, true);
        var journal = host.Services.GetRequiredService<IExternalEffectJournal>();
        var effect = await journal.BeginAsync(new("atera", AteraCreateTicketHandler.TicketEffect, EntityTypes.TicketRequest, f.RequestId), Ct);
        if (outcome == "known") await journal.CompleteAsync(effect, EffectPhase.Sent, "99001", Ct);
        if (outcome == "marker") provider.Tickets.Add(new(TicketId: 99001, CustomerId: f.CustomerId, EndUserId: f.EndUserId,
            Title: "Existing synthetic ticket", Status: "Open", Priority: null, Impact: null, Type: null, Source: null,
            TechnicianId: null, TechnicianEmail: null, TechnicianName: null, EndUserName: null, EndUserEmail: null,
            CreatedAt: DateTimeOffset.UtcNow, FirstResponseAt: null, ResolvedAt: null, LastActivityAt: null, Description: AteraCreateTicketHandler.Marker(f.RequestId)));
        await Mutate(host, f, "deleted-contact");
        if (outcome == "missing") await Should.ThrowAsync<PermanentOutboundException>(() => Run(host, f.RequestId));
        else (await Run(host, f.RequestId)).Reference.ShouldBe("99001");
        provider.OwnerReads.ShouldBe(0); provider.ContactWrites.ShouldBeEmpty(); provider.TicketWrites.ShouldBeEmpty();
        (await Request(host, f.RequestId)).Status.ShouldBe(outcome == "missing" ? TicketRequestStatus.Failed : TicketRequestStatus.Created);
    }

    [Fact]
    public async Task Contact_owner_lookup_is_bounded_and_does_not_accept_an_unexamined_match()
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, true);
        provider.Contacts.Clear(); provider.Contacts.AddRange(Enumerable.Range(1, 1000).Select(i => Person(i, f.CustomerId)));
        provider.Contacts.Add(Person(f.EndUserId, f.CustomerId));
        await Should.ThrowAsync<PermanentOutboundException>(() => Run(host, f.RequestId));
        provider.OwnerRows.ShouldBe(1000); provider.TicketWrites.ShouldBeEmpty(); provider.ContactWrites.ShouldBeEmpty();
    }

    [Fact]
    public async Task Contact_owner_lookup_propagates_caller_cancellation_without_failing_or_sending_the_request()
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, true);
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        provider.BeforeOwnerRead = () => { cancellation.Cancel(); return Task.CompletedTask; };
        await Should.ThrowAsync<OperationCanceledException>(() => Run(host, f.RequestId, cancellation.Token));
        (await Request(host, f.RequestId)).Status.ShouldBe(TicketRequestStatus.Pending);
        provider.TicketWrites.ShouldBeEmpty(); provider.ContactWrites.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_current_contact_is_created_once_then_its_verified_owner_is_used_for_one_ticket()
    {
        var provider = new Provider(); await using var host = Host(factory, provider); var f = await Create(factory, host, provider, false);
        await Run(host, f.RequestId);
        provider.ContactWrites.ShouldHaveSingleItem().CustomerID.ShouldBe(f.CustomerId);
        provider.TicketWrites.ShouldHaveSingleItem().EndUserID.ShouldBe(provider.NewContactId);
        (await Run(host, f.RequestId)).ShouldBeSameAs(OutboundResult.NothingToDo);
        provider.ContactWrites.Count.ShouldBe(1); provider.TicketWrites.Count.ShouldBe(1);
    }

    [Theory]
    [InlineData("known", 0)]
    [InlineData("known", -1)]
    [InlineData("new", 0)]
    [InlineData("new", -1)]
    [InlineData("recovered", 0)]
    [InlineData("recovered", -1)]
    public async Task Nonpositive_contact_ids_never_authorize_a_ticket_or_a_second_contact_even_with_a_matching_owner_row(string origin, long invalidId)
    {
        var provider = new Provider { NewContactId = invalidId }; await using var host = Host(factory, provider);
        var f = await Create(factory, host, provider, false);
        var journal = host.Services.GetRequiredService<IExternalEffectJournal>();
        if (origin != "new")
        {
            var effect = await journal.BeginAsync(new("atera", AteraCreateTicketHandler.ContactEffect, EntityTypes.Contact, f.ContactId), Ct);
            if (origin == "known") await journal.CompleteAsync(effect, EffectPhase.Sent, invalidId.ToString(CultureInfo.InvariantCulture), Ct);
            await using var scope = host.Services.CreateAsyncScope();
            var contact = (await scope.ServiceProvider.GetRequiredService<Crm.Customers.Contracts.ICustomersApi>().GetContactForSyncAsync(f.ContactId, Ct))!;
            provider.Contacts.Add(Person(invalidId, f.CustomerId) with { Email = contact.Email });
        }
        await Should.ThrowAsync<PermanentOutboundException>(() => Run(host, f.RequestId));
        provider.Contacts.ShouldContain(c => c.ContactId == invalidId && c.CustomerId == f.CustomerId);
        provider.TicketWrites.ShouldBeEmpty(); provider.ContactWrites.Count.ShouldBe(origin == "new" ? 1 : 0);
        provider.OwnerReads.ShouldBe(origin == "recovered" ? 1 : 0); // Recovery reads before an ID is known; owner verification never scans an invalid ID.
        await using var check = host.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<ExternalLinkService>().FindByEntityAsync(EntityTypes.Contact, f.ContactId, "atera", "Contact", Ct)).ShouldBeNull();
        var entries = await journal.ForEntityAsync(EntityTypes.Contact, f.ContactId, Ct);
        (await Run(host, f.RequestId)).ShouldBeSameAs(OutboundResult.NothingToDo);
        (await journal.ForEntityAsync(EntityTypes.Contact, f.ContactId, Ct)).ShouldBe(entries);
        provider.ContactWrites.Count.ShouldBe(origin == "new" ? 1 : 0); provider.TicketWrites.ShouldBeEmpty();
    }
}
