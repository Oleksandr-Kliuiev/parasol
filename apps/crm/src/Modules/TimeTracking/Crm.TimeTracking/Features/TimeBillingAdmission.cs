using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.TimeTracking.Features;

internal sealed class TimeBillingAdmission(TimeTrackingDbContext db, MessageHandlingContext handling) : ITimeBillingAdmission
{
    public async Task<Result<IAsyncDisposable>> HoldAsync(IReadOnlyCollection<TimeBillingSelection> selections, CancellationToken ct)
    {
        if (selections.Count == 0) return new EmptyLease();
        if (handling.MessageId is not null || ExecutionStrategy.Current is not null || db.Database.CurrentTransaction is not null)
            throw new InvalidOperationException("Billing source admission requires an independent nonretrying command.");
        if (selections.Any(s => !s.Proven || s.EntryIds.Count == 0 || s.AllocationIds.Count == 0)) return TimeBillingGuard.Changed;
        var lease = await TimeMutationScope.OpenAsync(db, ct);
        try
        {
            lease.RequireFinancialOwner();
            var ids = selections.SelectMany(s => s.EntryIds).Distinct().ToList();
            var admission = await TimeRowAdmission.DiscoverAsync(lease.Db, ids, MonthMode.Exclusive, [], ct);
            if (!admission.IsSuccess) { await lease.DisposeAsync(); return admission.Error!; }
            var current = await TimeRowAdmission.ReadAsync(lease.Db, ids, admission.Value, ct);
            if (!current.IsSuccess) { await lease.DisposeAsync(); return current.Error!; }
            if (!Matches(selections, current.Value)) { await lease.DisposeAsync(); return TimeBillingGuard.Changed; }
            return lease;
        }
        catch { await lease.DisposeAsync(); throw; }
    }

    private sealed class EmptyLease : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    internal static bool Matches(IEnumerable<TimeBillingSelection> selections, IReadOnlyCollection<TimeEntry> entries, bool allowInvoiced = false)
    {
        var rows = entries.ToDictionary(e => e.Id);
        foreach (var selection in selections)
        {
            if (!selection.Proven || selection.EntryIds.Count == 0 || selection.AllocationIds.Count == 0
                || selection.EntryIds.Distinct().Count() != selection.EntryIds.Count || selection.AllocationIds.Distinct().Count() != selection.AllocationIds.Count) return false;
            var selected = selection.EntryIds.Select(id => rows.GetValueOrDefault(id)).ToList();
            if (selected.Any(e => e is null || e.OrganizationId != selection.OrganizationId || (e.Status != TimeEntryStatus.Approved && !(allowInvoiced && e.Status == TimeEntryStatus.Invoiced)))) return false;
            var allocations = selected.SelectMany(e => e!.CurrentAllocations).ToDictionary(a => a.Id);
            if (selection.AllocationIds.Any(id => !allocations.ContainsKey(id))) return false;
            if (selection.EntryIds.Any(id => !selection.AllocationIds.Any(a => allocations[a].TimeEntryId == id))) return false;
        }
        return true;
    }
}
