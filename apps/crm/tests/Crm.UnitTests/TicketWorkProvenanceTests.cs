using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;

namespace Crm.UnitTests;

public sealed class TicketWorkProvenanceTests
{
    [Theory]
    [InlineData("01")][InlineData("+1")][InlineData(" 1")][InlineData("1 ")][InlineData("0")]
    [InlineData("-1")][InlineData("1.0")][InlineData("9223372036854775808")][InlineData("")]
    public void Owner_proof_rejects_noncanonical_or_nonpositive_customer_ids(string externalId) =>
        AteraTicketOwners.Resolve([Link(externalId)]).ShouldBeEmpty();

    [Theory]
    [InlineData("01")][InlineData("+1")][InlineData(" 1")][InlineData("1 ")]
    public void Canonical_customer_is_unavailable_when_an_alias_claims_the_same_number(string alias) =>
        AteraTicketOwners.Resolve([Link("1"), Link(alias)]).ShouldBeEmpty();

    [Theory]
    [InlineData("Organization", "Atera", "Customer")][InlineData("Organization", "atera", "customer")]
    [InlineData("Contact", "atera", "Customer")][InlineData("organization", "atera", "Customer")]
    public void Owner_namespaces_are_ordinal_exact(string entityType, string system, string type) =>
        AteraTicketOwners.Resolve([new ExternalLink { Id = Guid.NewGuid(), EntityId = Guid.NewGuid(),
            EntityType = entityType, System = system, ExternalType = type, ExternalId = "1" }]).ShouldBeEmpty();

    [Fact]
    public void Owner_proof_preserves_exact_link_and_organization_ids()
    {
        var link = Link("123");
        AteraTicketOwners.Resolve([link])[123].ShouldBe(new TicketOwnerBinding(link.Id, link.EntityId, 123));
    }

    [Fact]
    public void Owner_only_change_counts_once_but_each_accepted_import_advances_only_import_time()
    {
        var source = Source(); var first = DateTimeOffset.Parse("2026-10-17T10:00:00Z");
        var ticket = Ticket.From(source, first);
        ticket.ImportedAt.ShouldBe(first);
        var rebound = source with { OwnerLinkId = Guid.NewGuid() };
        ticket.Apply(rebound, first.AddMinutes(1)).ShouldBeTrue();
        ticket.OwnerLinkId.ShouldBe(rebound.OwnerLinkId);
        ticket.SyncedAt.ShouldBe(first.AddMinutes(1));
        ticket.Apply(rebound, first.AddMinutes(2)).ShouldBeFalse();
        ticket.ImportedAt.ShouldBe(first.AddMinutes(2));
        ticket.SyncedAt.ShouldBe(first.AddMinutes(1));
    }

    [Fact]
    public void Customer_proof_changes_persist_and_old_imports_do_not_invent_owner_proof()
    {
        var source = Source(); var ticket = Ticket.From(source, DateTimeOffset.UtcNow);
        ticket.Apply(source with { OwnerCustomerId = 9 }, DateTimeOffset.UtcNow).ShouldBeTrue();
        ticket.OwnerCustomerId.ShouldBe(9);
        ticket.Apply(source with { OwnerCustomerId = null, OwnerLinkId = null }, DateTimeOffset.UtcNow).ShouldBeTrue();
        ticket.OwnerCustomerId.ShouldBeNull(); ticket.OwnerLinkId.ShouldBeNull();
    }

    private static ExternalLink Link(string externalId) => new() { Id = Guid.NewGuid(), EntityId = Guid.NewGuid(),
        EntityType = EntityTypes.Organization, System = "atera", ExternalType = "Customer", ExternalId = externalId };
    private static ExternalTicket Source() => new("atera", 100, Guid.NewGuid(), null, "Synthetic saved ticket", "Open",
        null, null, null, null, null, null, null, null, DateTimeOffset.Parse("2026-10-01T10:00:00Z"),
        null, null, null, null, 1, Guid.NewGuid());
}
