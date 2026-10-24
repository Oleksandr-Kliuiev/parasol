using System.Text.Json;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

public sealed class AtlasM365Reader(CustomerIdentityService identities, ICurrentUser user,
    IOptions<AtlasWorkspaceOptions> options, AtlasReadClient atlas)
{
    public async Task<Result<AtlasM365View>> ReadAsync(Guid customerId, CancellationToken ct)
    {
        if (!user.IsAuthenticated || user.UserId is not { } employeeId || !user.HasPermission(Permissions.ParasolAtlasRead)
            || !user.HasPermission(Permissions.CustomersRead))
            return Error.Forbidden("PARASOL_M365_FORBIDDEN", "Customer and technical workspace access are required.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            var identity = await identities.GetAsync(customerId, timeout.Token);
            if (!identity.IsSuccess) return identity.Error!;
            var reference = identity.Value.Atlas;
            if (reference is null) return new AtlasM365View(customerId, "NOT_LINKED");
            var config = options.Value;
            if (!config.Enabled) return new AtlasM365View(customerId, "NOT_CONFIGURED");
            if (!config.Employees.TryGetValue(employeeId.ToString("D"), out var credential) || credential.WorkspaceId != reference.WorkspaceId)
                return new AtlasM365View(customerId, "ACCESS_DENIED");
            using var response = await atlas.M365OverviewAsync(reference.ClientId, credential, timeout.Token);
            if (response.Document is null) return new AtlasM365View(customerId, response.Status);
            var summary = AtlasM365Projection.Read(response.Document.RootElement, reference);
            var current = await identities.GetAsync(customerId, timeout.Token);
            if (!current.IsSuccess) return current.Error!;
            if (current.Value.Atlas != reference || current.Value.LinkId != identity.Value.LinkId)
                return new AtlasM365View(customerId, "IDENTITY_CHANGED");
            return new AtlasM365View(customerId, "READY", summary);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new AtlasM365View(customerId, "UNAVAILABLE"); }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        { return new AtlasM365View(customerId, "INVALID_RESPONSE"); }
    }
}
