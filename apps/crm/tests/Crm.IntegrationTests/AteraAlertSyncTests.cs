using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Crm.IntegrationTests;

/// <summary>
/// M38 through the Atera alert job, with a synthetic provider: ids survive reads, a closed alert is resolved and comes back under
/// the same id, a failed page changes nothing, and an alert whose customer lost its link stays as it was. In the Atera collection:
/// a complete read resolves every other open Atera alert, so no other alert read may run meanwhile.
/// </summary>
[Collection(AteraCollection.Name)]
public sealed class AteraAlertSyncTests(CrmWebFactory factory)
{
    private static readonly DateTimeOffset At = new(2026, 9, 25, 7, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Atera_alerts_keep_their_ids_link_their_device_and_are_resolved_when_closed_and_opened_again()
    {
        var (organizationId, customerId, marker) = await LinkedCustomerAsync();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(organizationId, AteraTypes.System,
                [new($"m38-{marker}-srv", $"SRV-{marker}", DeviceType.Server, null, true, At, null)], Ct);
        }

        var provider = new AlertProvider(
            Reported($"{marker}-A1", customerId, "Critical", $"srv-{marker}"),
            Reported($"{marker}-A2", customerId, "Warning"),
            Reported($"{marker}-INFO", customerId, "Information"),
            Reported($"{marker}-NOLINK", Random.Shared.NextInt64(1_000_000_000, 1_999_999_999), "Critical"));
        await RunAsync(provider);

        // Information alerts and alerts of customers without a link stay in Atera.
        var first = await RowsAsync(marker);
        first.Select(a => a.ExternalId).Order(StringComparer.Ordinal).ShouldBe([$"{marker}-A1", $"{marker}-A2"]);
        var a1 = first.Single(a => a.ExternalId == $"{marker}-A1");
        (a1.State, a1.Kind, a1.OrganizationId, a1.ExternalCustomerId, a1.Url)
            .ShouldBe((AlertState.Open, AlertKind.Monitoring, organizationId, customerId.ToString(CultureInfo.InvariantCulture), $"https://atera.example/alerts/{marker}-A1"));
        a1.DeviceId.ShouldBe(await DeviceIdAsync(marker));
        first.Single(a => a.ExternalId == $"{marker}-A2").DeviceId.ShouldBeNull();
        (await SummaryAsync(organizationId)).ShouldBe((1, 1));

        await RunAsync(provider);
        (await RowsAsync(marker)).Select(a => a.Id).ShouldBe(first.Select(a => a.Id), ignoreOrder: true);
        (await LatestRunAsync()).Changed.ShouldBe(0, "a read that finds the same alerts changes nothing");

        provider.Close($"{marker}-A2");
        await RunAsync(provider);
        var closed = await RowsAsync(marker);
        var a2 = closed.Single(a => a.ExternalId == $"{marker}-A2");
        (a2.Id, a2.State).ShouldBe((first.Single(a => a.ExternalId == $"{marker}-A2").Id, AlertState.Resolved));
        a2.ResolvedAt.ShouldNotBeNull();
        closed.Single(a => a.ExternalId == $"{marker}-A1").State.ShouldBe(AlertState.Open);
        (await SummaryAsync(organizationId)).ShouldBe((1, 0), "a resolved alert no longer counts");

        provider.Reopen(Reported($"{marker}-A2", customerId, "Warning"));
        await RunAsync(provider);
        var again = (await RowsAsync(marker)).Single(a => a.ExternalId == $"{marker}-A2");
        (again.Id, again.State, again.ResolvedAt).ShouldBe((a2.Id, AlertState.Open, (DateTimeOffset?)null));

        var run = await LatestRunAsync();
        (run.Status, run.Failed).ShouldBe((SyncRunStatus.Succeeded, 0));
        var urgent = await factory.ClientAs(CrmRoles.Technician, userKey: "m38-atera").GetFromJsonAsync<JsonElement>("/api/v1/service/alerts/urgent", Ct);
        var read = urgent.GetProperty("reads").EnumerateArray().Single(r => r.GetProperty("system").GetString() == "atera");
        (read.GetProperty("complete").GetBoolean(), read.GetProperty("startedAt").GetDateTimeOffset()).ShouldBe((true, run.StartedAt));
    }

    [Fact]
    public async Task A_page_that_cannot_be_read_changes_nothing_and_the_read_is_not_complete()
    {
        var (_, customerId, marker) = await LinkedCustomerAsync();
        var provider = new AlertProvider(Reported($"{marker}-A1", customerId, "Critical"), Reported($"{marker}-A2", customerId, "Critical"));
        await RunAsync(provider);
        var before = await RowsAsync(marker);
        before.Count.ShouldBe(2);

        // The first page arrives with a new alert, the next one fails after the retries: A1 and A2 may be on the page never read.
        var failing = new AlertProvider(Reported($"{marker}-A3", customerId, "Critical")) { FailAtTheEnd = true };
        await Should.ThrowAsync<SyncFailedException>(() => RunAsync(failing));

        var after = await RowsAsync(marker);
        after.Select(a => (a.Id, a.ExternalId, a.State, a.LastSeenAt)).ShouldBe(before.Select(a => (a.Id, a.ExternalId, a.State, a.LastSeenAt)), ignoreOrder: true);
        (await LatestRunAsync()).Status.ShouldBe(SyncRunStatus.Failed);
        var urgent = await factory.ClientAs(CrmRoles.Technician, userKey: "m38-atera").GetFromJsonAsync<JsonElement>("/api/v1/service/alerts/urgent", Ct);
        urgent.GetProperty("reads").EnumerateArray().Single(r => r.GetProperty("system").GetString() == "atera").GetProperty("complete").GetBoolean().ShouldBeFalse();
    }

    [Fact]
    public async Task An_alert_whose_customer_lost_its_link_is_left_as_it_was_while_atera_still_reports_it()
    {
        var (organizationId, customerId, marker) = await LinkedCustomerAsync();
        var provider = new AlertProvider(Reported($"{marker}-A1", customerId, "Warning"));
        await RunAsync(provider);
        var before = (await RowsAsync(marker)).ShouldHaveSingleItem();

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks
                .Where(l => l.System == AteraTypes.System && l.ExternalType == AteraTypes.Customer && l.ExternalId == customerId.ToString(CultureInfo.InvariantCulture))
                .ExecuteDeleteAsync(Ct);
        }

        await RunAsync(provider);
        var after = (await RowsAsync(marker)).ShouldHaveSingleItem();
        (after.Id, after.State, after.OrganizationId, after.LastSeenAt, after.ResolvedAt)
            .ShouldBe((before.Id, AlertState.Open, organizationId, before.LastSeenAt, (DateTimeOffset?)null));
        (await SummaryAsync(organizationId)).ShouldBe((0, 1));
    }

    private async Task<(Guid OrganizationId, long CustomerId, string Marker)> LinkedCustomerAsync()
    {
        var marker = $"AL{Guid.NewGuid():N}"[..10];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Drift AS", status = "Customer" });
        var customerId = Random.Shared.NextInt64(2_000_000_000, 2_999_999_999);
        await using var scope = factory.Services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        links.ExternalLinks.Add(WorkTicketTestSupport.Link(organizationId, customerId));
        await links.SaveChangesAsync(Ct);
        return (organizationId, customerId, marker);
    }

    private static AteraAlert Reported(string id, long customerId, string severity, string? deviceName = null) =>
        new(id, customerId, $"Synthetic alert {id}", severity, deviceName, At);

    private async Task RunAsync(AlertProvider provider)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var options = Options.Create(new AteraOptions { Enabled = true, ApiKey = "test-atera-key", AlertUrlTemplate = "https://atera.example/alerts/{0}" });
        await ActivatorUtilities.CreateInstance<AteraAlertSyncJob>(scope.ServiceProvider, provider, options).RunAsync(Ct);
    }

    private async Task<List<Alert>> RowsAsync(string marker)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking()
            .Where(a => a.System == AteraTypes.System && a.ExternalId.StartsWith(marker)).ToListAsync(Ct);
    }

    private async Task<Guid> DeviceIdAsync(string marker)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Devices.AsNoTracking()
            .Where(d => d.System == AteraTypes.System && d.ExternalId == $"m38-{marker}-srv").Select(d => d.Id).SingleAsync(Ct);
    }

    private async Task<SyncRun> LatestRunAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .Where(r => r.System == AteraTypes.System && r.Job == AteraAlertSyncJob.JobId).OrderByDescending(r => r.StartedAt).FirstAsync(Ct);
    }

    private async Task<(int Critical, int Warning)> SummaryAsync(Guid organizationId)
    {
        var summary = await factory.ClientAs(CrmRoles.Technician, userKey: "m38-atera").GetFromJsonAsync<JsonElement>($"/api/v1/service/organizations/{organizationId}/summary", Ct);
        return (summary.GetProperty("criticalAlerts").GetInt32(), summary.GetProperty("warningAlerts").GetInt32());
    }

    /// <summary>Atera's open alerts, as the job reads them; any other provider route fails, so the job cannot grow quietly.</summary>
    private sealed class AlertProvider(params AteraAlert[] alerts) : IAteraClient
    {
        private readonly List<AteraAlert> open = [.. alerts];

        /// <summary>After the alerts, the next page cannot be read (the client has given up retrying).</summary>
        public bool FailAtTheEnd { get; init; }

        public void Close(string id) => open.RemoveAll(a => a.AlertId == id);

        public void Reopen(AteraAlert alert) => open.Insert(0, alert);

        public async IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            status.ShouldBe("Open");
            await Task.Yield();
            foreach (var alert in open.ToList())
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return alert;
            }

            if (FailAtTheEnd)
            {
                throw new AteraApiException(HttpStatusCode.BadGateway, "Synthetic: the next page of alerts could not be read.");
            }
        }

        public IAsyncEnumerable<AteraCustomer> GetCustomersAsync(CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraContact> GetContactsAsync(CancellationToken ct) => throw new NotSupportedException();
        public Task<AteraCustomer?> GetCustomerAsync(long id, CancellationToken ct) => throw new NotSupportedException();
        public Task<long> CreateCustomerAsync(AteraCustomerWrite customer, CancellationToken ct) => throw new NotSupportedException();
        public Task UpdateCustomerAsync(long id, AteraCustomerWrite customer, CancellationToken ct) => throw new NotSupportedException();
        public Task<string?> GetCustomerFieldAsync(long id, string field, CancellationToken ct) => throw new NotSupportedException();
        public Task SetCustomerFieldAsync(long id, string field, string value, CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraTicket> GetTicketsAsync(string? status, CancellationToken ct) => throw new NotSupportedException();
        public Task<AteraWorkHoursResult> GetWorkHoursAsync(long id, CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraTicket> GetCustomerTicketsAsync(long id, CancellationToken ct) => throw new NotSupportedException();
        public IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken ct) => throw new NotSupportedException();
        public Task<long> CreateTicketAsync(AteraTicketWrite ticket, CancellationToken ct) => throw new NotSupportedException();
        public Task<long> CreateContactAsync(AteraContactWrite contact, CancellationToken ct) => throw new NotSupportedException();
    }
}
