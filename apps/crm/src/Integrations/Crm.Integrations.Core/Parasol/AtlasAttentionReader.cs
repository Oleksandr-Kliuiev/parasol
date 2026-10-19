using System.Data.Common;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Bounded personal attention snapshot. Counts describe successful selected customers, never the whole company.</summary>
public sealed class AtlasAttentionReader
{
    internal const int CustomerLimit = 50;
    internal const int Concurrency = 4;
    internal static readonly TimeSpan TotalBudget = TimeSpan.FromSeconds(15);
    internal static readonly TimeSpan CustomerBudget = TimeSpan.FromSeconds(3);
    private readonly ICurrentUser user;
    private readonly IAtlasAttentionDirectory directory;
    private readonly IAtlasAttentionMappings mappings;
    private readonly IAtlasAttentionWorkspaces workspaces;
    private readonly TimeProvider time;

    internal AtlasAttentionReader(ICurrentUser user, IAtlasAttentionDirectory directory, IAtlasAttentionMappings mappings,
        IAtlasAttentionWorkspaces workspaces, TimeProvider time)
        => (this.user, this.directory, this.mappings, this.workspaces, this.time) = (user, directory, mappings, workspaces, time);

    public async Task<Result<AtlasAttentionView>> ReadAsync(CancellationToken ct)
    {
        if (user.UserId is null || !user.IsAuthenticated || !user.HasPermission(Permissions.CustomersRead)
            || !user.HasPermission(Permissions.ParasolAtlasRead))
            return Error.Forbidden("PARASOL_ATTENTION_FORBIDDEN", "Customer and technical workspace access are required.");
        using var deadline = new CancellationTokenSource(TotalBudget, time);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct, deadline.Token);
        // Reserve the final second for a fresh mapping publication check; every stage still shares the 15-second bound.
        using var collectionDeadline = new CancellationTokenSource(TotalBudget - TimeSpan.FromSeconds(1), time);
        using var deniedStop = new CancellationTokenSource();
        using var collection = CancellationTokenSource.CreateLinkedTokenSource(budget.Token, collectionDeadline.Token, deniedStop.Token);
        AtlasAttentionDirectoryResult source;
        AtlasAttentionMappingSet intersection;
        try
        {
            source = await directory.ReadAsync(budget.Token);
            if (source.Status != "READY" || source.Snapshot is null)
                return Fatal(source.Status is "NOT_CONFIGURED" or "ACCESS_DENIED" or "UNAVAILABLE" or "INVALID_RESPONSE" ? source.Status : "INVALID_RESPONSE");
            intersection = await mappings.IntersectAsync(source.Snapshot, budget.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return Fatal("UNAVAILABLE"); }
        catch (Exception exception) when (exception is DbException or IOException or HttpRequestException) { return Fatal("UNAVAILABLE"); }

        var selected = intersection.Bindings.Take(CustomerLimit).ToArray();
        var rows = new AtlasAttentionCustomer?[selected.Length];
        var next = -1; var attempted = 0; var denied = 0; var timedOut = 0;
        async Task Worker()
        {
            while (!collection.IsCancellationRequested)
            {
                var index = Interlocked.Increment(ref next);
                if (index >= selected.Length) return;
                using var customerDeadline = new CancellationTokenSource(CustomerBudget, time);
                using var customerBudget = CancellationTokenSource.CreateLinkedTokenSource(collection.Token, customerDeadline.Token);
                try
                {
                    customerBudget.Token.ThrowIfCancellationRequested();
                    Interlocked.Increment(ref attempted);
                    var workspace = await workspaces.ReadAsync(selected[index], customerBudget.Token);
                    if (workspace.Status == "ACCESS_DENIED") { Interlocked.Exchange(ref denied, 1); await deniedStop.CancelAsync(); }
                    rows[index] = Project(selected[index], workspace);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    if (deniedStop.IsCancellationRequested) rows[index] = Failure(selected[index], "ACCESS_DENIED");
                    else { Interlocked.Exchange(ref timedOut, 1); rows[index] = Failure(selected[index], "TIMEOUT"); }
                }
                catch (Exception exception) when (exception is DbException or IOException or HttpRequestException)
                { rows[index] = Failure(selected[index], "UNAVAILABLE"); }
            }
        }
        await Task.WhenAll(Enumerable.Range(0, Math.Min(Concurrency, selected.Length)).Select(_ => Worker()));
        ct.ThrowIfCancellationRequested();
        for (var index = 0; index < rows.Length; index++)
            if (rows[index] is null)
            {
                rows[index] = Failure(selected[index], denied != 0 ? "ACCESS_DENIED" : "TIMEOUT");
                if (denied == 0) timedOut = 1;
            }

        if (denied == 0)
        {
            try
            {
                // Fresh final SQL read: a client completed early must not keep its source after a later unlink/rebind.
                var current = await mappings.CurrentAsync(selected, budget.Token);
                for (var index = 0; index < rows.Length; index++)
                    rows[index] = current.TryGetValue(selected[index].CustomerId, out var name)
                        ? rows[index]! with { CustomerName = name } : Failure(selected[index], "IDENTITY_CHANGED");
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                timedOut = 1;
                // Without the publication check, earlier technical results are no longer safe to publish.
                for (var index = 0; index < rows.Length; index++) rows[index] = Failure(selected[index], "TIMEOUT");
            }
            catch (Exception exception) when (exception is DbException or IOException)
            { for (var index = 0; index < rows.Length; index++) rows[index] = Failure(selected[index], "UNAVAILABLE"); }
        }
        ct.ThrowIfCancellationRequested();
        var customers = rows.Select(row => row!).ToArray();
        var ready = customers.Where(row => row.Status == "READY").ToArray();
        var omitted = intersection.Bindings.Count - selected.Length;
        var coverage = new AtlasAttentionCoverage(source.Snapshot!.Clients.Count, intersection.Bindings.Count, selected.Length, attempted,
            ready.Length, selected.Length - ready.Length, omitted, intersection.UnmappedClients, intersection.MappingIssues,
            omitted > 0, timedOut != 0 || deadline.IsCancellationRequested || collectionDeadline.IsCancellationRequested);
        if (denied != 0) return new AtlasAttentionView("ACCESS_DENIED", time.GetUtcNow(), coverage);
        var totals = new AtlasAttentionTotals(ready.Sum(row => (long)row.ActiveObservations!.Value), ready.Sum(row => (long)row.High!.Value), ready.Sum(row => (long)row.Critical!.Value));
        var partial = coverage.UnmappedClients > 0 || coverage.MappingIssues > 0 || coverage.FailedCustomers > 0
            || coverage.LimitReached || coverage.TimedOut || ready.Any(row => row.Completeness != "COMPLETE");
        return new AtlasAttentionView(partial ? "PARTIAL" : "READY", time.GetUtcNow(), coverage, totals, customers);
    }

    private AtlasAttentionView Fatal(string status) => new(status, time.GetUtcNow());

    private AtlasAttentionCustomer Project(AtlasAttentionBinding binding, AtlasWorkspaceView view)
    {
        if (view.CustomerId != binding.CustomerId) return Failure(binding, "INVALID_RESPONSE");
        if (view.Status != "READY" || view.Summary is not { } summary)
            return Failure(binding, view.Status is "NOT_LINKED" or "NOT_CONFIGURED" or "ACCESS_DENIED" or "SOURCE_NOT_FOUND"
                or "UNAVAILABLE" or "INVALID_RESPONSE" or "IDENTITY_CHANGED" or "CUSTOMER_UNAVAILABLE" ? view.Status : "INVALID_RESPONSE");
        var high = summary.SeverityCounts["HIGH"]; var critical = summary.SeverityCounts["CRITICAL"];
        var preview = summary.ObservationPage.Items.Where(row => row.Severity is "HIGH" or "CRITICAL").Take(3).ToArray();
        if (preview.Length != Math.Min(3, (long)high + critical) || preview.Any(row => row.Status is not ("OPEN" or "ACKNOWLEDGED")))
            return Failure(binding, "INVALID_RESPONSE");
        var deviceIds = preview.Where(row => row.DeviceStatus == "CONFIRMED").Select(row => row.DeviceId!).ToHashSet(StringComparer.Ordinal);
        var devices = summary.Devices.Where(device => deviceIds.Contains(device.Id)).ToArray();
        if (devices.Length != deviceIds.Count) return Failure(binding, "INVALID_RESPONSE");
        return new(binding.CustomerId, binding.CustomerName, "READY", summary.Mode, summary.GeneratedAt, time.GetUtcNow(), summary.Completeness,
            summary.ActiveObservations, high, critical, summary.Resources, preview, devices);
    }

    private static AtlasAttentionCustomer Failure(AtlasAttentionBinding binding, string status) =>
        new(binding.CustomerId, binding.CustomerName, status, null, null, null, null, null, null, null, null, [], []);
}
