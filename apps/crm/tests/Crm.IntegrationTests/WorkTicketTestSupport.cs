using System.Globalization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

internal static class WorkTicketTestSupport
{
    internal static async Task<TicketWorkRef> Create(CrmWebFactory factory, Guid organizationId, long? externalId = null)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var link = await db.ExternalLinks.AsNoTracking().SingleOrDefaultAsync(row => row.EntityType == EntityTypes.Organization &&
            row.EntityId == organizationId && row.System == "atera" && row.ExternalType == "Customer");
        if (link is null)
        {
            link = Link(organizationId, TestData.AteraId());
            db.ExternalLinks.Add(link); await db.SaveChangesAsync();
        }
        var number = externalId ?? TestData.AteraId();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().UpsertTicketsAsync([
            Source(organizationId, number, link.Id, long.Parse(link.ExternalId, CultureInfo.InvariantCulture))], default);
        return (await scope.ServiceProvider.GetRequiredService<ITicketWorkApi>().ListAsync(organizationId, 100, null, default))
            .Value.Items.Single(ticket => ticket.ExternalId == number);
    }

    internal static ExternalLink Link(Guid organizationId, long customerId) => new()
    {
        Id = Guid.NewGuid(), EntityId = organizationId, EntityType = EntityTypes.Organization,
        System = "atera", ExternalType = "Customer", ExternalId = customerId.ToString(CultureInfo.InvariantCulture),
        Method = LinkMethod.Manual, LinkedAt = DateTimeOffset.UtcNow,
    };

    internal static ExternalTicket Source(Guid organizationId, long externalId, Guid linkId, long customerId) =>
        new("atera", externalId, organizationId, null, "Synthetic saved service ticket", "Open", null, null, "Incident", null,
            null, null, null, null, DateTimeOffset.Parse("2026-10-01T10:00:00Z"), null, null, null, null, customerId, linkId);

    internal static async Task<int> Import(CrmWebFactory factory, ExternalTicket ticket)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IServiceApi>().UpsertTicketsAsync([ticket], default);
    }
}
