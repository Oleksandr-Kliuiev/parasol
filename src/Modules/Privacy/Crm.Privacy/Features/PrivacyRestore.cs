using Crm.Privacy.Contracts;
using Crm.SharedKernel.Operations;

namespace Crm.Privacy.Features;

/// <summary>
/// Privacy's part in a restore (DEV-13, DEV-11): the erasures made after the restore point have to be applied again before anyone
/// reads on. The replay runs in crm-worker even during maintenance; this check says whether it is still to come.
/// </summary>
internal sealed class PrivacyRestoreParticipant(IPrivacyReplayGate gate) : IRestoreParticipant
{
    public string Area => "privacy";

    public Task<int> InFlightAsync(CancellationToken cancellationToken) => Task.FromResult(0);

    public async Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken) =>
        await gate.IsReplayPendingAsync(cancellationToken)
            ? [new RestoreLine(Area, "erasures", "Erasures from after the restore point are not applied again yet; the API stays closed for them.",
                "Keep crm-worker running: privacy-replay applies them within five minutes (runbook 13 § 5).", true)]
            : [new RestoreLine(Area, "erasures", "Every erasure the document store knows is applied in this database.", null, false)];

    public Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<RestoreLine>>([]);
}
