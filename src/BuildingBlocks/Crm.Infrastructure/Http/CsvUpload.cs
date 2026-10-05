using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Net.Http.Headers;

namespace Crm.Infrastructure.Http;

/// <summary>
/// Reads the body of a CSV import (a distributor file, a price sheet, a migration file) with an explicit size limit and a
/// content type check (ASVS V5.2, F-G2-05). Without it the whole body is buffered up to Kestrel's default (about 30 MB) for
/// whatever the caller sends. The limit is <c>Imports:MaxRequestBytes</c> (default 10 MB); a larger file is answered with 413
/// before it is read, a body that is not <c>text/csv</c> or <c>text/plain</c> with 415.
/// </summary>
public static class CsvUpload
{
    public const long DefaultMaxBytes = 10L * 1024 * 1024;

    public static long MaxBytes(HttpRequest request) =>
        request.HttpContext.RequestServices.GetService<IConfiguration>()?.GetValue<long?>("Imports:MaxRequestBytes") is > 0 and var configured
            ? configured
            : DefaultMaxBytes;

    /// <summary>The body as bytes, or the failure to answer with (415, 413).</summary>
    public static async Task<(byte[]? Content, IResult? Failure)> ReadBytesAsync(HttpRequest request, CancellationToken ct)
    {
        if (!IsTextContentType(request.ContentType))
        {
            return (null, Results.Problem(
                detail: "Send the file as text/csv or text/plain.", statusCode: StatusCodes.Status415UnsupportedMediaType, title: "UNSUPPORTED_MEDIA_TYPE",
                extensions: new Dictionary<string, object?> { ["code"] = "UNSUPPORTED_MEDIA_TYPE" }));
        }

        var max = MaxBytes(request);
        if (request.ContentLength > max)
        {
            return (null, TooLarge(max));
        }

        // The server stops reading at the same limit for a body without a Content-Length (chunked); the read-only case is a
        // host that already started reading, where the counting loop below is the limit.
        var feature = request.HttpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (feature is { IsReadOnly: false })
        {
            feature.MaxRequestBodySize = max;
        }

        using var buffer = new MemoryStream();
        var chunk = new byte[81_920];
        int read;
        while ((read = await request.Body.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > max)
            {
                return (null, TooLarge(max));
            }

            buffer.Write(chunk, 0, read);
        }

        return (buffer.ToArray(), null);
    }

    /// <summary>The body decoded as UTF-8 (a byte order mark is honoured), or the failure to answer with.</summary>
    public static async Task<(string? Text, IResult? Failure)> ReadTextAsync(HttpRequest request, CancellationToken ct)
    {
        var (content, failure) = await ReadBytesAsync(request, ct);
        if (content is null)
        {
            return (null, failure);
        }

        using var reader = new StreamReader(new MemoryStream(content), new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true);
        return (await reader.ReadToEndAsync(ct), null);
    }

    public static bool IsTextContentType(string? contentType) =>
        MediaTypeHeaderValue.TryParse(contentType, out var parsed)
        && (parsed.MediaType.Equals("text/csv", StringComparison.OrdinalIgnoreCase) || parsed.MediaType.Equals("text/plain", StringComparison.OrdinalIgnoreCase));

    private static IResult TooLarge(long max) =>
        Results.Problem(
            detail: $"The file is larger than {max / (1024 * 1024)} MB. Split it and import the parts one at a time.",
            statusCode: StatusCodes.Status413PayloadTooLarge, title: "PAYLOAD_TOO_LARGE",
            extensions: new Dictionary<string, object?> { ["code"] = "PAYLOAD_TOO_LARGE", ["maxBytes"] = max });
}
