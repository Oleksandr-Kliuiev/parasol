using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.Licensing.Contracts;
using Crm.Licensing.Domain;
using Crm.Licensing.Features;
using Crm.Licensing.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

[Collection(OperationalSignalsCollection.Name)]
public sealed class OperationalSignalTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Unbilled_signal_counts_prior_month_only_and_recovers_after_invoicing_without_exposing_values()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var time = new ManualTimeProvider(new DateTimeOffset(2047, 6, 1, 0, 0, 0, TimeSpan.Zero));
        var source = new BillingOperationalSignals(db, time);
        var before = (await source.ReadAsync(Ct)).Single(s => s.Key == "billing:unbilled").Count;
        var overdue = PendingCharge.Create(Guid.NewGuid(), null, "Private customer note", 1, 947321.87m, 0, 25,
            "monitor-test", Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2047, 5, 31));
        var current = PendingCharge.Create(Guid.NewGuid(), null, "Current", 1, 1, 0, 25,
            "monitor-test", Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2047, 6, 1));
        db.PendingCharges.AddRange(overdue, current);
        await db.SaveChangesAsync(Ct);

        var signal = (await source.ReadAsync(Ct)).Single(s => s.Key == "billing:unbilled");
        signal.Count.ShouldBe(before + 1);
        signal.RequiredPermission.ShouldBe(Permissions.FinanceRead);
        signal.DetectedAt.ShouldNotBeNull();
        var serialized = JsonSerializer.Serialize(signal);
        serialized.ShouldNotContain("947321.87");
        serialized.ShouldNotContain("Private customer");
        overdue.MarkInvoiced(Guid.NewGuid(), time.GetUtcNow());
        await db.SaveChangesAsync(Ct);
        (await source.ReadAsync(Ct)).Single(s => s.Key == "billing:unbilled").Count.ShouldBe(before);
    }

    [Fact]
    public async Task Previous_month_license_loss_excludes_other_months_and_currencies_and_reports_explicit_recovery()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<LicensingDbContext>();
        var billing = scope.ServiceProvider.GetRequiredService<IBillingApi>();
        var time = new ManualTimeProvider(new DateTimeOffset(2048, 6, 15, 12, 0, 0, TimeSpan.Zero));
        var source = new LicensingOperationalSignals(db, billing, time);
        var before = (await source.ReadAsync(Ct)).Single(s => s.Key == "licensing:discrepancy").Count;
        var org = Guid.NewGuid();
        var line = new ExternalBilledLine(MsBillingSource.GraphExport, new DateOnly(2048, 5, 1), new DateOnly(2048, 5, 31),
            Guid.NewGuid().ToString(), "private-customer", "Private name", "subscription", "offer", "Secret offer", 1, 947321.87m, 947321.87m, "NOK");
        var loss = MsBilledLine.Create(line, org, time.GetUtcNow());
        var otherCurrency = MsBilledLine.Create(line with { InvoiceId = Guid.NewGuid().ToString(), Currency = "EUR" }, Guid.NewGuid(), time.GetUtcNow());
        var thisMonth = MsBilledLine.Create(line with { InvoiceId = Guid.NewGuid().ToString(), PeriodStart = new DateOnly(2048, 6, 1), PeriodEnd = new DateOnly(2048, 6, 30) }, Guid.NewGuid(), time.GetUtcNow());
        db.MsBilledLines.AddRange(loss, otherCurrency, thisMonth);
        await db.SaveChangesAsync(Ct);

        var signal = (await source.ReadAsync(Ct)).Single(s => s.Key == "licensing:discrepancy");
        signal.Count.ShouldBe(before + 1);
        signal.RequiredPermission.ShouldBe(Permissions.FinanceCostRead);
        JsonSerializer.Serialize(signal).ShouldNotContain("947321.87");
        JsonSerializer.Serialize(signal).ShouldNotContain("Private name");

        loss.Apply(line with { Total = 0 }, org, time.GetUtcNow());
        await db.SaveChangesAsync(Ct);
        (await source.ReadAsync(Ct)).Single(s => s.Key == "licensing:discrepancy").Count.ShouldBe(before);
    }
}

/// <summary>These assertions compare global before/after totals; other test classes must not add charges between reads.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class OperationalSignalsCollection
{
    public const string Name = "Operational signal totals";
}
