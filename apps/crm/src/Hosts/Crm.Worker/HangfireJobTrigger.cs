using Crm.Integrations.Core.Webhooks;
using Hangfire;

namespace Crm.Worker;

/// <summary>
/// Starts a recurring job now through the job server (M44 early reads), the way the administrators' "run now" does: the run is the
/// scheduled job's own, so the maintenance filter and the job's records apply to it unchanged.
/// </summary>
public sealed class HangfireJobTrigger(IRecurringJobManager jobs) : IJobTrigger
{
    public void Trigger(string jobId) => jobs.Trigger(jobId);
}
