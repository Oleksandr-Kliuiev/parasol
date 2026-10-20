using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.WorkTicketTestSupport;

namespace Crm.IntegrationTests;

public sealed class TicketWorkOwnershipTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Rebinding_the_same_external_customer_requires_a_new_import_with_the_exact_new_link_id()
    {
        var org = await SourceTaskTestSupport.Organization(factory); var ticket = await Create(factory, org);
        await Create(factory, org);
        await using var scope = factory.Services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var old = await links.ExternalLinks.SingleAsync(row => row.EntityId == org && row.System == "atera" && row.ExternalType == "Customer");
        var customerId = long.Parse(old.ExternalId, CultureInfo.InvariantCulture);
        var api = scope.ServiceProvider.GetRequiredService<ITicketWorkApi>();
        var oldCursor = (await api.ListAsync(org, 1, null, default)).Value.NextCursor; oldCursor.ShouldNotBeNull();
        await links.ExternalLinks.Where(row => row.Id == old.Id).ExecuteDeleteAsync();
        var replacement = Link(org, customerId); links.ExternalLinks.Add(replacement); await links.SaveChangesAsync();
        (await api.ListAsync(org, 1, oldCursor, default)).Error!.Code.ShouldBe("SRV_WORK_CURSOR_INVALID");
        (await api.GetAsync(org, ticket.Id, default)).Error!.Code.ShouldBe("SRV_WORK_TICKET_UNAVAILABLE");
        (await api.ListAsync(org, 10, null, default)).Value.Items.ShouldBeEmpty();
        var source = Source(org, ticket.ExternalId, replacement.Id, customerId);
        (await Import(factory, source)).ShouldBe(1);
        var accepted = (await api.GetAsync(org, ticket.Id, default)).Value;
        accepted.Id.ShouldBe(ticket.Id); accepted.Title.ShouldBe(ticket.Title);
        (await api.ListAsync(org, 1, oldCursor, default)).Error!.Code.ShouldBe("SRV_WORK_CURSOR_INVALID");
        (await Import(factory, source)).ShouldBe(0);
        var row = await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Tickets.AsNoTracking().SingleAsync(row => row.Id == ticket.Id);
        row.OwnerLinkId.ShouldBe(replacement.Id); row.OwnerCustomerId.ShouldBe(customerId); row.ImportedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task Aliased_owner_and_legacy_import_proof_are_unavailable_without_reassociating_the_saved_guid()
    {
        var org = await SourceTaskTestSupport.Organization(factory); var ticket = await Create(factory, org);
        var other = await SourceTaskTestSupport.Organization(factory);
        await using var scope = factory.Services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var current = await links.ExternalLinks.AsNoTracking().SingleAsync(row => row.EntityId == org && row.System == "atera" && row.ExternalType == "Customer");
        var alias = new ExternalLink { Id = Guid.NewGuid(), EntityId = other, EntityType = "Organization", System = "atera",
            ExternalType = "Customer", ExternalId = "0" + current.ExternalId };
        links.ExternalLinks.Add(alias); await links.SaveChangesAsync();
        var api = scope.ServiceProvider.GetRequiredService<ITicketWorkApi>();
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeFalse();
        await links.ExternalLinks.Where(row => row.Id == alias.Id).ExecuteDeleteAsync();
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeTrue();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        await db.Tickets.Where(row => row.Id == ticket.Id).ExecuteUpdateAsync(update => update.SetProperty(row => row.ImportedAt, (DateTimeOffset?)null));
        (await api.ListAsync(org, 10, null, default)).Value.TotalCount.ShouldBe(0);
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeFalse();
        await db.Tickets.Where(row => row.Id == ticket.Id).ExecuteUpdateAsync(update => update.SetProperty(row => row.ImportedAt, DateTimeOffset.UtcNow)
            .SetProperty(row => row.OwnerLinkId, (Guid?)null).SetProperty(row => row.OwnerCustomerId, (long?)null));
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeFalse();
    }

    [Theory]
    [InlineData("Organization", "Atera", "Customer")]
    [InlineData("Contact", "atera", "Customer")]
    [InlineData("Organization", "atera", "customer")]
    public async Task Case_insensitive_sql_does_not_turn_a_wrong_namespace_into_owner_proof(string entityType, string system, string externalType)
    {
        var org = await SourceTaskTestSupport.Organization(factory);
        await using var scope = factory.Services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var customerId = Random.Shared.NextInt64(100_000_000, 999_999_999);
        var link = new ExternalLink { Id = Guid.NewGuid(), EntityId = org, EntityType = entityType,
            System = system, ExternalType = externalType, ExternalId = customerId.ToString(CultureInfo.InvariantCulture) };
        links.ExternalLinks.Add(link); await links.SaveChangesAsync();
        var externalId = Random.Shared.NextInt64(100_000_000, 999_999_999);
        await Import(factory, Source(org, externalId, link.Id, customerId));
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var ticket = await db.Tickets.AsNoTracking().SingleAsync(row => row.ExternalId == externalId && row.System == "atera");
        var api = scope.ServiceProvider.GetRequiredService<ITicketWorkApi>();
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeFalse();
        (await api.ListAsync(org, 10, null, default)).Value.TotalCount.ShouldBe(0);
    }

    [Fact]
    public async Task Work_ticket_pages_are_customer_scoped_complete_and_use_only_saved_positive_provenance()
    {
        var org = await SourceTaskTestSupport.Organization(factory);
        var first = await Create(factory, org); var second = await Create(factory, org); var third = await Create(factory, org);
        using var reader = factory.ClientAs(CrmRoles.Technician);
        var url = $"/api/v1/service/work-tickets?organizationId={org}&limit=1";
        var ids = new List<Guid>(); string? cursor = null;
        do
        {
            var page = await reader.GetFromJsonAsync<PagedResult<TicketWorkRef>>(url + (cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(cursor)));
            page!.TotalCount.ShouldBe(3); page.Items.Count.ShouldBe(1); ids.Add(page.Items[0].Id); cursor = page.NextCursor;
        } while (cursor is not null);
        ids.Order().ShouldBe(new[] { first.Id, second.Id, third.Id }.Order());
        var original = (await reader.GetFromJsonAsync<PagedResult<TicketWorkRef>>(url))!;
        var other = await SourceTaskTestSupport.Organization(factory);
        (await reader.GetAsync($"/api/v1/service/work-tickets?organizationId={other}&cursor={Uri.EscapeDataString(original.NextCursor!)}"))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        await using var scope = factory.Services.CreateAsyncScope(); var api = scope.ServiceProvider.GetRequiredService<ITicketWorkApi>();
        (await api.GetAsync(other, first.Id, default)).IsSuccess.ShouldBeFalse();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        await db.Tickets.Where(row => row.Id == first.Id).ExecuteDeleteAsync();
        (await api.GetAsync(org, first.Id, default)).IsSuccess.ShouldBeFalse();
        // Reimporting a reused external number creates a new mirror GUID; historical associations never follow it.
        var reimport = await Create(factory, org, first.ExternalId); reimport.Id.ShouldNotBe(first.Id);
        (await api.GetAsync(org, first.Id, default)).IsSuccess.ShouldBeFalse();
    }
}
