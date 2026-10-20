using System.Text.Json;
using System.Text.RegularExpressions;

namespace Crm.Integrations.Core.Parasol;

internal static class AtlasProjectionJson
{
    internal static readonly string[] Sources = ["atera", "huntress", "microsoft365", "poweroffice"];
    internal static readonly string[] ResourceTypes = ["customer", "organization", "agent", "contact", "alert", "ticket", "incident"];
    internal static readonly string[] Severities = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

    internal static JsonElement.ArrayEnumerator Array(JsonElement value, string key, int maximum)
    {
        var array = value.GetProperty(key);
        Require(array.ValueKind == JsonValueKind.Array && array.GetArrayLength() <= maximum);
        return array.EnumerateArray();
    }

    internal static string Text(JsonElement value, string key, int maximum = 256, bool allowEmpty = false, bool multiline = false)
    {
        var text = value.GetProperty(key).GetString() ?? throw new JsonException();
        Require(text.Length <= maximum && (allowEmpty || !string.IsNullOrWhiteSpace(text))
            && !text.Any(c => char.IsControl(c) && !(multiline && (c is '\r' or '\n' or '\t'))));
        return text;
    }

    internal static string? NullableId(JsonElement value, string key) =>
        value.GetProperty(key).ValueKind == JsonValueKind.Null ? null : Text(value, key);

    internal static string Choice(JsonElement value, string key, string[] allowed)
    {
        var text = Text(value, key);
        Require(allowed.Contains(text, StringComparer.Ordinal));
        return text;
    }

    internal static int Count(JsonElement value)
    {
        Require(value.TryGetInt32(out var count) && count >= 0);
        return count;
    }

    internal static DateTimeOffset? Date(JsonElement value, string key)
    {
        var date = value.GetProperty(key);
        if (date.ValueKind == JsonValueKind.Null) return null;
        var text = date.GetString() ?? throw new JsonException();
        Require(Regex.IsMatch(text, @"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})\z", RegexOptions.CultureInvariant));
        return date.GetDateTimeOffset();
    }

    internal static void Scope(JsonElement row, AtlasCustomerReference expected)
    {
        Object(row);
        Require(Text(row, "workspaceId", 128) == expected.WorkspaceId && Text(row, "clientId", 128) == expected.ClientId);
    }

    internal static void Object(JsonElement value)
    {
        Require(value.ValueKind == JsonValueKind.Object);
        Require(value.EnumerateObject().Select(p => p.Name).Distinct(StringComparer.Ordinal).Count() == value.EnumerateObject().Count());
    }

    internal static void Require(bool condition)
    {
        if (!condition) throw new JsonException("Invalid Atlas workspace response.");
    }
}
