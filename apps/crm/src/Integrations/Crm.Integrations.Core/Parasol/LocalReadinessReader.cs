using System.Data.Common;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;

namespace Crm.Integrations.Core.Parasol;

public sealed class LocalReadinessReader
{
    internal static readonly TimeSpan Budget = TimeSpan.FromSeconds(5);
    private readonly ICurrentUser user;
    private readonly ILocalReadinessFlags flags;
    private readonly ILocalReadinessStoredState stored;
    private readonly TimeProvider time;

    internal LocalReadinessReader(ICurrentUser user, ILocalReadinessFlags flags, ILocalReadinessStoredState stored, TimeProvider time) =>
        (this.user, this.flags, this.stored, this.time) = (user, flags, stored, time);

    public async Task<Result<LocalReadinessView>> ReadAsync(CancellationToken ct)
    {
        if (!user.IsAuthenticated || user.UserId is null || !user.HasPermission(Permissions.IntegrationsManage))
            return Error.Forbidden("PARASOL_READINESS_FORBIDDEN", "Integration administration access is required.");
        ct.ThrowIfCancellationRequested();
        var local = flags.Read();
        using var deadline = new CancellationTokenSource(Budget, time);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct, deadline.Token);
        LocalStoredState? state = null;
        try { state = await stored.ReadAsync(budget.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        catch (DbException) { }
        ct.ThrowIfCancellationRequested();
        return new LocalReadinessView(state is null ? "PARTIAL" : "LOCAL_SNAPSHOT", time.GetUtcNow(), "LOCAL_ONLY", "NOT_CHECKED",
            new(local.AuthMode, new(local.AteraEnabled, local.AteraWriteEnabled, state?.Atera),
                new(local.PowerOfficeEnabled, local.PowerOfficeWriteEnabled, state?.PowerOffice),
                new(local.GraphEnabled, local.CalendarEnabled, local.MailEnabled, local.SharePointEnabled, local.TeamsEnabled, state?.Graph)));
    }
}
