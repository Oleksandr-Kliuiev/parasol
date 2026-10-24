using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.Billing.Contracts;

namespace Crm.Billing.Domain;

internal static class InvoiceHistoryCodec
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    public static ExternalInvoiceHistory? Read(string? value) => value is null ? null : JsonSerializer.Deserialize<ExternalInvoiceHistory>(value, Json);

    public static string Write(ExternalInvoiceHistory value)
    {
        if (value.ExternalId == Guid.Empty || value.Lines.Count > 10_000 || value.CurrencyCode.Length != 3 ||
            value.Lines.Any(l => l.Id <= 0) || value.Lines.Select(l => l.Id).Distinct().Count() != value.Lines.Count)
            throw new InvalidOperationException("Invalid invoice history identity or coverage.");
        var json = JsonSerializer.Serialize(value, Json);
        if (Encoding.UTF8.GetByteCount(json) > 4 * 1024 * 1024) throw new InvalidOperationException("Invoice history exceeds its storage limit.");
        return json;
    }
}
