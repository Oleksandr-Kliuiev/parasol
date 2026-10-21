using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Crm.Licensing.Contracts;

namespace Crm.Integrations.PartnerCenter;

/// <summary>
/// One line file of the partner billing export (docs/05 §2.4). Microsoft documents JSON Lines in a gzip file
/// (<c>dataFormat: compressedJSON</c>) with every attribute capitalised: <c>CustomerId</c>, <c>ProductId</c>, <c>Subtotal</c>, …
/// (Billed Invoice Reconciliation API v2). Gzip is recognised by its first bytes, not by the file's name or headers, and attribute
/// names match whatever their case, so a plain file and the camelCase spelling read before still work. Only the fields the CRM
/// compares are kept.
/// </summary>
internal static class PartnerBillingFile
{
    public static IReadOnlyList<ExternalBilledLine> Read(byte[] content, string invoiceId) => ParseLines(Decode(content), invoiceId);

    /// <summary>The file as text. A gzip file starts with the bytes 1F 8B (RFC 1952); JSON text never does.</summary>
    internal static string Decode(byte[] content)
    {
        using Stream stream = content is [0x1F, 0x8B, ..]
            ? new GZipStream(new MemoryStream(content), CompressionMode.Decompress)
            : new MemoryStream(content);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    /// <summary>Microsoft documents JSON Lines; a whole JSON array is read as well.</summary>
    internal static IReadOnlyList<ExternalBilledLine> ParseLines(string content, string invoiceId)
    {
        var lines = new List<ExternalBilledLine>();
        var trimmed = content.TrimStart();
        if (trimmed.StartsWith('['))
        {
            using var document = JsonDocument.Parse(trimmed);
            lines.AddRange(document.RootElement.EnumerateArray().Select(e => ReadLine(e, invoiceId)).OfType<ExternalBilledLine>());
            return lines;
        }

        foreach (var row in content.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            using var document = JsonDocument.Parse(row);
            if (ReadLine(document.RootElement, invoiceId) is { } line)
            {
                lines.Add(line);
            }
        }

        return lines;
    }

    internal static ExternalBilledLine? ReadLine(JsonElement e, string invoiceId)
    {
        if (e.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var fields = Fields(e);
        // Every line also carries PartnerId, the partner's own tenant: it never stands in for a missing customer.
        var customerId = Text(fields, "CustomerId");
        var offerId = Text(fields, "OfferId") ?? Offer(Text(fields, "ProductId"), Text(fields, "SkuId"));
        if (customerId is null || offerId is null)
        {
            return null;
        }

        var start = Date(fields, "ChargeStartDate", "BillingPeriodStartDate") ?? DateOnly.FromDateTime(DateTime.UtcNow);
        var end = Date(fields, "ChargeEndDate", "BillingPeriodEndDate") ?? start;
        var quantity = Number(fields, "Quantity", "UnitCount") ?? 0m;
        var unitPrice = Number(fields, "EffectiveUnitPrice", "UnitPrice") ?? 0m;
        // Before tax, like the revenue it is compared with: Subtotal in v2 (its Total includes tax), TotalForCustomer before it.
        var total = Number(fields, "TotalForCustomer", "Subtotal", "Total") ?? decimal.Round(quantity * unitPrice, 2);
        return new ExternalBilledLine(
            MsBillingSource.GraphExport,
            start,
            end,
            Text(fields, "InvoiceNumber") ?? invoiceId,
            customerId,
            Text(fields, "CustomerName"),
            Text(fields, "SubscriptionId", "EntitlementId"),
            offerId,
            Text(fields, "OfferName", "SkuName", "ProductName"),
            quantity,
            unitPrice,
            total,
            Text(fields, "Currency", "BillingCurrency") ?? "NOK");
    }

    /// <summary>The offer as the CRM spells a Microsoft offer id: <c>ProductId:SkuId</c>, like the NCE price sheet and the catalog.</summary>
    private static string? Offer(string? productId, string? skuId) => productId is null
        ? null
        : skuId is null ? productId : $"{productId}:{skuId}";

    /// <summary>A line's attributes by name, whatever their case.</summary>
    private static Dictionary<string, JsonElement> Fields(JsonElement e)
    {
        var fields = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in e.EnumerateObject())
        {
            fields.TryAdd(property.Name, property.Value);
        }

        return fields;
    }

    private static string? Text(Dictionary<string, JsonElement> fields, params string[] names)
    {
        foreach (var name in names)
        {
            if (fields.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.String &&
                value.GetString() is { } text && !string.IsNullOrWhiteSpace(text))
            {
                return text.Trim();
            }
        }

        return null;
    }

    private static decimal? Number(Dictionary<string, JsonElement> fields, params string[] names)
    {
        foreach (var name in names)
        {
            if (!fields.TryGetValue(name, out var value))
            {
                continue;
            }

            if (value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number))
            {
                return number;
            }

            if (value.ValueKind == JsonValueKind.String &&
                decimal.TryParse(value.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }
        }

        return null;
    }

    private static DateOnly? Date(Dictionary<string, JsonElement> fields, params string[] names) =>
        Text(fields, names) is { } text && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? DateOnly.FromDateTime(parsed.UtcDateTime)
            : null;
}
