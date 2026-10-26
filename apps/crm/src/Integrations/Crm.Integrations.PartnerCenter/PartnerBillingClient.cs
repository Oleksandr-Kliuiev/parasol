using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Licensing.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PartnerCenter;

public interface IPartnerBillingClient
{
    bool IsEnabled { get; }

    /// <summary>
    /// What Microsoft charged the partner on one invoice (FR-LIC-04). The export is asynchronous: it is requested, polled
    /// until it succeeds, and then read from the files its manifest names.
    /// </summary>
    Task<IReadOnlyList<ExternalBilledLine>> GetBilledLinesAsync(string invoiceId, CancellationToken cancellationToken);
}

/// <summary>
/// Microsoft partner billing reconciliation through Graph (docs/05 §2.4): <c>POST …/billed/export</c> → poll the operation →
/// read the manifest → download the line files (<see cref="PartnerBillingFile"/>). Every link after the first request comes
/// from Microsoft's answers and goes through <see cref="PartnerBillingLinks"/>: the Graph token only to the Graph origin, the
/// files only from the signed export storage.
/// </summary>
internal sealed class PartnerBillingClient(
    HttpClient http,
    PartnerCenterTokenProvider tokens,
    IOptions<PartnerCenterOptions> options,
    TimeProvider time,
    ILogger<PartnerBillingClient> logger) : IPartnerBillingClient
{
    /// <summary>The export takes minutes for a large partner; polling stops well before a job would look hung.</summary>
    private const int MaxPolls = 60;

    public bool IsEnabled => options.Value.IsConfigured && options.Value.BillingReconciliationEnabled;

    public async Task<IReadOnlyList<ExternalBilledLine>> GetBilledLinesAsync(string invoiceId, CancellationToken cancellationToken)
    {
        var operationUrl = await StartExportAsync(invoiceId, cancellationToken);
        var manifest = await WaitForManifestAsync(operationUrl, cancellationToken);
        // Every file is checked before the first one is read, so a manifest that names one wrong link reads nothing.
        var files = FileLinks(manifest)
            .Select(link => PartnerBillingLinks.ClassifyFile(options.Value.GraphBaseUrl, link, options.Value.EffectiveBillingStorageHostSuffixes))
            .ToList();

        var lines = new List<ExternalBilledLine>();
        var unread = 0;
        foreach (var file in files)
        {
            // The SAS in the link is the file's only key: no token goes with it.
            using var request = new HttpRequestMessage(HttpMethod.Get, file);
            using var response = await http.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();
            var read = PartnerBillingFile.Read(await response.Content.ReadAsByteArrayAsync(cancellationToken), invoiceId);
            lines.AddRange(read.Lines);
            unread += read.Unread;
        }

        if (unread > 0)
        {
            // A count only: a row carries customers' names and amounts.
            logger.LogWarning(
                "Partner billing export for invoice {Invoice}: {Unread} rows were not read (no customer, product or charge start, or an amount that is not a number).",
                invoiceId,
                unread);
        }

        logger.LogInformation(
            "Partner billing export for invoice {Invoice} returned {Count} lines in {Files} files.", invoiceId, lines.Count, files.Count);
        return lines;
    }

    /// <summary>
    /// The line files a manifest names, as links. Microsoft documents a directory, its SAS and the file names: a file is
    /// <c>{rootDirectory}/{name}?{sasToken}</c>, built here as one absolute address. A <c>blobUri</c>/<c>url</c> per file (the shape
    /// read before) is taken as it stands. A manifest without its root directory gives a path that would resolve onto Graph;
    /// <see cref="PartnerBillingLinks.ClassifyFile"/> refuses it rather than send the token with it.
    /// </summary>
    internal static IReadOnlyList<string> FileLinks(JsonElement manifest)
    {
        if (manifest.ValueKind != JsonValueKind.Object)
        {
            throw new PartnerCenterApiException(HttpStatusCode.OK, "The billing export's manifest is not an object.");
        }

        // A manifest without its list would read as an invoice without lines.
        if (!manifest.TryGetProperty("blobs", out var blobs) || blobs.ValueKind != JsonValueKind.Array)
        {
            throw new PartnerCenterApiException(HttpStatusCode.OK, "The billing export's manifest has no list of files.");
        }

        var root = Text(manifest, "rootDirectory")?.TrimEnd('/');
        var sas = Text(manifest, "sasToken")?.TrimStart('?');
        var links = new List<string>();
        foreach (var blob in blobs.EnumerateArray())
        {
            links.Add(Text(blob, "blobUri") ?? Text(blob, "url")
                      ?? (Text(blob, "name") is { } name ? FileLink(root, name, sas) : null)
                      ?? throw new PartnerCenterApiException(HttpStatusCode.OK, "The billing export's manifest names a file without a name."));
        }

        // A short list would read part of the invoice as the whole of it.
        if (Count(manifest, "blobCount") is { } expected && expected != links.Count)
        {
            throw new PartnerCenterApiException(
                HttpStatusCode.OK,
                string.Create(CultureInfo.InvariantCulture, $"The billing export's manifest lists {links.Count} of its {expected} files."));
        }

        return links;
    }

    /// <summary><c>{rootDirectory}/{name}?{sasToken}</c>: the address of one file as Microsoft's manifest describes it.</summary>
    private static string FileLink(string? rootDirectory, string name, string? sasToken) => string.IsNullOrEmpty(sasToken)
        ? $"{rootDirectory}/{name.TrimStart('/')}"
        : $"{rootDirectory}/{name.TrimStart('/')}?{sasToken}";

    private async Task<string> StartExportAsync(string invoiceId, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "reports/partners/billing/reconciliation/billed/export")
        {
            Content = JsonContent.Create(new { invoiceId, attributeSet = "full" }),
        };
        await AuthorizeAsync(request, cancellationToken);
        using var response = await http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return response.Headers.Location?.ToString()
               ?? await ReadOperationLocationAsync(response, cancellationToken)
               ?? throw new PartnerCenterApiException(response.StatusCode, "The billing export did not return an operation link.");
    }

    private async Task<JsonElement> WaitForManifestAsync(string operationUrl, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < MaxPolls; attempt++)
        {
            using var response = await GetLinkAsync(operationUrl, cancellationToken);
            await EnsureSuccessAsync(response, cancellationToken);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var status = document.RootElement.TryGetProperty("status", out var value) ? value.GetString() : null;
            if (string.Equals(status, "succeeded", StringComparison.OrdinalIgnoreCase))
            {
                return await ReadManifestAsync(document.RootElement, cancellationToken);
            }

            if (string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase))
            {
                throw new PartnerCenterApiException(HttpStatusCode.OK, "Microsoft reported that the billing export failed.");
            }

            await Task.Delay(TimeSpan.FromSeconds(attempt == 0 ? 2 : 5), time, cancellationToken);
        }

        throw new PartnerCenterApiException(HttpStatusCode.RequestTimeout, "The billing export did not finish in time.");
    }

    /// <summary>
    /// The manifest of a finished export. Graph v1.0 links it (<c>resourceLocation@odata.navigationLink</c>, a manifest on Graph),
    /// Partner Center's v2 example embeds it (<c>resourceLocation</c> as an object), and a link in <c>resourceLocation</c> is read
    /// as before.
    /// </summary>
    private async Task<JsonElement> ReadManifestAsync(JsonElement operation, CancellationToken cancellationToken)
    {
        if (operation.TryGetProperty("resourceLocation", out var embedded) && embedded.ValueKind == JsonValueKind.Object)
        {
            return embedded.Clone();
        }

        var link = Text(operation, "resourceLocation@odata.navigationLink") ?? Text(operation, "resourceLocation")
                   ?? throw new PartnerCenterApiException(HttpStatusCode.OK, "The billing export succeeded but returned no manifest.");
        using var response = await GetLinkAsync(link, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        return document.RootElement.Clone();
    }

    /// <summary>
    /// A GET of a link the export named (DEV-21): the Graph token goes only with a link on the configured Graph origin, a signed
    /// storage link is sent without it, and any other link fails before a request is made (<see cref="PartnerBillingLinks"/>).
    /// </summary>
    private async Task<HttpResponseMessage> GetLinkAsync(string link, CancellationToken cancellationToken)
    {
        var (uri, destination) = PartnerBillingLinks.Classify(options.Value.GraphBaseUrl, link, options.Value.EffectiveBillingStorageHostSuffixes);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        if (destination == PartnerBillingLinks.Destination.Graph)
        {
            await AuthorizeAsync(request, cancellationToken);
        }

        return await http.SendAsync(request, cancellationToken);
    }

    private async Task AuthorizeAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var token = await tokens.GetTokenAsync(PartnerCenterTokenProvider.GraphResource, cancellationToken);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    private static async Task<string?> ReadOperationLocationAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("id", out var id) && id.GetString() is { Length: > 0 } value
            ? $"reports/partners/billing/operations/{value}"
            : null;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new PartnerCenterApiException(
            response.StatusCode,
            $"Partner billing {(int)response.StatusCode} for {response.RequestMessage?.RequestUri?.AbsolutePath}: {(body.Length > 300 ? body[..300] : body)}");
    }

    /// <summary>A count, written as a number or as text.</summary>
    private static int? Count(JsonElement e, string name) =>
        !e.TryGetProperty(name, out var value) ? null
        : value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number
        : value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ? parsed
        : null;

    /// <summary>A non-empty string property of an object, else nothing.</summary>
    private static string? Text(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String &&
        value.GetString() is { } text && !string.IsNullOrWhiteSpace(text)
            ? text.Trim()
            : null;
}
