using System.Globalization;
using System.Net;
using Crm.Authorization;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.Huntress;
using Microsoft.AspNetCore.Hosting;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M43 on SQL Server: the PDF of a Huntress monthly report is fetched through the link Huntress gives — a redirect to its storage, no
/// credentials — and filed once among the customer's documents; a link off the allowed hosts or a sign-in page in place of the file is
/// refused, counted as not read (the run is not complete), and tried again by the next run.
/// </summary>
[Collection(HuntressCollection.Name)]
public sealed class HuntressReportFileTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static HuntressHost Start(CrmWebFactory factory, params string[] hosts) => HuntressHost.Start(factory, configure: (builder, huntress) =>
    {
        var allowed = hosts.Length > 0 ? hosts : [new Uri(huntress.Url!).Host];
        for (var i = 0; i < allowed.Length; i++)
        {
            builder.UseSetting($"Integrations:Huntress:ReportFileHosts:{i}", allowed[i]);
        }
    });

    private static Dictionary<string, object?> Report(long id, long organizationId, string url, DateOnly month) => new()
    {
        ["id"] = id, ["organization_id"] = organizationId, ["type"] = "monthly_summary",
        ["period"] = $"{month:yyyy-MM-dd}...{month.AddMonths(1):yyyy-MM-dd}", ["agents_count"] = 12, ["incidents_reported"] = 1, ["incidents_resolved"] = 1,
        ["signals_detected"] = 40, ["signals_investigated"] = 12, ["events_analyzed"] = 150_000, ["url"] = url,
        ["created_at"] = month.AddMonths(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + "T04:00:00Z",
    };

    private static DateOnly LastMonth()
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        return new DateOnly(today.Year, today.Month, 1).AddMonths(-1);
    }

    private static long Id() => Random.Shared.NextInt64(40_000_000, 49_999_999);

    [Fact]
    public async Task A_report_pdf_is_fetched_through_its_redirect_and_filed_once_among_the_customers_documents()
    {
        await using var host = Start(factory);
        var customer = await host.CustomerAsync();
        var reportId = Id();
        var month = LastMonth();
        var pdf = StoredDocumentTests.Pdf($"Synthetic Huntress report {reportId}");
        host.List("/v1/reports", "reports", [Report(reportId, customer.HuntressOrganizationId, $"{host.Huntress.Url}/files/{reportId}.pdf", month)]);
        host.Huntress.Given(Request.Create().WithPath($"/files/{reportId}.pdf").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(302).WithHeader("Location", $"/blobs/{reportId}.pdf?disposition=download"));
        host.Huntress.Given(Request.Create().WithPath($"/blobs/{reportId}.pdf").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/pdf").WithBody(pdf));

        await host.RunJobAsync<HuntressReportSyncJob>(job => job.RunAsync(Ct));
        await host.RunJobAsync<HuntressReportFileJob>(job => job.RunAsync(Ct));

        // The shared database also holds the reports of other tests' customers, whose links lead nowhere now: only this customer's
        // report is looked at here.
        var run = await host.LatestRunAsync(HuntressReportFileJob.JobId);
        run.Status.ShouldBe(SyncRunStatus.Succeeded);
        run.Changed.ShouldBeGreaterThanOrEqualTo(1);
        // Huntress's API key never travels to the file's address.
        host.Huntress.LogEntries.Where(e => e.RequestMessage!.Path.StartsWith("/files/", StringComparison.Ordinal) || e.RequestMessage.Path.StartsWith("/blobs/", StringComparison.Ordinal))
            .ShouldAllBe(e => e.RequestMessage!.Headers == null || !e.RequestMessage.Headers.ContainsKey("Authorization"));

        var client = host.Client(CrmRoles.Technician);
        var list = await (await client.GetAsync($"/api/v1/customers/organizations/{customer.OrganizationId}/stored-documents", Ct)).ReadJsonAsync();
        var item = list.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        (item.GetProperty("kind").GetString(), item.GetProperty("sourceKey").GetString(), item.GetProperty("fileName").GetString(), item.GetProperty("provenance").GetString())
            .ShouldBe(("huntress-monthly", $"huntress:report:{reportId}", $"huntress-{month:yyyy-MM}-{reportId}.pdf", "Source"));
        (await client.GetByteArrayAsync($"/api/v1/customers/organizations/{customer.OrganizationId}/stored-documents/{item.GetProperty("id").GetGuid()}/download", Ct))
            .ShouldBe(pdf);

        // The next run finds the report filed and fetches nothing.
        var fetched = host.Count("GET", $"/blobs/{reportId}.pdf");
        await host.RunJobAsync<HuntressReportFileJob>(job => job.RunAsync(Ct));
        host.Count("GET", $"/blobs/{reportId}.pdf").ShouldBe(fetched);
        (await host.LatestRunAsync(HuntressReportFileJob.JobId)).Message!.ShouldContain("filed 0,");
    }

    [Fact]
    public async Task A_file_off_the_allowed_hosts_or_a_sign_in_page_is_refused_and_the_run_is_not_complete_until_it_is_filed()
    {
        await using var host = Start(factory);
        var customer = await host.CustomerAsync();
        var (foreign, signIn) = (Id(), Id());
        var month = LastMonth();
        host.List("/v1/reports", "reports", [
            Report(foreign, customer.HuntressOrganizationId, $"https://files.example.invalid/{foreign}.pdf", month),
            Report(signIn, customer.HuntressOrganizationId, $"{host.Huntress.Url}/files/{signIn}.pdf", month.AddMonths(-1)),
        ]);
        host.Huntress.Given(Request.Create().WithPath($"/files/{signIn}.pdf").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(200).WithHeader("Content-Type", "text/html; charset=utf-8").WithBody("<html>Sign in to Huntress</html>"));

        await host.RunJobAsync<HuntressReportSyncJob>(job => job.RunAsync(Ct));
        await host.RunJobAsync<HuntressReportFileJob>(job => job.RunAsync(Ct));

        var run = await host.LatestRunAsync(HuntressReportFileJob.JobId);
        run.Status.ShouldBe(SyncRunStatus.Succeeded);
        run.Failed.ShouldBeGreaterThanOrEqualTo(2);
        var message = run.Message.ShouldNotBeNull();
        message.ShouldContain("files.example.invalid");
        message.ShouldNotContain("/files/");
        var list = await (await host.Client().GetAsync($"/api/v1/customers/organizations/{customer.OrganizationId}/stored-documents", Ct)).ReadJsonAsync();
        list.GetProperty("totalCount").GetInt32().ShouldBe(0);
        host.Count("GET", $"/files/{signIn}.pdf").ShouldBe(1);

        // Once the link answers with the file, the next run files it.
        host.Huntress.Given(Request.Create().WithPath($"/files/{signIn}.pdf").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/pdf").WithBody(StoredDocumentTests.Pdf($"Report {signIn}")));
        await host.RunJobAsync<HuntressReportFileJob>(job => job.RunAsync(Ct));
        list = await (await host.Client().GetAsync($"/api/v1/customers/organizations/{customer.OrganizationId}/stored-documents", Ct)).ReadJsonAsync();
        list.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("sourceKey").GetString()!).ShouldBe([$"huntress:report:{signIn}"]);
    }
}
