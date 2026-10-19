using System.Net;

namespace Crm.Integrations.PowerOffice;

public sealed record PoVoucherDocumentation(Guid VoucherId, string? VoucherType, bool? HasPdf);

internal sealed partial class PowerOfficeClient
{
    public IAsyncEnumerable<PoVoucherDocumentation> GetVoucherDocumentationAsync(Guid voucherId, CancellationToken cancellationToken) =>
        GetPagedAsync<PoVoucherDocumentation>($"VoucherDocumentation?id={voucherId:D}", null, cancellationToken);

    public async Task<byte[]> DownloadVoucherPdfArchiveAsync(Guid voucherId, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"VoucherDocumentation/Download?id={voucherId:D}&documentationType=Pdf");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode != HttpStatusCode.OK)
        {
            // No body or URL in the error: provider messages can contain private data. 204 is not an imported PDF.
            throw new PowerOfficeApiException(response.StatusCode, "PowerOffice PDF archive is not available.");
        }
        var type = response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant();
        if (type is not ("application/zip" or "application/x-zip-compressed" or "application/octet-stream"))
            throw new InvalidDataException("PowerOffice PDF response is not a ZIP archive.");
        const int max = PowerOfficePdfArchive.MaxArchiveLength;
        if (response.Content.Headers.ContentLength is > max or 0)
            throw new InvalidDataException("PowerOffice PDF archive exceeds its size limit or is empty.");
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > max) throw new InvalidDataException("PowerOffice PDF archive exceeds its size limit.");
            buffer.Write(chunk, 0, read);
        }
        if (response.Content.Headers.ContentLength is { } length && length != buffer.Length)
            throw new InvalidDataException("Truncated PowerOffice PDF response.");
        return buffer.ToArray();
    }
}
