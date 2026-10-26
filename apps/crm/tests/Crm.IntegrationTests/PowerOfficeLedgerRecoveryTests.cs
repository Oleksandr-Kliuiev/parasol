using System.Reflection;
using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.PowerOffice;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

public sealed partial class PowerOfficeLedgerTests
{
    [Theory]
    [InlineData(503, false)]
    [InlineData(403, false)]
    [InlineData(200, true)]
    public async Task Failed_or_null_page_keeps_the_previous_complete_customer_snapshot_and_checkpoint(int status, bool nullPage)
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var old = Entry(customer, "BankJournal");
        Pages(po, new[] { old });
        await Run(host.Services);
        var cursor = await Cursor(host.Services);
        var changed = old with { MatchId = null, Balance = old.Amount, LastChangedDateTimeOffset = Changed.AddMinutes(1) };
        Pages(po, new[] { changed });
        po.Given(Request.Create().WithPath("/v2/Customerledger/Statement").UsingGet().WithParam("PageNumber", "2"))
            .RespondWith(nullPage ? Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/json").WithBody("null") : Response.Create().WithStatusCode(status));
        await Should.ThrowAsync<SyncFailedException>(() => Run(host.Services));
        (await Cursor(host.Services)).ShouldBe(cursor);
        (await Page(host, organization: org)).GetProperty("entries")[0].GetProperty("source").GetProperty("matchId").GetInt64().ShouldBe(old.MatchId!.Value);
        Pages(po, new[] { changed });
        await Run(host.Services);
        await Run(host.Services);
        var row = (await Page(host, organization: org)).GetProperty("entries").EnumerateArray().ShouldHaveSingleItem();
        row.GetProperty("source").GetProperty("matchId").ValueKind.ShouldBe(JsonValueKind.Null);
        await using var check = host.Services.CreateAsyncScope();
        var db = check.ServiceProvider.GetRequiredService<BillingDbContext>();
        var id = (await db.CustomerLedgerEntries.SingleAsync(e => e.ExternalId == old.Id && e.System == "poweroffice")).Id;
        (await db.CustomerLedgerVersions.CountAsync(v => v.EntryId == id)).ShouldBe(2);
        AssertReadOnly(po);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Duplicate_source_ids_are_idempotent_or_fail_without_publishing_conflicting_data(bool conflicting)
    {
        using var po = Provider();
        await using var host = Host(po);
        var row = Entry(null, "BankJournal");
        Pages(po, new[] { row }, new[] { row with { Balance = conflicting ? -1m : row.Balance } });
        var before = await Cursor(host.Services);
        if (conflicting)
        {
            await Should.ThrowAsync<SyncFailedException>(() => Run(host.Services));
            (await Cursor(host.Services)).ShouldBe(before);
            await using var check = host.Services.CreateAsyncScope();
            (await check.ServiceProvider.GetRequiredService<BillingDbContext>().CustomerLedgerEntries.AnyAsync(e => e.ExternalId == row.Id)).ShouldBeFalse();
        }
        else
        {
            await Run(host.Services);
            await using var check = host.Services.CreateAsyncScope();
            (await check.ServiceProvider.GetRequiredService<BillingDbContext>().CustomerLedgerEntries.CountAsync(e => e.ExternalId == row.Id)).ShouldBe(1);
        }
    }

    [Fact]
    public async Task Invalid_required_fields_do_not_advance_checkpoint_or_create_a_partial_scan()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, _) = await Customer(host);
        var good = Entry(customer, "BankJournal");
        Pages(po, new[] { good, Entry(customer, "BankJournal") with { LastChangedDateTimeOffset = null } });
        var before = await Cursor(host.Services);
        await Should.ThrowAsync<SyncFailedException>(() => Run(host.Services));
        (await Cursor(host.Services)).ShouldBe(before);
        await using var check = host.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<BillingDbContext>().CustomerLedgerEntries.AnyAsync(e => e.ExternalId == good.Id)).ShouldBeFalse();
    }

    [Fact]
    public async Task Database_failure_rolls_back_the_whole_customer_snapshot_and_restart_replays_the_same_source_ids()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var invoice = Entry(customer, "OutgoingInvoice") with { Amount = 1250m, CurrencyAmount = 1250m };
        var payment = Entry(customer, "BankJournal") with { MatchId = invoice.MatchId };
        var initial = await Batch(host.Services, customer, org, [invoice]);
        var updated = invoice with { Balance = 500m, LastChangedDateTimeOffset = Changed.AddMinutes(1) };
        // The first entry is valid, the second violates immutable identity: state/first update must roll back with it.
        var invalid = invoice with { VoucherId = Guid.NewGuid(), LastChangedDateTimeOffset = Changed.AddMinutes(1) };
        await Should.ThrowAsync<InvalidOperationException>(() => Batch(host.Services, customer, org, [payment, invalid]));
        (await Page(host, organization: org)).GetProperty("entries").GetArrayLength().ShouldBe(1);
        Pages(po, new[] { updated, payment });
        await Run(host.Services);
        await Run(host.Services);
        var final = await Page(host, organization: org);
        final.GetProperty("total").GetInt32().ShouldBe(2);
        initial.Created.ShouldBe(1);
    }

    [Fact]
    public async Task Missing_from_a_complete_scan_is_retained_but_has_no_current_match_relationships()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var voucher = Guid.NewGuid();
        var invoiceId = await SeedInvoice(host.Services, customer, org, voucher);
        var anchor = Entry(customer, "OutgoingInvoice") with { VoucherId = voucher, Amount = 1250m, CurrencyAmount = 1250m };
        var payment = Entry(customer, "BankJournal") with { MatchId = anchor.MatchId };
        Pages(po, new[] { anchor, payment });
        await Run(host.Services);
        Pages(po);
        await Run(host.Services);
        var rows = (await Page(host, organization: org)).GetProperty("entries").EnumerateArray().ToList();
        rows.Count.ShouldBe(2);
        rows.ShouldAllBe(e => !e.GetProperty("presentInLatestScan").GetBoolean() && e.GetProperty("invoices").GetArrayLength() == 0);
        (await Page(host, invoice: invoiceId)).GetProperty("total").GetInt32().ShouldBe(0);
    }

    [Fact]
    public async Task Immutable_source_versions_and_operation_rows_are_protected_by_runtime_SQL_permissions()
    {
        await using var connection = new SqlConnection(factory.RuntimeConnectionString);
        await connection.OpenAsync();
        foreach (var sql in new[] { "DELETE FROM billing.CustomerLedgerEntries WHERE 1=0", "DELETE FROM billing.CustomerLedgerVersions WHERE 1=0", "UPDATE billing.CustomerLedgerVersions SET SnapshotJson=SnapshotJson WHERE 1=0" })
        {
            await using var command = new SqlCommand(sql, connection);
            (await Should.ThrowAsync<SqlException>(() => command.ExecuteNonQueryAsync())).Number.ShouldBe(229);
        }
    }

    [Fact]
    public async Task Separate_enable_flag_prevents_any_provider_access()
    {
        using var po = Provider();
        await using var host = Host(po, false);
        await Run(host.Services);
        po.LogEntries.ShouldBeEmpty();
    }

    [Fact]
    public async Task Crash_between_customer_commits_keeps_checkpoint_and_replays_completed_customers_without_duplicates()
    {
        using var po = Provider();
        await using var host = Host(po);
        var first = Entry(1_200_000_001, "BankJournal");
        var second = Entry(1_200_000_002, "BankJournal");
        Pages(po, new[] { first, second });
        var before = await Cursor(host.Services);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var proxy = DispatchProxy.Create<IBillingApi, BillingFault>();
            var fault = (BillingFault)(object)proxy;
            fault.Target = scope.ServiceProvider.GetRequiredService<IBillingApi>();
            fault.Customer = Key(second.CustomerId!.Value);
            var job = ActivatorUtilities.CreateInstance<PowerOfficeLedgerSyncJob>(scope.ServiceProvider, proxy);
            await Should.ThrowAsync<SyncFailedException>(() => job.RunAsync(CancellationToken.None));
        }
        (await Cursor(host.Services)).ShouldBe(before);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            (await db.CustomerLedgerEntries.AnyAsync(e => e.ExternalId == first.Id)).ShouldBeTrue();
            (await db.CustomerLedgerEntries.AnyAsync(e => e.ExternalId == second.Id)).ShouldBeFalse();
        }
        await Run(host.Services);
        await Run(host.Services);
        await using var check = host.Services.CreateAsyncScope();
        var final = check.ServiceProvider.GetRequiredService<BillingDbContext>();
        (await final.CustomerLedgerEntries.CountAsync(e => e.ExternalId == first.Id || e.ExternalId == second.Id)).ShouldBe(2);
        (await final.CustomerLedgerVersions.CountAsync(v => final.CustomerLedgerEntries.Any(e =>
            (e.ExternalId == first.Id || e.ExternalId == second.Id) && e.Id == v.EntryId))).ShouldBe(2);
    }

    public class BillingFault : DispatchProxy
    {
        public IBillingApi Target { get; set; } = null!;
        public string Customer { get; set; } = string.Empty;
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod!.Name == nameof(IBillingApi.ImportCustomerLedgerAsync) && args![0] is CustomerLedgerBatch batch && batch.ExternalCustomerId == Customer)
                throw new InvalidOperationException("Synthetic interruption between customer commits.");
            return targetMethod.Invoke(Target, args);
        }
    }

    private static async Task<CustomerLedgerImportResult> Batch(IServiceProvider services, long customer, Guid org, IReadOnlyList<PoCustomerLedgerEntry> rows)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IBillingApi>().ImportCustomerLedgerAsync(new("poweroffice", Key(customer), org,
            Guid.NewGuid(), DateTimeOffset.UtcNow, rows.Select(PowerOfficeLedgerMapping.Map).ToList()), CancellationToken.None);
    }
    private static async Task<string?> Cursor(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<SyncRunner>().GetCursorAsync("poweroffice", Stream, CancellationToken.None);
    }
}
