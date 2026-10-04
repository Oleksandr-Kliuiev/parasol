using System.Reflection;
using System.Text.RegularExpressions;
using Crm.SharedKernel.Operations;
using Crm.Worker;

namespace Crm.ArchitectureTests;

/// <summary>
/// DEV-13: during read-only maintenance crm-worker runs only what a restore needs. The job list is read from the worker's own
/// registrations, so a job added later is held back during maintenance without editing this test.
/// </summary>
public partial class MaintenanceTests
{
    private static readonly MaintenanceState ReadOnly = new(MaintenanceMode.ReadOnly, "Restore", null, "Operator (1)", DateTimeOffset.UnixEpoch, "k");

    [GeneratedRegex(@"AddOrUpdate<(?<type>[\w.]+)>\([^;]*?job\s*=>\s*job\.(?<method>\w+)\(", RegexOptions.Singleline)]
    private static partial Regex JobRegistration();

    [Fact]
    public void During_maintenance_the_worker_runs_only_the_privacy_replay_the_heartbeat_the_full_audit_check_and_the_directory_syncs()
    {
        var program = File.ReadAllText(Path.Combine(Production.Root, "src", "Hosts", "Crm.Worker", "Program.cs"));
        program.ShouldContain("GlobalJobFilters.Filters.Add(new MaintenanceJobFilter(");
        var types = typeof(MaintenanceJobFilter).Assembly.GetReferencedAssemblies()
            .Where(a => a.Name!.StartsWith("Crm.", StringComparison.Ordinal))
            .Select(Assembly.Load)
            .SelectMany(a => a.GetTypes())
            .Where(t => t.Name.EndsWith("Job", StringComparison.Ordinal))
            .GroupBy(t => t.Name)
            .ToDictionary(g => g.Key, g => g.Single());
        var jobs = JobRegistration().Matches(program)
            .Select(m => (Type: types[m.Groups["type"].Value.Split('.')[^1]], Method: m.Groups["method"].Value))
            .Distinct()
            .ToList();
        jobs.Count.ShouldBeGreaterThan(25);

        var running = jobs.Where(j => !MaintenanceJobFilter.Skips(j.Type, j.Method, ReadOnly)).Select(j => $"{j.Type.Name}.{j.Method}").Order().ToList();
        running.ShouldBe([
            "AuditIntegrityJob.VerifyAllAsync", "EntraRoleSyncJob.RunAsync", "EntraUserSyncJob.RunAsync", "PrivacyReplayJob.RunAsync", "WorkerHeartbeatJob.RunAsync",
        ]);
        jobs.ShouldAllBe(j => !MaintenanceJobFilter.Skips(j.Type, j.Method, MaintenanceState.Normal));
    }

    [GeneratedRegex(@"AddOrUpdate<(?<type>[\w.]+)>\(\s*(?<id>[\w.]+)\s*,[^;]*?job\s*=>\s*job\.(?<method>\w+)\(", RegexOptions.Singleline)]
    private static partial Regex JobRegistrationWithId();

    [Fact]
    public void An_operator_may_start_by_hand_during_maintenance_exactly_the_jobs_the_worker_runs_then()
    {
        var program = File.ReadAllText(Path.Combine(Production.Root, "src", "Hosts", "Crm.Worker", "Program.cs"));
        var types = typeof(MaintenanceJobFilter).Assembly.GetReferencedAssemblies()
            .Where(a => a.Name!.StartsWith("Crm.", StringComparison.Ordinal))
            .Select(Assembly.Load)
            .SelectMany(a => a.GetTypes())
            .Where(t => t.Name.EndsWith("Job", StringComparison.Ordinal))
            .GroupBy(t => t.Name)
            .ToDictionary(g => g.Key, g => g.Single());
        var registrations = JobRegistrationWithId().Matches(program).Select(m =>
        {
            var id = m.Groups["id"].Value;
            var field = id[(id.LastIndexOf('.') + 1)..];
            var owner = types[id[..id.LastIndexOf('.')].Split('.')[^1]];
            var jobId = (string)owner.GetField(field, BindingFlags.Public | BindingFlags.Static)!.GetRawConstantValue()!;
            return (Id: jobId, Type: types[m.Groups["type"].Value.Split('.')[^1]], Method: m.Groups["method"].Value);
        }).ToList();
        registrations.Count.ShouldBeGreaterThan(25);

        registrations.Where(r => !MaintenanceJobFilter.Skips(r.Type, r.Method, ReadOnly)).Select(r => r.Id).Order(StringComparer.Ordinal)
            .ShouldBe(Crm.Web.Http.JobEndpoints.RunDuringMaintenance.Order(StringComparer.Ordinal));
    }
}
