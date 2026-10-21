using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Crm.Integrations.Core.Actions;

/// <summary>The rules every vendor action follows (M39.1), as pure functions: switches, confirmation, canonical parameters, retries.</summary>
public static class VendorActionRules
{
    public const int ReasonMinLength = 10;
    public const int ReasonMaxLength = 500;

    /// <summary>How long a destructive action waits after it was confirmed; until then it can be cancelled.</summary>
    public static readonly TimeSpan DestructiveHold = TimeSpan.FromSeconds(60);

    /// <summary>Attempts after which an action whose vendor keeps failing ends: failed, or uncertain when an attempt may have reached it.</summary>
    public const int MaxAttempts = 5;

    /// <summary>
    /// What the vendor's switches say about this kind for this customer, or null when they allow it. The worker asks again before
    /// sending, with <paramref name="credentials"/> because only it holds them. DryRun allows the action with writing off: it is then
    /// simulated and nothing is sent.
    /// </summary>
    public static VendorActionBlock? CheckSwitches(VendorActionSwitches? switches, string kind, string? externalCustomerId, bool credentials)
    {
        if (switches is null || !switches.Enabled)
        {
            return new("VND_INTEGRATION_OFF", "The integration is switched off on this instance.");
        }

        if (credentials && !switches.Configured)
        {
            return new("VND_INTEGRATION_NOT_CONFIGURED", "The worker has no credentials for this vendor.");
        }

        if (!switches.EnabledActions.Contains(kind, StringComparer.Ordinal))
        {
            return new("VND_KIND_DISABLED", "This kind of action is not switched on for the vendor (EnabledActions).");
        }

        if (!switches.WriteEnabled && !switches.DryRun)
        {
            return new("VND_WRITE_DISABLED", "Writing to the vendor is switched off (WriteEnabled).");
        }

        return switches.AllowedCustomerIds.Count > 0 && (externalCustomerId is null || !switches.AllowedCustomerIds.Contains(externalCustomerId, StringComparer.Ordinal))
            ? new("VND_CUSTOMER_NOT_ALLOWED", "The customer is not on the vendor's allow-list (WriteAllowedCustomerIds).")
            : null;
    }

    /// <summary>A disruptive or destructive action needs a reason; a destructive one also the target's name, typed.</summary>
    public static VendorActionBlock? CheckConfirmation(VendorActionLevel level, string? reason, string? typedName, string targetName)
    {
        if (level != VendorActionLevel.Standard && (reason?.Trim().Length ?? 0) is < ReasonMinLength or > ReasonMaxLength)
        {
            return new("VND_REASON_REQUIRED", $"Give a reason of {ReasonMinLength}–{ReasonMaxLength} characters.");
        }

        return level == VendorActionLevel.Destructive && !NameMatches(typedName, targetName)
            ? new("VND_NAME_MISMATCH", "Type the name of the target exactly as shown.")
            : null;
    }

    /// <summary>The typed name matches regardless of case and of spaces around or between words.</summary>
    public static bool NameMatches(string? typed, string name) =>
        typed is not null && string.Equals(Collapse(typed), Collapse(name), StringComparison.OrdinalIgnoreCase);

    private static string Collapse(string value) => string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    /// <summary>
    /// The parameters as stored and signed: an object's names in ordinal order, no whitespace, numbers as written. A preview and a
    /// command with the same parameters in another order or spacing hash the same.
    /// </summary>
    public static string Canonical(JsonElement element)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            Write(writer, element);
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>Canonical JSON of named values: what a handler stores after validating a request.</summary>
    public static string Canonical(IReadOnlyDictionary<string, object?> values) =>
        Canonical(JsonSerializer.SerializeToElement(values));

    private static void Write(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    Write(writer, property.Value);
                }

                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray())
                {
                    Write(writer, item);
                }

                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }

    /// <summary>The fingerprint a preview token signs: who acts on what, and exactly how.</summary>
    public static string Fingerprint(string system, string kind, string targetType, string targetId, string canonicalParameters) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', system, kind, targetType, targetId, canonicalParameters))));

    /// <summary>The pause before the next attempt after <paramref name="attempts"/> attempts without an answer.</summary>
    public static TimeSpan Backoff(int attempts) => attempts switch
    {
        <= 1 => TimeSpan.FromSeconds(15),
        2 => TimeSpan.FromMinutes(1),
        3 => TimeSpan.FromMinutes(5),
        _ => TimeSpan.FromMinutes(15),
    };
}
