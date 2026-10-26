using System.Globalization;
using System.Text;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Integrations.Huntress;
using Crm.Reports;
using Crm.SharedKernel.Documents;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M43 on SQL Server: Parasoll's summary of last month is filed for a serviced customer — here one whose Huntress organization sent a
/// monthly report — once, in the language set for the summaries, as Captured within the timely days after the month and as
/// Reconstructed after them; a second round finds it filed and renders nothing again. Runs with the Huntress tests: the customer comes
/// from a Huntress read.
/// </summary>
[Collection(HuntressCollection.Name)]
public sealed class CustomerMonthReportTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_serviced_customer_gets_its_summary_of_last_month_once_and_it_is_never_rendered_again()
    {
        await using var host = HuntressHost.Start(factory);
        var customer = await host.CustomerAsync();
        var oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, oslo).DateTime);
        var month = new DateOnly(today.Year, today.Month, 1).AddMonths(-1);
        host.List("/v1/reports", "reports", [new Dictionary<string, object?>
        {
            ["id"] = Random.Shared.NextInt64(50_000_000, 59_999_999), ["organization_id"] = customer.HuntressOrganizationId, ["type"] = "monthly_summary",
            ["period"] = $"{month:yyyy-MM-dd}...{month.AddMonths(1):yyyy-MM-dd}", ["agents_count"] = 17, ["incidents_reported"] = 3, ["incidents_resolved"] = 2,
            ["signals_detected"] = 1250, ["signals_investigated"] = 40, ["events_analyzed"] = 150_000, ["url"] = "https://huntress.example.invalid/reports/1.pdf",
        }]);
        await host.RunJobAsync<HuntressReportSyncJob>(job => job.RunAsync(Ct));

        CustomerMonthRun first;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            first = await scope.ServiceProvider.GetRequiredService<CustomerMonthReports>().FileMonthAsync(month, Ct, [customer.OrganizationId]);
        }

        (first.Month, first.Candidates, first.Filed, first.FiledBefore, first.Failed).ShouldBe((month.ToString("yyyy-MM", CultureInfo.InvariantCulture), 1, 1, 0, 0));

        var client = host.Client(CrmRoles.Technician);
        var item = (await (await client.GetAsync($"/api/v1/customers/organizations/{customer.OrganizationId}/stored-documents", Ct)).ReadJsonAsync())
            .GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        var provenance = BiSnapshotService.ProvenanceOf(today, month.AddMonths(1).AddDays(-1), 5);
        (item.GetProperty("kind").GetString(), item.GetProperty("sourceKey").GetString(), item.GetProperty("fileName").GetString(),
            item.GetProperty("provenance").GetString(), item.GetProperty("periodStart").GetString())
            .ShouldBe(("parasoll-monthly", StoredDocumentKinds.ParasollSummary(month), $"parasoll-{month:yyyy-MM}.pdf", provenance,
                month.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)));

        var pdf = await client.GetByteArrayAsync($"/api/v1/customers/organizations/{customer.OrganizationId}/stored-documents/{item.GetProperty("id").GetGuid()}/download", Ct);
        PdfContent.Validate(pdf);
        var text = Encoding.Latin1.GetString(pdf);
        text.ShouldContain(customer.Marker);
        text.ShouldContain("Hendelser meldt");
        text.ShouldContain("(17) Tj", Case.Sensitive, "the agents of Huntress's report for the month");
        text.ShouldContain(provenance == "Reconstructed" ? "Rekonstruert" : "Månedsrapport");

        CustomerMonthRun second;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            second = await scope.ServiceProvider.GetRequiredService<CustomerMonthReports>().FileMonthAsync(month, Ct, [customer.OrganizationId]);
        }

        (second.Filed, second.FiledBefore, second.Failed).ShouldBe((0, 1, 0));
        (await (await client.GetAsync($"/api/v1/customers/organizations/{customer.OrganizationId}/stored-documents", Ct)).ReadJsonAsync())
            .GetProperty("totalCount").GetInt32().ShouldBe(1);
    }

    [Fact]
    public async Task A_month_that_has_not_ended_is_not_summarised()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var thisMonth = new DateOnly(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1);
        await Should.ThrowAsync<InvalidOperationException>(() =>
            scope.ServiceProvider.GetRequiredService<CustomerMonthReports>().FileMonthAsync(thisMonth.AddMonths(1), Ct));
    }
}
