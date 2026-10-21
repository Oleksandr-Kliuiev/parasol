using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Crm.Licensing.Contracts;

namespace Crm.Integrations.PartnerCenter;

/// <summary>
/// One line file of the partner billing export (docs/05 §2.4). Microsoft documents JSON Lines in a gzip file
/// (<c>dataFormat: compressedJSON</c>) with every attribute capitalised: <c>CustomerId</c>, <c>ProductId</c>, <c>Subtotal</c>, …
/// (Billed Invoice Reconciliation API v2; the fields as the new commerce reconciliation file defines them). Gzip is recognised by
/// its first bytes, not by the file's name or headers, and attribute names match whatever their case, so a plain file and the
/// camelCase spelling read before still work. Only the fields the CRM compares are kept; a row that lacks one of them is counted,
/// not read.
/// </summary>
internal static class PartnerBillingFile
{
    public static (IReadOnlyList<ExternalBilledLine> Lines, int Unread) Read(byte[] content, string invoiceId) =>
        ParseLines(Decode(content), invoiceId);

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
    internal static (IReadOnlyList<ExternalBilledLine> Lines, int Unread) ParseLines(string content, string invoiceId)
    {
        var lines = new List<ExternalBilledLine>();
        var unread = 0;
        var trimmed = content.TrimStart();
        if (trimmed.StartsWith('['))
        {
            using var document = JsonDocument.Parse(trimmed);
            foreach (var row in document.RootElement.EnumerateArray())
            {
                Add(row);
            }

            return (lines, unread);
        }

        foreach (var row in content.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            using var document = JsonDocument.Parse(row);
            Add(document.RootElement);
        }

        return (lines, unread);

        void Add(JsonElement row)
        {
            if (ReadLine(row, invoiceId) is { } line)
            {
                lines.Add(line);
            }
            else
            {
                unread++;
            }
        }
    }

    /// <summary>
    /// One line, or nothing when it lacks what the CRM compares (the customer, the product, the start of the charge: made up, it
    /// would change the line's key on every run) or carries an amount that is not a number.
    /// </summary>
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
        var start = Date(fields, "ChargeStartDate", "BillingPeriodStartDate");
        // Microsoft: "Use BillableQuantity for reconciliation". The unit price is in the pricing currency; the exchange rate
        // brings it to the billing currency the line is kept in. The cost is before tax, like the revenue it is compared with:
        // TotalForCustomer (the older file) and Total (v2) include tax and count only when Subtotal is missing.
        if (customerId is null || offerId is null || start is null ||
            !TryNumber(fields, out var quantity, "BillableQuantity", "Quantity", "UnitCount") ||
            !TryNumber(fields, out var price, "EffectiveUnitPrice", "UnitPrice") ||
            !TryNumber(fields, out var rate, "PCToBCExchangeRate") ||
            !TryNumber(fields, out var cost, "Subtotal", "TotalForCustomer", "Total"))
        {
            return null;
        }

        var units = quantity ?? 0m;
        var unitPrice = (price ?? 0m) * (rate is > 0m ? rate.Value : 1m);
        return new ExternalBilledLine(
            MsBillingSource.GraphExport,
            start.Value,
            Date(fields, "ChargeEndDate", "BillingPeriodEndDate") ?? start.Value,
            Text(fields, "InvoiceNumber") ?? invoiceId,
            customerId,
            Text(fields, "CustomerName"),
            Text(fields, "SubscriptionId", "EntitlementId"),
            offerId,
            Text(fields, "OfferName", "SkuName", "ProductName"),
            units,
            unitPrice,
            cost ?? decimal.Round(units * unitPrice, 2),
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

    /// <summary>
    /// The first of <paramref name="names"/> the line carries (null or blank counts as missing), as a number: a JSON number, or
    /// text in the invariant culture, also with an exponent ("0E-20") and with the apostrophe Microsoft's sample values start
    /// with ("'8.37"). False when that value is not a number: the line is then not read, rather than taken from the next name.
    /// </summary>
    private static bool TryNumber(Dictionary<string, JsonElement> fields, out decimal? value, params string[] names)
    {
        value = null;
        foreach (var name in names)
        {
            if (!fields.TryGetValue(name, out var field) || field.ValueKind == JsonValueKind.Null ||
                (field.ValueKind == JsonValueKind.String && string.IsNullOrWhiteSpace(field.GetString())))
            {
                continue;
            }

            var text = field.ValueKind switch
            {
                JsonValueKind.Number => field.GetRawText(),
                JsonValueKind.String => field.GetString()!.Trim().TrimStart('\''),
                _ => null,
            };
            if (decimal.TryParse(text, NumberStyles.Number | NumberStyles.AllowExponent, CultureInfo.InvariantCulture, out var number))
            {
                value = number;
                return true;
            }

            return false;
        }

        return true;
    }

    private static DateOnly? Date(Dictionary<string, JsonElement> fields, params string[] names) =>
        Text(fields, names) is { } text && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? DateOnly.FromDateTime(parsed.UtcDateTime)
            : null;
}
