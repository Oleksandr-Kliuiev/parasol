using System.Globalization;
using System.Net;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Security.Contracts;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// What fetching one report's PDF came to: its bytes, or why it is refused — a host outside <c>ReportFileHosts</c>, a hop that is not
/// https, more redirects than allowed, a refusing status, a file too big, an answer that is not a PDF (a sign-in page). The host is the
/// last one asked, for the run's message; no address, query string or answer text leaves this record.
/// </summary>
public sealed record ReportFileFetch(byte[]? Content, string? Refusal, string Host)
{
    public static ReportFileFetch Refused(string refusal, Uri at) => new(null, refusal, at.Host);
}

/// <summary>
/// Fetches the PDF of a Huntress monthly report from the link Huntress gave (M43). A client of its own, never the API's: the API client
/// sends the key and secret with every request, and this link leads to Huntress's web site and from there to its file storage, where
/// no credential may go. Redirects are not followed by the handler but here, at most <see cref="MaxRedirects"/>, each hop checked: https
/// (http only to a loopback stand-in) and a host of <see cref="HuntressOptions.AllowedReportFileHosts"/>. The file is read up to
/// <see cref="PdfContent.MaxLength"/> and must be a whole PDF.
/// </summary>
public sealed class HuntressReportFileClient(HttpClient http, IOptions<HuntressOptions> options)
{
    public const int MaxRedirects = 3;

    private static readonly string[] PdfTypes = ["application/pdf", "application/octet-stream", "binary/octet-stream"];

    public async Task<ReportFileFetch> FetchAsync(Uri url, CancellationToken cancellationToken)
    {
        var hosts = options.Value.AllowedReportFileHosts;
        var at = url;
        for (var hop = 0; ; hop++)
        {
            if (!WebUrl.IsSecureEndpoint(at))
            {
                return ReportFileFetch.Refused("scheme", at);
            }

            if (!WebUrl.HostMatches(at, hosts))
            {
                return ReportFileFetch.Refused("host", at);
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, at);
            request.Headers.Accept.ParseAdd("application/pdf");
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (IsRedirect(response.StatusCode))
            {
                if (hop >= MaxRedirects || response.Headers.Location is not { } location)
                {
                    return ReportFileFetch.Refused("redirects", at);
                }

                at = Resolve(at, location);
                continue;
            }

            if ((int)response.StatusCode is >= 500 || response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.RequestTimeout)
            {
                // The file may be there tomorrow: the run counts it as not read, and the next run tries again.
                throw new HttpRequestException($"The report file answered {(int)response.StatusCode}.", null, response.StatusCode);
            }

            if (!response.IsSuccessStatusCode)
            {
                return ReportFileFetch.Refused("status", at);
            }

            // A sign-in page or an error page in place of the file is refused before anything is read into memory.
            var type = response.Content.Headers.ContentType?.MediaType;
            if (type is not null && !PdfTypes.Contains(type, StringComparer.OrdinalIgnoreCase))
            {
                return ReportFileFetch.Refused("type", at);
            }

            if (response.Content.Headers.ContentLength > PdfContent.MaxLength)
            {
                return ReportFileFetch.Refused("size", at);
            }

            var content = await ReadBoundedAsync(response.Content, cancellationToken);
            if (content is null)
            {
                return ReportFileFetch.Refused("size", at);
            }

            try
            {
                PdfContent.Validate(content);
            }
            catch (InvalidDataException)
            {
                return ReportFileFetch.Refused("pdf", at);
            }

            return new ReportFileFetch(content, null, at.Host);
        }
    }

    /// <summary>
    /// The next hop: a relative location against the hop it came from. On Linux and macOS a location such as <c>/blobs/7.pdf</c> parses
    /// as an absolute file path; it is a path on the same host, and is resolved like any relative one.
    /// </summary>
    internal static Uri Resolve(Uri at, Uri location) =>
        !location.IsAbsoluteUri ? new Uri(at, location)
        : location.IsFile && location.OriginalString.StartsWith('/') ? new Uri(at, location.OriginalString)
        : location;

    private static bool IsRedirect(HttpStatusCode status) =>
        status is HttpStatusCode.MovedPermanently or HttpStatusCode.Found or HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect;

    /// <summary>The body, or null when it is longer than a PDF may be.</summary>
    private static async Task<byte[]?> ReadBoundedAsync(HttpContent content, CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > PdfContent.MaxLength)
            {
                return null;
            }

            buffer.Write(chunk, 0, read);
        }

        return buffer.ToArray();
    }
}

/// <summary>
/// Files the PDF of every monthly Huntress report among the customer's documents (M43, <c>huntress-report-files</c>), after the reports
/// are read (<see cref="HuntressReportSyncJob"/>): once per report, under the customer the report's Huntress organization is linked to
/// now. A report already filed is left alone; one without a link, or whose organization is no longer linked to that customer, is not
/// filed. A file that is refused (host, type, size, not a PDF) or that could not be fetched is counted as not read, so the run is not
/// complete and the connections page shows it, and the next run tries again; it never undoes the files filed before it.
/// </summary>
public sealed class HuntressReportFileJob(
    ISecurityReports reports,
    ICustomerDocuments documents,
    HuntressReportFileClient files,
    HuntressLinkIndex links,
    SyncRunner runner,
    TimeProvider time,
    IOptions<HuntressOptions> options,
    ILogger<HuntressReportFileJob> logger)
{
    public const string JobId = "huntress-report-files";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Huntress report files skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(HuntressTypes.System, JobId, async (progress, ct) =>
        {
            var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
            var from = new DateOnly(today.Year, today.Month, 1).AddMonths(-Math.Clamp(options.Value.ReportMonths, 1, 120));
            var stored = await reports.GetMonthlyReportsAsync(HuntressTypes.System, from, null, ct);
            var linked = await links.OrganizationsAsync(ct);
            var filed = (await documents.FiledAsync(StoredDocumentKinds.HuntressMonthly, stored.Select(r => StoredDocumentKinds.HuntressReport(r.ExternalId)).ToList(), ct))
                .Select(f => f.SourceKey).ToHashSet(StringComparer.Ordinal);
            int before = 0, noLink = 0, notLinked = 0, refused = 0, failed = 0, gone = 0;
            var refusedHosts = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var report in stored)
            {
                progress.Read++;
                var key = StoredDocumentKinds.HuntressReport(report.ExternalId);
                if (filed.Contains(key))
                {
                    before++;
                    continue;
                }

                if (!(linked.TryGetValue(report.ExternalOrganizationId, out var organizationId) && organizationId == report.OrganizationId))
                {
                    notLinked++;
                    continue;
                }

                if (report.Url is null || report.PeriodStart is not { } start || !Uri.TryCreate(report.Url, UriKind.Absolute, out var url))
                {
                    noLink++;
                    continue;
                }

                ReportFileFetch fetch;
                try
                {
                    fetch = await files.FetchAsync(url, ct);
                }
                catch (Exception ex) when (HuntressFailures.IsReadFailure(ex, ct) || ex is IOException)
                {
                    failed++;
                    progress.Failed++;
                    logger.LogWarning("Huntress report {Report} could not be fetched ({ErrorType})", report.ExternalId, ex.GetType().Name);
                    continue;
                }

                if (fetch.Content is not { } content)
                {
                    refused++;
                    progress.Failed++;
                    refusedHosts.Add(fetch.Host);
                    logger.LogWarning("Huntress report {Report} was refused ({Refusal}, host {Host})", report.ExternalId, fetch.Refusal, fetch.Host);
                    continue;
                }

                var end = report.PeriodEnd is { } last && last >= start ? last : new DateOnly(start.Year, start.Month, 1).AddMonths(1).AddDays(-1);
                StoredDocumentFiled outcome;
                try
                {
                    outcome = await documents.FileAsync(new StoredDocumentFiling(
                        organizationId, StoredDocumentKinds.HuntressMonthly, key, start, end, FileName(report.ExternalId, start), content,
                        StoredDocumentProvenance.Source), ct);
                }
                catch (StoredDocumentOrganizationMissingException)
                {
                    // A deleted or merged-away customer keeps its Huntress link until someone removes it: there is no one to file for.
                    gone++;
                    continue;
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    // One report that cannot be filed does not hold back the others; the read is incomplete and tried again.
                    failed++;
                    progress.Failed++;
                    logger.LogWarning("Huntress report {Report} could not be filed ({ErrorType})", report.ExternalId, ex.GetType().Name);
                    continue;
                }

                if (outcome.Created)
                {
                    progress.Changed++;
                }
                else
                {
                    before++;
                }
            }

            progress.Message = string.Create(CultureInfo.InvariantCulture,
                $"reports {stored.Count} since {from:yyyy-MM-dd}: filed {progress.Changed}, filed before {before}, without a link {noLink}, organization not linked {notLinked}, customer gone {gone}, refused {refused}{(refusedHosts.Count > 0 ? $" (hosts {string.Join(", ", refusedHosts)})" : string.Empty)}, could not be fetched or filed {failed}");
        }, cancellationToken);
    }

    /// <summary>The file name the customer's documents show and a download keeps: the month and Huntress's id of the report.</summary>
    public static string FileName(long reportId, DateOnly periodStart) =>
        string.Create(CultureInfo.InvariantCulture, $"huntress-{periodStart:yyyy-MM}-{reportId}.pdf");
}
