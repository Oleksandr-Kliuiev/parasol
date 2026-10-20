using System.Reflection;
using System.Runtime.CompilerServices;
using Crm.Billing.Contracts;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

public sealed partial class PowerOfficeLedgerTests
{
    [Fact]
    public async Task Unmatching_removes_active_invoice_relationships_and_keeps_prior_source_versions()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var voucher = Guid.NewGuid();
        var invoice = await SeedInvoice(host.Services, customer, org, voucher);
        var anchor = Entry(customer, "OutgoingInvoice") with { VoucherId = voucher, Amount = 1250m, CurrencyAmount = 1250m };
        var payment = Entry(customer, "BankJournal") with { MatchId = anchor.MatchId };
        Pages(po, new[] { anchor, payment });
        await Run(host.Services);
        (await Page(host, invoice: invoice)).GetProperty("total").GetInt32().ShouldBe(2);
        Pages(po, new[] { anchor with { MatchId = null, Balance = anchor.Amount, LastChangedDateTimeOffset = Changed.AddMinutes(1) },
            payment with { MatchId = null, Balance = payment.Amount, LastChangedDateTimeOffset = Changed.AddMinutes(1) } });
        await Run(host.Services);
        var linked = await Page(host, invoice: invoice);
        linked.GetProperty("entries").EnumerateArray().ShouldHaveSingleItem().GetProperty("source").GetProperty("kind").GetString().ShouldBe("Invoice");
        var unallocated = (await Page(host, organization: org)).GetProperty("entries").EnumerateArray().Single(e => SourceId(e) == payment.Id);
        unallocated.GetProperty("invoices").GetArrayLength().ShouldBe(0);
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var id = (await db.CustomerLedgerEntries.SingleAsync(e => e.ExternalId == payment.Id)).Id;
        (await db.CustomerLedgerVersions.CountAsync(v => v.EntryId == id)).ShouldBe(2);
    }

    [Fact]
    public async Task Ledger_before_invoice_is_linked_by_voucher_UUID_when_invoice_arrives_without_another_provider_read()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var voucher = Guid.NewGuid();
        var anchor = Entry(customer, "OutgoingInvoice") with { VoucherId = voucher, Amount = 1250m, CurrencyAmount = 1250m };
        var payment = Entry(customer, "BankJournal") with { MatchId = anchor.MatchId };
        Pages(po, new[] { anchor, payment });
        await Run(host.Services);
        (await Page(host, organization: org)).GetProperty("entries").EnumerateArray().ShouldAllBe(e => e.GetProperty("invoices").GetArrayLength() == 0);
        var requests = po.LogEntries.Count;
        var invoice = await SeedInvoice(host.Services, customer, org, voucher);
        (await Page(host, invoice: invoice)).GetProperty("total").GetInt32().ShouldBe(2);
        po.LogEntries.Count.ShouldBe(requests);
    }

    [Fact]
    public async Task Equal_invoice_numbers_and_match_ids_never_cross_source_customers_or_voucher_UUIDs()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (c1, o1) = await Customer(host); var (c2, o2) = await Customer(host);
        var v1 = Guid.NewGuid(); var v2 = Guid.NewGuid();
        var i1 = await SeedInvoice(host.Services, c1, o1, v1);
        var i2 = await SeedInvoice(host.Services, c2, o2, v2);
        var anchor = Entry(c1, "OutgoingInvoice") with { VoucherId = v1, Amount = 1250m, CurrencyAmount = 1250m };
        var second = Entry(c2, "OutgoingInvoice") with { VoucherId = v2, Amount = 1250m, CurrencyAmount = 1250m, MatchId = anchor.MatchId };
        var paid = Entry(c2, "BankJournal") with { MatchId = anchor.MatchId };
        var wrongVoucher = Entry(c2, "OutgoingInvoice") with { VoucherId = v1, MatchId = null };
        Pages(po, new[] { anchor, second, paid, wrongVoucher });
        await Run(host.Services);
        (await Page(host, invoice: i1)).GetProperty("total").GetInt32().ShouldBe(1);
        var other = (await Page(host, organization: o2)).GetProperty("entries").EnumerateArray().ToList();
        other.Single(e => SourceId(e) == paid.Id).GetProperty("invoices").EnumerateArray().ShouldHaveSingleItem().GetProperty("invoiceId").GetGuid().ShouldBe(i2);
        other.Single(e => SourceId(e) == wrongVoucher.Id).GetProperty("invoices").GetArrayLength().ShouldBe(0);
    }

    [Fact]
    public async Task Unknown_customer_is_preserved_and_link_unlink_relink_updates_the_customer_projection()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host, false);
        var (_, other) = await Customer(host, false);
        var row = Entry(customer, "BankJournal");
        Pages(po, new[] { row });
        await Run(host.Services);
        (await Page(host, organization: org)).GetProperty("total").GetInt32().ShouldBe(0);
        await Link(host.Services, customer, org);
        await Run(host.Services);
        (await Page(host, organization: org)).GetProperty("total").GetInt32().ShouldBe(1);
        await Unlink(host.Services, customer);
        await Run(host.Services);
        (await Page(host, organization: org)).GetProperty("total").GetInt32().ShouldBe(0);
        await Link(host.Services, customer, other);
        await Run(host.Services);
        (await Page(host, organization: other)).GetProperty("total").GetInt32().ShouldBe(1);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Provider_read_holds_no_customer_link_and_cancellation_keeps_checkpoint(bool cancel)
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, old) = await Customer(host);
        var (_, replacement) = await Customer(host, false);
        var source = Entry(customer, "BankJournal");
        Pages(po, new[] { source });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var scope = host.Services.CreateAsyncScope();
        var client = DispatchProxy.Create<IPowerOfficeClient, DelayedLedger>();
        var delayed = (DelayedLedger)(object)client;
        delayed.Target = scope.ServiceProvider.GetRequiredService<IPowerOfficeClient>(); delayed.Entered = entered; delayed.Resume = resume;
        var job = ActivatorUtilities.CreateInstance<PowerOfficeLedgerSyncJob>(scope.ServiceProvider, client);
        var before = await Cursor(host.Services);
        using var cancellation = new CancellationTokenSource();
        var running = job.RunAsync(cancellation.Token);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await Unlink(host.Services, customer);
            await Link(host.Services, customer, replacement);
            if (cancel) cancellation.Cancel();
        }
        finally { if (!cancel) resume.TrySetResult(); }
        if (cancel)
        {
            await Should.ThrowAsync<OperationCanceledException>(() => running);
            (await Cursor(host.Services)).ShouldBe(before);
            await Run(host.Services);
        }
        else await running;
        (await Page(host, organization: old)).GetProperty("total").GetInt32().ShouldBe(0);
        (await Page(host, organization: replacement)).GetProperty("total").GetInt32().ShouldBe(1);
    }

    [Fact]
    public async Task Concurrent_module_replays_keep_one_operation_and_one_immutable_version()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var source = Entry(customer, "BankJournal");
        var started = DateTimeOffset.UtcNow;
        async Task Save()
        {
            await using var scope = host.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IBillingApi>().ImportCustomerLedgerAsync(new("poweroffice", Key(customer), org,
                Guid.NewGuid(), started, [PowerOfficeLedgerMapping.Map(source)]), CancellationToken.None);
        }
        await Task.WhenAll(Save(), Save());
        await using var check = host.Services.CreateAsyncScope();
        var db = check.ServiceProvider.GetRequiredService<BillingDbContext>();
        var entry = await db.CustomerLedgerEntries.SingleAsync(e => e.ExternalId == source.Id);
        (await db.CustomerLedgerVersions.CountAsync(v => v.EntryId == entry.Id)).ShouldBe(1);
    }

    [Fact]
    public async Task Exact_source_customer_link_is_leased_until_the_customer_snapshot_commits()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var source = Entry(customer, "BankJournal");
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<ExternalLinkService>().WithExternalLinkAsync("poweroffice", "Customer", Key(customer), async (link, ct) =>
        {
            await using var other = host.Services.CreateAsyncScope();
            var db = other.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            (await Should.ThrowAsync<SqlException>(() => db.Database.ExecuteSqlInterpolatedAsync($"SET LOCK_TIMEOUT 200; DELETE FROM [integration].[ExternalLinks] WHERE [Id]={link!.Id};", ct))).Number.ShouldBe(1222);
            await Batch(host.Services, customer, org, [source]);
            return true;
        }, CancellationToken.None);
        await Unlink(host.Services, customer);
        (await Page(host, organization: org)).GetProperty("total").GetInt32().ShouldBe(1);
    }

    [Fact]
    public async Task A_later_source_customer_id_fills_the_same_orphan_operation_without_duplicates()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var source = Entry(null, "BankJournal");
        Pages(po, new[] { source });
        await Run(host.Services);
        Pages(po, new[] { source with { CustomerId = customer, LastChangedDateTimeOffset = Changed.AddMinutes(1) } });
        await Run(host.Services);
        await Run(host.Services);
        var rows = (await Page(host, organization: org)).GetProperty("entries").EnumerateArray().ToList();
        rows.Count.ShouldBe(1);
        SourceId(rows[0]).ShouldBe(source.Id);
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var row = await db.CustomerLedgerEntries.SingleAsync(e => e.ExternalId == source.Id);
        row.CustomerKey.ShouldBe(Key(customer));
        (await db.CustomerLedgerVersions.CountAsync(v => v.EntryId == row.Id)).ShouldBe(2);
    }

    [Fact]
    public async Task Large_history_fills_orphans_without_exceeding_SQL_parameter_limits()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var orphan = Entry(null, "BankJournal") with { Id = 3_000_000_001 };
        await using (var scope = host.Services.CreateAsyncScope())
            await scope.ServiceProvider.GetRequiredService<IBillingApi>().ImportCustomerLedgerAsync(new("poweroffice", null, null,
                Guid.NewGuid(), DateTimeOffset.UtcNow, [PowerOfficeLedgerMapping.Map(orphan)]), CancellationToken.None);
        var rows = Enumerable.Range(1, 2200).Select(n => Entry(customer, "BankJournal") with { Id = 3_100_000_000L + n }).ToList();
        rows.Add(orphan with { CustomerId = customer, LastChangedDateTimeOffset = Changed.AddMinutes(1) });
        await Batch(host.Services, customer, org, rows);
        await using var check = host.Services.CreateAsyncScope();
        var db = check.ServiceProvider.GetRequiredService<BillingDbContext>();
        (await db.CustomerLedgerEntries.CountAsync(e => e.CustomerKey == Key(customer))).ShouldBe(2201);
        (await db.CustomerLedgerEntries.SingleAsync(e => e.ExternalId == orphan.Id)).CustomerKey.ShouldBe(Key(customer));
    }

    private static async Task Unlink(IServiceProvider services, long customer)
    {
        await using var scope = services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<ExternalLinkService>();
        var link = await links.FindByExternalAsync("poweroffice", "Customer", Key(customer), CancellationToken.None);
        (await links.UnlinkAsync(link!.Id, CancellationToken.None)).ShouldBeTrue();
    }
    public class DelayedLedger : DispatchProxy
    {
        public IPowerOfficeClient Target { get; set; } = null!;
        public TaskCompletionSource Entered { get; set; } = null!;
        public TaskCompletionSource Resume { get; set; } = null!;
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => targetMethod!.Name == nameof(IPowerOfficeClient.GetCustomerLedgerAsync)
            ? Read((CancellationToken)args![0]!) : targetMethod.Invoke(Target, args);
        private async IAsyncEnumerable<PoCustomerLedgerEntry> Read([EnumeratorCancellation] CancellationToken ct)
        {
            await foreach (var row in Target.GetCustomerLedgerAsync(ct)) yield return row;
            Entered.TrySetResult();
            await Resume.Task.WaitAsync(ct);
        }
    }
}
