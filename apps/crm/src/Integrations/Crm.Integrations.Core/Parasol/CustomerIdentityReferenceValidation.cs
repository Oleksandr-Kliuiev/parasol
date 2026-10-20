using System.Text.Json;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Strict local reference syntax. A valid reference proves no source existence or employee access.</summary>
internal static class CustomerIdentityReferenceValidation
{
    internal static bool TryRead(string payload, out AtlasCustomerReference? reference)
    {
        reference = null;
        try
        {
            using var json = JsonDocument.Parse(payload, new() { MaxDepth = 4 });
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2
                || !root.TryGetProperty("workspaceId", out var workspace) || workspace.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("clientId", out var client) || client.ValueKind != JsonValueKind.String) return false;
            reference = new(workspace.GetString()!, client.GetString()!);
            return true;
        }
        catch (JsonException) { return false; }
    }

    internal static bool IsCanonical(AtlasCustomerReference reference, string externalId) =>
        CustomerIdentityContract.IsValidId(reference.WorkspaceId) && CustomerIdentityContract.IsValidId(reference.ClientId)
        && CustomerIdentityContract.ExternalId(reference.WorkspaceId, reference.ClientId) == externalId;
}
