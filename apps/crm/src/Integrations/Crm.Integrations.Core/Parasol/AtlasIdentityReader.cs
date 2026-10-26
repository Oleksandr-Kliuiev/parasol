using System.Text.Json;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

public sealed record AtlasIdentityExportView(string Status, AtlasIdentitySnapshot? Snapshot = null, DateTimeOffset? RetrievedAt = null);

/// <summary>Read the current employee's visible Atlas directory; never infer access from CRM administration alone.</summary>
public sealed class AtlasIdentityReader(ICurrentUser user, IOptions<AtlasWorkspaceOptions> options, AtlasReadClient atlas, TimeProvider time)
{
    private static readonly JsonSerializerOptions StrictJson = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = false };

    public async Task<Result<AtlasIdentityExportView>> ReadAsync(CancellationToken ct)
    {
        if (user.UserId is not { } employeeId || !user.HasPermission(Permissions.IntegrationsManage) || !user.HasPermission(Permissions.ParasolAtlasRead))
            return Error.Forbidden("PARASOL_ATLAS_FORBIDDEN", "Customer directory administration and technical workspace access are required.");
        var config = options.Value;
        if (!config.Enabled) return new AtlasIdentityExportView("NOT_CONFIGURED");
        if (!config.Employees.TryGetValue(employeeId.ToString("D"), out var credential)) return new AtlasIdentityExportView("ACCESS_DENIED");

        using var response = await atlas.IdentityExportAsync(credential, ct);
        if (response.Document is null) return new AtlasIdentityExportView(response.Status);
        try
        {
            var root = response.Document.RootElement;
            // Closed schema, exact property casing and no duplicate JSON members. Never silently strip unexpected data.
            if (!UniqueMembers(root, 4)) return new AtlasIdentityExportView("INVALID_RESPONSE");
            var snapshot = root.Deserialize<AtlasIdentitySnapshot>(StrictJson);
            if (!CustomerIdentityContract.IsValidSnapshot(snapshot) || snapshot!.WorkspaceId != credential.WorkspaceId
                || !root.GetProperty("clients").EnumerateArray().All(c => UniqueMembers(c, 2)))
                return new AtlasIdentityExportView("INVALID_RESPONSE");
            return new AtlasIdentityExportView("READY", snapshot, time.GetUtcNow());
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException)
        {
            return new AtlasIdentityExportView("INVALID_RESPONSE");
        }
    }

    private static bool UniqueMembers(JsonElement element, int count) => element.ValueKind == JsonValueKind.Object
        && element.EnumerateObject().Count() == count
        && element.EnumerateObject().Select(p => p.Name).Distinct(StringComparer.Ordinal).Count() == count;
}
