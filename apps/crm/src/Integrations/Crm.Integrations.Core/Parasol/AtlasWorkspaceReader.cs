using System.Text.Json;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

public sealed class AtlasWorkspaceReader(CustomerIdentityService identities, ICurrentUser user,
    IOptions<AtlasWorkspaceOptions> options, AtlasReadClient atlas)
{
    public async Task<Result<AtlasWorkspaceView>> ReadAsync(Guid customerId, CancellationToken ct)
    {
        // Defense in depth: background jobs and other callers cannot bypass the HTTP permission boundary.
        if (user.UserId is not { } employeeId || !user.HasPermission(Permissions.ParasolAtlasRead))
            return Error.Forbidden("PARASOL_ATLAS_FORBIDDEN", "Technical workspace access is required.");
        var identity = await identities.GetAsync(customerId, ct);
        if (!identity.IsSuccess) return identity.Error!;
        var reference = identity.Value.Atlas;
        if (reference is null) return new AtlasWorkspaceView(customerId, "NOT_LINKED");
        var config = options.Value;
        if (!config.Enabled) return new AtlasWorkspaceView(customerId, "NOT_CONFIGURED");
        if (!config.Employees.TryGetValue(employeeId.ToString("D"), out var credential) || credential.WorkspaceId != reference.WorkspaceId)
            return new AtlasWorkspaceView(customerId, "ACCESS_DENIED");

        try
        {
            using var response = await atlas.OverviewAsync(reference.ClientId, credential, ct);
            if (response.Document is null) return new AtlasWorkspaceView(customerId, response.Status);
            var summary = AtlasWorkspaceProjection.Read(response.Document.RootElement, reference);
            // Fence the link instance too: deleting/recreating the same pair cannot publish its earlier read.
            var current = await identities.GetAsync(customerId, ct);
            if (!current.IsSuccess) return current.Error!;
            if (current.Value.Atlas != reference || current.Value.LinkId != identity.Value.LinkId)
                return new AtlasWorkspaceView(customerId, "IDENTITY_CHANGED");
            return new AtlasWorkspaceView(customerId, "READY", summary);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            return new AtlasWorkspaceView(customerId, "INVALID_RESPONSE");
        }
    }
}
