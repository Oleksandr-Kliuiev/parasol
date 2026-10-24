using System.Runtime.CompilerServices;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.WorkTicketTestSupport;

namespace Crm.IntegrationTests;

[Collection(AteraCollection.Name)]
public sealed class AteraTicketOwnerImportTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Atera_job_persists_exact_owner_tuple_and_an_inflight_rebind_stays_unavailable_until_a_later_import()
    {
        var org = await SourceTaskTestSupport.Organization(factory);
        var customerId = TestData.AteraId();
        var externalId = TestData.AteraId();
        await using var scope = factory.Services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var original = Link(org, customerId); links.ExternalLinks.Add(original); await links.SaveChangesAsync();
        var replacement = Link(org, customerId);
        var payload = new AteraTicket(externalId, customerId, null, "Synthetic import owner", "Open", null, null, null, null,
            null, null, null, null, null, DateTimeOffset.UtcNow, null, null, null);
        var client = new TicketClient(payload, async () =>
        {
            // The job has already snapshotted original. No read lease is held over this synthetic provider enumeration.
            await links.ExternalLinks.Where(row => row.Id == original.Id).ExecuteDeleteAsync();
            links.ExternalLinks.Add(replacement); await links.SaveChangesAsync();
        });
        var job = ActivatorUtilities.CreateInstance<AteraTicketSyncJob>(scope.ServiceProvider, client);
        await job.RunAsync(false, default);
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var stale = await db.Tickets.AsNoTracking().SingleAsync(row => row.ExternalId == externalId && row.System == "atera");
        stale.OwnerLinkId.ShouldBe(original.Id); stale.OwnerCustomerId.ShouldBe(customerId); stale.ImportedAt.ShouldNotBeNull();
        var api = scope.ServiceProvider.GetRequiredService<ITicketWorkApi>();
        (await api.GetAsync(org, stale.Id, default)).IsSuccess.ShouldBeFalse();
        var later = ActivatorUtilities.CreateInstance<AteraTicketSyncJob>(scope.ServiceProvider, new TicketClient(payload));
        await later.RunAsync(false, default);
        var current = (await api.GetAsync(org, stale.Id, default)).Value;
        current.Id.ShouldBe(stale.Id);
        var saved = await db.Tickets.AsNoTracking().SingleAsync(row => row.Id == stale.Id);
        saved.OwnerLinkId.ShouldBe(replacement.Id);
        var changed = await links.SyncRuns.AsNoTracking().Where(row => row.Job == AteraTicketSyncJob.OpenJobId)
            .OrderByDescending(row => row.StartedAt).Select(row => row.Changed).FirstAsync();
        changed.ShouldBe(1);
        await later.RunAsync(false, default);
        var unchanged = await links.SyncRuns.AsNoTracking().Where(row => row.Job == AteraTicketSyncJob.OpenJobId)
            .OrderByDescending(row => row.StartedAt).Select(row => row.Changed).FirstAsync();
        unchanged.ShouldBe(0);
    }

    private sealed class TicketClient(AteraTicket ticket, Func<Task>? beforeRead = null) : IAteraClient
    {
        public async IAsyncEnumerable<AteraTicket> GetTicketsAsync(string? status, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            if (status != "Open") yield break;
            if (beforeRead is not null) await beforeRead();
            cancellationToken.ThrowIfCancellationRequested(); yield return ticket;
        }
        // This job must not use any other provider route. Synthetic fixture methods deliberately fail if scope grows.
        public IAsyncEnumerable<AteraCustomer> GetCustomersAsync(CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraContact> GetContactsAsync(CancellationToken ct) => throw new NotSupportedException();
        public Task<AteraCustomer?> GetCustomerAsync(long id, CancellationToken ct) => throw new NotSupportedException();
        public Task<long> CreateCustomerAsync(AteraCustomerWrite customer, CancellationToken ct) => throw new NotSupportedException();
        public Task UpdateCustomerAsync(long id, AteraCustomerWrite customer, CancellationToken ct) => throw new NotSupportedException();
        public Task<string?> GetCustomerFieldAsync(long id, string field, CancellationToken ct) => throw new NotSupportedException();
        public Task SetCustomerFieldAsync(long id, string field, string value, CancellationToken ct) => throw new NotSupportedException();
        public Task<AteraWorkHoursResult> GetWorkHoursAsync(long id, CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraTicket> GetCustomerTicketsAsync(long id, CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken ct) => throw new NotSupportedException();
        public Task<long> CreateTicketAsync(AteraTicketWrite ticket, CancellationToken ct) => throw new NotSupportedException();
        public Task<long> CreateContactAsync(AteraContactWrite contact, CancellationToken ct) => throw new NotSupportedException();
    }
}
