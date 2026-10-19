using Crm.Customers.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Results;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.WorkTicketTestSupport;

namespace Crm.IntegrationTests;

public sealed class TicketWorkLeaseTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Current_ticket_lease_blocks_ordinary_customer_link_and_ticket_mutations_until_local_callback_finishes()
    {
        var org = await SourceTaskTestSupport.Organization(factory); var ticket = await Create(factory, org);
        var aliasOrganization = await SourceTaskTestSupport.Organization(factory);
        await using var scope = factory.Services.CreateAsyncScope(); var api = scope.ServiceProvider.GetRequiredService<ITicketWorkApi>();
        var links = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var link = await links.ExternalLinks.AsNoTracking().SingleAsync(row => row.EntityId == org && row.System == "atera" && row.ExternalType == "Customer");
        var aliasId = Guid.NewGuid();
        var aliasInsert = $"INSERT integration.ExternalLinks (Id,EntityType,EntityId,System,ExternalType,ExternalId,Method,LinkedAt) " +
            $"VALUES ('{aliasId}',N'Organization','{aliasOrganization}',N'atera',N'Customer',N'0{link.ExternalId}',N'Manual',SYSDATETIMEOFFSET())";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var calls = 0;
        var read = api.WithCurrentAsync<int>(org, ticket.Id, async (current, ct) =>
        {
            current.Id.ShouldBe(ticket.Id); Interlocked.Increment(ref calls); entered.SetResult();
            await release.Task.WaitAsync(ct); return 1;
        }, TestContext.Current.CancellationToken);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            // SQL Server's own lock timeout is the positive control. No applock-aware writer is used here.
            foreach (var statement in new[] {
                $"UPDATE customers.Organizations SET Name=Name WHERE Id='{org}'",
                $"DELETE integration.ExternalLinks WHERE Id='{link.Id}'",
                $"DELETE service.Tickets WHERE Id='{ticket.Id}'", aliasInsert })
            {
                await using var connection = new SqlConnection(factory.RuntimeConnectionString); await connection.OpenAsync();
                await using var command = new SqlCommand("SET LOCK_TIMEOUT 200; " + statement, connection);
                var error = await Should.ThrowAsync<SqlException>(() => command.ExecuteNonQueryAsync());
                error.Number.ShouldBe(1222);
            }
        }
        finally { release.TrySetResult(); }
        (await read).Value.ShouldBe(1); calls.ShouldBe(1);
        await links.Database.ExecuteSqlRawAsync(aliasInsert);
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeFalse();
        await links.ExternalLinks.Where(row => row.Id == aliasId).ExecuteDeleteAsync();
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeTrue();
        await links.ExternalLinks.Where(row => row.Id == link.Id).ExecuteDeleteAsync();
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public async Task Callback_failure_is_never_replayed_and_all_read_leases_are_released()
    {
        var org = await SourceTaskTestSupport.Organization(factory); var ticket = await Create(factory, org);
        await using var scope = factory.Services.CreateAsyncScope(); var api = scope.ServiceProvider.GetRequiredService<ITicketWorkApi>();
        var calls = 0;
        await Should.ThrowAsync<TimeoutException>(() => api.WithCurrentAsync<int>(org, ticket.Id, (_, _) =>
        {
            Interlocked.Increment(ref calls);
            throw new TimeoutException("Synthetic acknowledgement lost after local work.");
        }, default));
        calls.ShouldBe(1);
        var customers = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
        (await customers.Organizations.Where(row => row.Id == org).ExecuteUpdateAsync(update => update.SetProperty(row => row.Name, "Synthetic lease released")))
            .ShouldBe(1);
        (await api.GetAsync(org, ticket.Id, default)).IsSuccess.ShouldBeTrue();
    }
}
