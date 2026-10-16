using Crm.SharedKernel.Operations;
using Hangfire.Common;
using Hangfire.Server;

namespace Crm.Worker;

/// <summary>
/// The job half of read-only maintenance (DEV-13, ADR-021): while the CRM is read-only, crm-worker performs no job but the few
/// that maintenance needs — the privacy replay that a restore depends on, the heartbeat that monitoring reads, the full audit
/// verification an operator runs after a restore, and the two directory syncs: a role or an account taken away in Entra must end
/// in the CRM during maintenance too, and the operators' privileged actions live on the role sync's fresh confirmation. Every
/// other job is cancelled before it starts (Hangfire records it as deleted by this filter, without retries) and runs again at its
/// next occurrence. Sends inside running jobs ask the switch themselves before each item, so a job that started a moment before
/// maintenance stops at its next send.
/// </summary>
public sealed class MaintenanceJobFilter(IMaintenanceGate gate, ILogger<MaintenanceJobFilter> logger) : JobFilterAttribute, IServerFilter
{
    private static readonly HashSet<(string Type, string Method)> AllowedDuringMaintenance =
    [
        (typeof(Crm.Privacy.Features.PrivacyReplayJob).FullName!, nameof(Crm.Privacy.Features.PrivacyReplayJob.RunAsync)),
        (typeof(Crm.Integrations.Core.WorkerHeartbeatJob).FullName!, nameof(Crm.Integrations.Core.WorkerHeartbeatJob.RunAsync)),
        (typeof(Crm.Audit.Features.AuditIntegrityJob).FullName!, nameof(Crm.Audit.Features.AuditIntegrityJob.VerifyAllAsync)),
        (typeof(Crm.Integrations.MicrosoftGraph.EntraRoleSyncJob).FullName!, nameof(Crm.Integrations.MicrosoftGraph.EntraRoleSyncJob.RunAsync)),
        (typeof(Crm.Integrations.MicrosoftGraph.EntraUserSyncJob).FullName!, nameof(Crm.Integrations.MicrosoftGraph.EntraUserSyncJob.RunAsync)),
    ];

    public void OnPerforming(PerformingContext context)
    {
        var job = context.BackgroundJob.Job;
        if (!Skips(job.Type, job.Method.Name, gate.CurrentAsync(context.CancellationToken.ShutdownToken).AsTask().GetAwaiter().GetResult()))
        {
            return;
        }

        logger.LogInformation("Job {Type}.{Method} skipped: the CRM is read-only for maintenance", job.Type.Name, job.Method.Name);
        context.Canceled = true;
    }

    public void OnPerformed(PerformedContext context)
    {
    }

    /// <summary>Whether a job waits: maintenance is on and the job is not one maintenance needs.</summary>
    public static bool Skips(Type type, string method, MaintenanceState state) =>
        state.IsReadOnly && !AllowedDuringMaintenance.Contains((type.FullName!, method));
}
