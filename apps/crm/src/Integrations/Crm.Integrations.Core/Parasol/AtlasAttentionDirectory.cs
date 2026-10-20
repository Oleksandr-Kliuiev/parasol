using System.Text.Json;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Internal personal directory read for a technical employee. The administrative export permission is separate.</summary>
internal sealed class AtlasAttentionDirectory(ICurrentUser user, IOptions<AtlasWorkspaceOptions> options, AtlasReadClient atlas)
    : IAtlasAttentionDirectory
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = false };

    public async Task<AtlasAttentionDirectoryResult> ReadAsync(CancellationToken ct)
    {
        if (user.UserId is not { } employee || !user.HasPermission(Permissions.CustomersRead) || !user.HasPermission(Permissions.ParasolAtlasRead))
            return new("ACCESS_DENIED");
        var config = options.Value;
        if (!config.Enabled) return new("NOT_CONFIGURED");
        if (!config.Employees.TryGetValue(employee.ToString("D"), out var credential)) return new("ACCESS_DENIED");
        using var response = await atlas.IdentityExportAsync(credential, ct);
        if (response.Document is null) return new(response.Status == "SOURCE_NOT_FOUND" ? "UNAVAILABLE" : response.Status);
        try
        {
            var root = response.Document.RootElement;
            if (!Members(root, 4)) return new("INVALID_RESPONSE");
            var snapshot = root.Deserialize<AtlasIdentitySnapshot>(Json);
            if (!CustomerIdentityContract.IsValidSnapshot(snapshot) || snapshot!.WorkspaceId != credential.WorkspaceId
                || !root.GetProperty("clients").EnumerateArray().All(client => Members(client, 2))) return new("INVALID_RESPONSE");
            return new("READY", snapshot);
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or KeyNotFoundException)
        { return new("INVALID_RESPONSE"); }
    }

    private static bool Members(JsonElement value, int count) => value.ValueKind == JsonValueKind.Object
        && value.EnumerateObject().Count() == count
        && value.EnumerateObject().Select(member => member.Name).Distinct(StringComparer.Ordinal).Count() == count;
}
