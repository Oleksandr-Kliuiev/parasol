using System.Globalization;
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

public sealed partial class PowerOfficeInvoiceHistoryTests
{
    [Fact]
    public async Task Unmatched_history_binds_later_and_unlink_relink_repairs_without_refetching_old_documents()
    {
        using var po = Provider();
        await using var host = Host(po);
        var first = await Admin(host).CreateOrganizationAsync(new { name = "Synthetic first account", status = "Customer" });
        var second = await Admin(host).CreateOrganizationAsync(new { name = "Synthetic replacement account", status = "Customer" });
        var customer = Random.Shared.NextInt64(840000000, 849999999);
        var invoice = Header(customer);
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice), new[] { Line() });
        await Run(host.Services);
        (await Read(host.Services, invoice.Id)).OrganizationId.ShouldBeNull();
        Pages(po, "OutgoingInvoices");
        await Link(host.Services, customer, first);
        await Run(host.Services);
        (await Read(host.Services, invoice.Id)).OrganizationId.ShouldBe(first);
        await Unlink(host.Services, customer);
        await Run(host.Services);
        var unbound = await Read(host.Services, invoice.Id);
        unbound.OrganizationId.ShouldBeNull();
        unbound.BasisId.ShouldBeNull();
        await Link(host.Services, customer, second);
        await Run(host.Services);
        (await Read(host.Services, invoice.Id)).OrganizationId.ShouldBe(second);
        (await Read(host.Services, invoice.Id)).HistoryJson.ShouldBe(unbound.HistoryJson);
    }

    [Fact]
    public async Task Customer_mapping_is_resolved_after_provider_lines_finish()
    {
        using var po = Provider();
        await using var host = Host(po);
        var first = await Admin(host).CreateOrganizationAsync(new { name = "Synthetic old mapping", status = "Customer" });
        var second = await Admin(host).CreateOrganizationAsync(new { name = "Synthetic new mapping", status = "Customer" });
        var customer = Random.Shared.NextInt64(850000000, 859999999);
        await Link(host.Services, customer, first);
        var invoice = Header(customer);
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice), new[] { Line() });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var scope = host.Services.CreateAsyncScope();
        var proxy = DispatchProxy.Create<IPowerOfficeClient, DelayedInvoiceLines>();
        var fault = (DelayedInvoiceLines)(object)proxy;
        fault.Target = scope.ServiceProvider.GetRequiredService<IPowerOfficeClient>();
        fault.Entered = entered;
        fault.Resume = resume;
        var job = ActivatorUtilities.CreateInstance<PowerOfficeInvoiceSyncJob>(scope.ServiceProvider, proxy);
        var running = job.RunAsync(CancellationToken.None);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await Unlink(host.Services, customer);
            await Link(host.Services, customer, second);
        }
        finally { resume.TrySetResult(); }
        await running.WaitAsync(TimeSpan.FromSeconds(15));
        (await Read(host.Services, invoice.Id)).OrganizationId.ShouldBe(second);
    }

    [Fact]
    public async Task Source_link_is_held_until_billing_commits_and_released_afterwards()
    {
        using var po = Provider();
        await using var host = Host(po);
        var organization = await Admin(host).CreateOrganizationAsync(new { name = "Synthetic leased mapping", status = "Customer" });
        var customer = Random.Shared.NextInt64(860000000, 869999999);
        await Link(host.Services, customer, organization);
        var invoice = Header(customer);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var links = scope.ServiceProvider.GetRequiredService<ExternalLinkService>();
            await links.WithExternalLinkAsync("poweroffice", "Customer", customer.ToString(CultureInfo.InvariantCulture), async (link, ct) =>
            {
                await using var competing = host.Services.CreateAsyncScope();
                var db = competing.ServiceProvider.GetRequiredService<IntegrationDbContext>();
                var blocked = await Should.ThrowAsync<SqlException>(() => db.Database.ExecuteSqlInterpolatedAsync($"SET LOCK_TIMEOUT 200; DELETE FROM [integration].[ExternalLinks] WHERE [Id]={link!.Id};", ct));
                blocked.Number.ShouldBe(1222);
                await scope.ServiceProvider.GetRequiredService<IBillingApi>().UpsertInvoicesAsync(
                    [PowerOfficeInvoiceMapping.Map(invoice, [Line()]) with { OrganizationId = link!.EntityId }], ct);
                return true;
            }, CancellationToken.None);
        }
        (await Read(host.Services, invoice.Id)).OrganizationId.ShouldBe(organization);
        await Unlink(host.Services, customer);
    }

    [Fact]
    public async Task Concurrent_module_replays_create_one_invoice_with_one_snapshot()
    {
        using var po = Provider();
        await using var host = Host(po);
        var invoice = PowerOfficeInvoiceMapping.Map(Header(null), [Line()]);
        async Task Save()
        {
            await using var scope = host.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IBillingApi>().UpsertInvoicesAsync([invoice], CancellationToken.None);
        }
        await Task.WhenAll(Save(), Save());
        await using var check = host.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<BillingDbContext>().Invoices.CountAsync(i => i.ExternalId == invoice.History!.ExternalId)).ShouldBe(1);
        (await Read(host.Services, invoice.History!.ExternalId)).Payments.ShouldBeEmpty();
    }

    private static async Task Unlink(IServiceProvider services, long customer)
    {
        await using var scope = services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<ExternalLinkService>();
        var link = await links.FindByExternalAsync("poweroffice", "Customer", customer.ToString(CultureInfo.InvariantCulture), CancellationToken.None);
        (await links.UnlinkAsync(link!.Id, CancellationToken.None)).ShouldBeTrue();
    }

    public class DelayedInvoiceLines : DispatchProxy
    {
        public IPowerOfficeClient Target { get; set; } = null!;
        public TaskCompletionSource Entered { get; set; } = null!;
        public TaskCompletionSource Resume { get; set; } = null!;
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => targetMethod!.Name == nameof(IPowerOfficeClient.GetOutgoingInvoiceLinesAsync)
            ? Read((Guid)args![0]!, (CancellationToken)args[1]!) : targetMethod.Invoke(Target, args);
        private async IAsyncEnumerable<PoOutgoingInvoiceLine> Read(Guid id, [EnumeratorCancellation] CancellationToken ct)
        {
            await foreach (var line in Target.GetOutgoingInvoiceLinesAsync(id, ct)) yield return line;
            Entered.TrySetResult();
            await Resume.Task.WaitAsync(ct);
        }
    }
}
