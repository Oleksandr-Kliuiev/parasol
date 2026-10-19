using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.PowerOffice;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

public sealed partial class PowerOfficeInvoiceHistoryTests
{
    [Theory]
    [InlineData(503, false)]
    [InlineData(200, true)]
    [InlineData(403, false)]
    public async Task Failed_line_page_keeps_last_complete_snapshot_and_checkpoint_then_resumes_without_duplicates(int status, bool nullPage)
    {
        using var po = Provider();
        await using var host = Host(po);
        var invoice = Header(null);
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice), new[] { Line() });
        await Run(host.Services);
        var original = await Read(host.Services, invoice.Id);
        var before = await Cursor(host.Services);
        var completeEarlier = Header(null) with { LastChangedDateTimeOffset = Changed.AddDays(1), BalanceLastChangedDateTimeOffset = Changed.AddDays(1) };
        var updated = invoice with { Balance = 500m, LastChangedDateTimeOffset = Changed.AddDays(1), BalanceLastChangedDateTimeOffset = Changed.AddDays(1) };
        Pages(po, "OutgoingInvoices", new[] { completeEarlier, updated });
        Pages(po, Lines(completeEarlier), new[] { Line() });
        Pages(po, Lines(invoice), new[] { Line() with { Description = "Synthetic newer line" } });
        po.Given(Request.Create().WithPath($"/v2/{Lines(invoice)}").UsingGet().WithParam("PageNumber", "2"))
            .RespondWith(nullPage ? Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/json").WithBody("null")
                : Response.Create().WithStatusCode(status));
        await Should.ThrowAsync<SyncFailedException>(() => Run(host.Services));
        (await Cursor(host.Services)).ShouldBe(before);
        (await Read(host.Services, invoice.Id)).HistoryJson.ShouldBe(original.HistoryJson);
        (await Read(host.Services, invoice.Id)).Outstanding.ShouldBe(1250m);
        (await Read(host.Services, completeEarlier.Id)).History.ShouldNotBeNull();
        Pages(po, Lines(invoice), new[] { Line() with { Description = "Synthetic newer line" } });
        await Run(host.Services);
        await Run(host.Services);
        var replayed = await Read(host.Services, invoice.Id);
        replayed.Outstanding.ShouldBe(500m);
        replayed.History!.Lines.ShouldHaveSingleItem().Description.ShouldBe("Synthetic newer line");
        replayed.Payments.ShouldHaveSingleItem().Amount.ShouldBe(750m);
        await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Invoices.CountAsync(i => i.ExternalId == invoice.Id || i.ExternalId == completeEarlier.Id)).ShouldBe(2);
        AssertReadOnly(po);
    }

    [Fact]
    public async Task Failed_header_page_keeps_checkpoint_but_completed_documents_survive()
    {
        using var po = Provider();
        await using var host = Host(po);
        var invoice = Header(null);
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice), new[] { Line() });
        po.Given(Request.Create().WithPath("/v2/OutgoingInvoices").UsingGet().WithParam("PageNumber", "2"))
            .RespondWith(Response.Create().WithStatusCode(503));
        var before = await Cursor(host.Services);
        await Should.ThrowAsync<SyncFailedException>(() => Run(host.Services));
        (await Cursor(host.Services)).ShouldBe(before);
        (await Read(host.Services, invoice.Id)).History!.Lines.Count.ShouldBe(1);
        Pages(po, "OutgoingInvoices", new[] { invoice });
        await Run(host.Services);
        (await Read(host.Services, invoice.Id)).Payments.ShouldBeEmpty();
    }

    [Fact]
    public async Task Backfill_ignores_legacy_cursor_and_incremental_reads_use_balance_filter_with_overlap()
    {
        using var po = Provider();
        await using var host = Host(po);
        await SetCursor(host.Services, "invoices", "2039-01-01T00:00:00.0000000+00:00");
        await SetCursor(host.Services, HistoryStream, null);
        var invoice = Header(null);
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice), new[] { Line() });
        await Run(host.Services);
        var first = po.LogEntries.First(e => e.RequestMessage!.Path == "/v2/OutgoingInvoices").RequestMessage!;
        first.Query!.ContainsKey("balanceLastChangedDateTimeOffsetGreaterThan").ShouldBeFalse();
        (await Cursor(host.Services)).ShouldBe(PowerOfficeCursor.Format(Changed));
        po.ResetLogEntries();
        await Run(host.Services);
        var next = po.LogEntries.First(e => e.RequestMessage!.Path == "/v2/OutgoingInvoices").RequestMessage!;
        var parameter = next.Query!["balanceLastChangedDateTimeOffsetGreaterThan"].Single();
        DateTimeOffset.Parse(parameter, CultureInfo.InvariantCulture).ShouldBe(PowerOfficeCursor.ReadFrom(Changed)!.Value);
        next.Query.ContainsKey("lastChangedDateTimeOffsetGreaterThan").ShouldBeFalse();
        await SetCursor(host.Services, "invoices", null);
    }

    [Fact]
    public async Task Missing_balance_timestamp_preserves_document_but_holds_checkpoint()
    {
        using var po = Provider();
        await using var host = Host(po);
        var invoice = Header(null) with { BalanceLastChangedDateTimeOffset = null };
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice));
        var before = await Cursor(host.Services);
        await Run(host.Services);
        (await Cursor(host.Services)).ShouldBe(before);
        (await Read(host.Services, invoice.Id)).History!.LineCoverage.ShouldBe(InvoiceLineCoverage.EmptyUnverified);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Duplicate_line_ids_are_idempotent_or_fail_on_conflict(bool conflicting)
    {
        using var po = Provider();
        await using var host = Host(po);
        var invoice = Header(null);
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice), new[] { Line() }, new[] { Line() with { Description = conflicting ? "Synthetic conflicting line" : Line().Description } });
        var before = await Cursor(host.Services);
        if (conflicting)
        {
            await Should.ThrowAsync<SyncFailedException>(() => Run(host.Services));
            (await Cursor(host.Services)).ShouldBe(before);
            await using var scope = host.Services.CreateAsyncScope();
            (await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Invoices.AnyAsync(i => i.ExternalId == invoice.Id)).ShouldBeFalse();
        }
        else
        {
            await Run(host.Services);
            (await Read(host.Services, invoice.Id)).History!.Lines.Count.ShouldBe(1);
        }
    }

    [Fact]
    public async Task Foreign_currency_and_unreconciled_lines_remain_explicit_in_saved_history()
    {
        using var po = Provider();
        await using var host = Host(po);
        var invoice = Header(null) with { CurrencyCode = "EUR", NetAmount = 80m, TotalAmount = 100m, Balance = 625m };
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice), new[] { Line() with { NetAmount = 79m, VatAmount = 20m, TotalAmount = 99m } });
        await Run(host.Services);
        var saved = await Read(host.Services, invoice.Id);
        saved.TotalIncVat.ShouldBe(1250m);
        saved.Outstanding.ShouldBe(625m);
        saved.History!.TotalAmount.ShouldBe(100m);
        saved.History.CurrencyCode.ShouldBe("EUR");
        saved.History.LineCoverage.ShouldBe(InvoiceLineCoverage.RetrievedUnverified);
    }

    private static async Task<string?> Cursor(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<SyncRunner>().GetCursorAsync("poweroffice", HistoryStream, CancellationToken.None);
    }

    private static async Task SetCursor(IServiceProvider services, string stream, string? value)
    {
        await using var scope = services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<SyncRunner>().SetCursorAsync("poweroffice", stream, value, CancellationToken.None);
    }
}
