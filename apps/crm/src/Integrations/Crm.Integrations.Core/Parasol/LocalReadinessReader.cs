using System.Data.Common;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

public sealed class LocalReadinessReader
{
    internal static readonly TimeSpan Budget = TimeSpan.FromSeconds(5);
    private readonly ICurrentUser user;
    private readonly IOptions<AtlasWorkspaceOptions> atlas;
    private readonly ILocalReadinessFlags flags;
    private readonly ILocalReadinessStoredState stored;
    private readonly ILocalReadinessMappings mappings;
    private readonly TimeProvider time;

    internal LocalReadinessReader(ICurrentUser user, IOptions<AtlasWorkspaceOptions> atlas, ILocalReadinessFlags flags,
        ILocalReadinessStoredState stored, ILocalReadinessMappings mappings, TimeProvider time) =>
        (this.user, this.atlas, this.flags, this.stored, this.mappings, this.time) = (user, atlas, flags, stored, mappings, time);

    public async Task<Result<LocalReadinessView>> ReadAsync(CancellationToken ct)
    {
        var technical = user.HasPermission(Permissions.ParasolAtlasRead);
        var manage = user.HasPermission(Permissions.IntegrationsManage);
        if (!user.IsAuthenticated || user.UserId is null || (!technical && !manage))
            return Error.Forbidden("PARASOL_READINESS_FORBIDDEN", "Technical workspace or integration administration access is required.");
        ct.ThrowIfCancellationRequested();
        PersonalAtlasReadiness? personal = technical ? new(!atlas.Value.Enabled ? "DISABLED"
            : atlas.Value.Employees.ContainsKey(user.UserId.Value.ToString("D")) ? "PERSONAL_ENTRY_PRESENT" : "PERSONAL_ENTRY_MISSING") : null;
        if (!manage) return new LocalReadinessView("LOCAL_SNAPSHOT", time.GetUtcNow(), "LOCAL_ONLY", "NOT_CHECKED", personal, null);

        var local = flags.Read();
        using var deadline = new CancellationTokenSource(Budget, time);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct, deadline.Token);
        LocalStoredState? state = null;
        AtlasMappingDiagnostic? diagnostic = null;
        try { state = await stored.ReadAsync(budget.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        catch (DbException) { }
        if (user.HasPermission(Permissions.CustomersRead))
        {
            try { diagnostic = await mappings.ReadAsync(budget.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { diagnostic = LocalReadinessMappings.Unavailable(); }
            catch (DbException) { diagnostic = LocalReadinessMappings.Unavailable(); }
        }
        ct.ThrowIfCancellationRequested();
        var partial = state is null || diagnostic?.Status is "CHANGED" or "UNAVAILABLE" or "INCOMPLETE";
        return new LocalReadinessView(partial ? "PARTIAL" : "LOCAL_SNAPSHOT", time.GetUtcNow(), "LOCAL_ONLY", "NOT_CHECKED", personal,
            new(local.AuthMode, new(local.AteraEnabled, local.AteraWriteEnabled, state?.Atera),
                new(local.PowerOfficeEnabled, local.PowerOfficeWriteEnabled, state?.PowerOffice),
                new(local.GraphEnabled, local.CalendarEnabled, local.MailEnabled, local.SharePointEnabled, local.TeamsEnabled, state?.Graph),
                new("ATLAS", "UNKNOWN", "NOT_CHECKED"), diagnostic));
    }
}
