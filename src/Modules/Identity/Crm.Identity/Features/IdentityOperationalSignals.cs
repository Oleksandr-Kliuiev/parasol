using Crm.Identity.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace Crm.Identity.Features;

/// <summary>Directory confirmation is the authority for session roles; a successful unrelated Graph sync cannot refresh it.</summary>
public sealed class IdentityOperationalSignals(IdentityDbContext db, IConfiguration configuration, TimeProvider time) : IOperationalSignalSource
{
    public async Task<IReadOnlyList<OperationalSignal>> ReadAsync(CancellationToken cancellationToken)
    {
        var tenant = configuration["Integrations:MicrosoftGraph:TenantId"];
        var enabled = configuration.GetValue("Integrations:MicrosoftGraph:Enabled", false) && !string.IsNullOrWhiteSpace(tenant) &&
            !string.IsNullOrWhiteSpace(configuration["Integrations:MicrosoftGraph:CrmAppId"]);
        var last = enabled ? await db.DirectoryRoleConfirmations.AsNoTracking().Where(c => c.TenantId == tenant)
            .Select(c => (DateTimeOffset?)c.ConfirmedAt).SingleOrDefaultAsync(cancellationToken) : null;
        var threshold = Math.Clamp(configuration.GetValue("Monitoring:DirectoryConfirmationMinutes", 10), 1, 1440);
        var stale = enabled && (last is null || time.GetUtcNow() - last > TimeSpan.FromMinutes(threshold));
        return [new("identity:confirmation", "Integration", "microsoft-graph", "DirectoryConfirmationStale", last,
            stale ? 1 : 0, "ReconfirmDirectoryRoles", "docs/runbooks/15-monitoring.md#directory")];
    }
}
