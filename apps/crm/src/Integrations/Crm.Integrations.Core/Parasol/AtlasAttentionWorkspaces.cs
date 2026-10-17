using Microsoft.Extensions.DependencyInjection;
using Crm.SharedKernel.Results;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Each concurrent customer owns separate EF contexts; source HTTP is never performed under a database lease.</summary>
internal sealed class AtlasAttentionWorkspaces(IServiceScopeFactory scopes) : IAtlasAttentionWorkspaces
{
    public async Task<AtlasWorkspaceView> ReadAsync(AtlasAttentionBinding binding, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var identities = scope.ServiceProvider.GetRequiredService<CustomerIdentityService>();
        var before = await identities.GetAsync(binding.CustomerId, ct);
        if (!before.IsSuccess) return new(binding.CustomerId, "CUSTOMER_UNAVAILABLE");
        if (before.Value != binding.Identity) return new(binding.CustomerId, "IDENTITY_CHANGED");
        var result = await scope.ServiceProvider.GetRequiredService<AtlasWorkspaceReader>().ReadAsync(binding.CustomerId, ct);
        var workspace = result.IsSuccess ? result.Value : new AtlasWorkspaceView(binding.CustomerId,
            result.Error!.Type == ErrorType.Forbidden ? "ACCESS_DENIED" : "CUSTOMER_UNAVAILABLE");
        // A subsequent mapping change must not hide a source authentication failure from the whole-aggregate fence.
        if (workspace.Status == "ACCESS_DENIED") return workspace;
        // Recheck the full identity at this concurrent caller's boundary as well as inside the workspace read.
        var after = await identities.GetAsync(binding.CustomerId, ct);
        if (!after.IsSuccess) return new(binding.CustomerId, "CUSTOMER_UNAVAILABLE");
        return after.Value == binding.Identity ? workspace : new(binding.CustomerId, "IDENTITY_CHANGED");
    }
}
