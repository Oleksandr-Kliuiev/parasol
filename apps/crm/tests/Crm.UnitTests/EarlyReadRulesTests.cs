using Crm.Integrations.Core.Webhooks;

namespace Crm.UnitTests;

/// <summary>
/// M44: when a webhook's request starts its job. A run that began after the request serves it; otherwise the job starts once a burst of
/// deliveries has settled, no run is under way or about to begin, and the job's last run began at least a minute ago.
/// </summary>
public sealed class EarlyReadRulesTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-26T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

    [Theory]
    // situation, request (seconds ago), waiting since, served up to, started by the loop, latest run began, still running, step
    [InlineData("every request served", 30, 30, 20, null, 120, false, nameof(EarlyReadStep.None))]
    [InlineData("a run began after the request", 30, 30, null, null, 10, false, nameof(EarlyReadStep.Served))]
    [InlineData("a run began after the request and is still running", 30, 30, null, null, 10, true, nameof(EarlyReadStep.Served))]
    [InlineData("a run that began before the request is still running", 30, 30, null, null, 40, true, nameof(EarlyReadStep.Wait))]
    [InlineData("the job was started and its run has not begun", 5, 5, null, 20, 300, false, nameof(EarlyReadStep.Wait))]
    [InlineData("the job was started long ago and never began", 10, 10, null, 180, 300, false, nameof(EarlyReadStep.Start))]
    [InlineData("a burst is still arriving", 1, 5, null, null, 300, false, nameof(EarlyReadStep.Wait))]
    [InlineData("a burst has kept arriving for longer than the longest wait", 1, 20, null, null, 300, false, nameof(EarlyReadStep.Start))]
    [InlineData("the job's last run began less than a minute ago", 10, 10, null, null, 40, false, nameof(EarlyReadStep.Wait))]
    [InlineData("the job's last run began more than a minute ago", 10, 10, null, null, 70, false, nameof(EarlyReadStep.Start))]
    [InlineData("the job never ran", 10, 10, null, null, null, false, nameof(EarlyReadStep.Start))]
    [InlineData("a request after a served one", 10, 10, 60, null, 90, false, nameof(EarlyReadStep.Start))]
    public void A_request_is_served_waits_or_starts_its_job(
        string situation, int requestedAgo, int waitingSinceAgo, int? servedAgo, int? triggeredAgo, int? runStartedAgo, bool running, string step)
    {
        var request = new EarlyReadRequest
        {
            System = "atera",
            Job = "atera-ticket-conversations",
            RequestedAt = Now.AddSeconds(-requestedAgo),
            WaitingSince = Now.AddSeconds(-waitingSinceAgo),
            ServedUpTo = servedAgo is { } served ? Now.AddSeconds(-served) : null,
            TriggeredAt = triggeredAgo is { } triggered ? Now.AddSeconds(-triggered) : null,
        };
        var latest = runStartedAgo is { } started ? new LatestRun(Now.AddSeconds(-started), running) : null;

        EarlyReadRules.Decide(request, latest, Now, new EarlyReadOptions()).ShouldBe(Enum.Parse<EarlyReadStep>(step), situation);
    }
}
