using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.TimeTracking.Features;

internal sealed partial class TimeImportService
{
    public async Task<TimeImportResult> ImportAsync(IReadOnlyCollection<ExternalTimeEntry> entries, CancellationToken ct)
    {
        if (entries.Count == 0) return new(0, 0, 0, 0);
        var groups = entries.GroupBy(e => Source(e.System)).ToList();
        await using var mutation = await TimeMutationScope.OpenAsync(db, ct); var write = mutation.Db;
        mutation.RequireFinancialOwner();
        await MonthAdmission.LockSourcesAsync(write, groups.Select(g => g.Key.ToString()), ct);
        var candidates = new List<TimeEntry>();
        foreach (var group in groups)
        {
            var ids = group.Select(e => e.ExternalId).Distinct().ToList(); var source = group.Key;
            candidates.AddRange(await write.TimeEntries.AsNoTracking().Where(e => e.Source == source && e.ExternalId != null && ids.Contains(e.ExternalId)).ToListAsync(ct));
        }
        // Strongest mode up front: any source row can have been approved since discovery. No Shared->Exclusive upgrades.
        var admission = await MonthAdmission.AcquireAsync(write, candidates.Select(e => e.WorkDate).Concat(entries.Select(e => e.WorkDate)).Select(TimeMonth.Of), MonthMode.Exclusive, ct);
        if (!admission.IsSuccess) throw new TimeAdmissionException(admission.Error!.Code);
        if (await MonthAdmission.FinancialAsync(write, ct) is { } busy) throw new TimeAdmissionException(busy.Code);
        using var local = financial.Bind(write);
        var current = await TimeRowAdmission.ReadAsync(write, candidates.Select(e => e.Id).ToList(), admission.Value, ct);
        if (!current.IsSuccess) throw new TimeAdmissionException(current.Error!.Code);
        var closed = await MonthAdmission.ClosedAsync(write, admission.Value, ct);
        bool IsClosed(DateOnly date) => closed.Contains(TimeMonth.Of(date));
        int created = 0, updated = 0, unchanged = 0, review = 0;
        foreach (var group in groups)
        {
            var existing = current.Value.Where(e => e.Source == group.Key).ToDictionary(e => e.ExternalId!);
            foreach (var incoming in group.DistinctBy(e => e.ExternalId))
            {
                if (!existing.TryGetValue(incoming.ExternalId, out var entry))
                {
                    entry = TimeEntry.FromSource(incoming);
                    if (IsClosed(entry.WorkDate)) { entry.FlagForReview("Arrived after the period was closed."); review++; }
                    write.TimeEntries.Add(entry); created++; continue;
                }
                if (entry.Status == TimeEntryStatus.Invoiced)
                {
                    if (entry.DiffersFrom(incoming)) { entry.FlagForReview("Changed in the service desk after it was invoiced; correct it in the next period."); review++; }
                    continue;
                }
                if (!entry.DiffersFrom(incoming)) { unchanged++; continue; }
                if (await billing.CheckAsync([entry], ct) is not null)
                { entry.FlagForReview("Changed in the service desk after approved billing committed this work; Finance must correct it in a later period."); review++; continue; }
                // Preserve either closed month's financial snapshot, including a New row moved by its source.
                if (IsClosed(entry.WorkDate) || IsClosed(incoming.WorkDate))
                { entry.FlagForReview("Changed in the service desk while an affected period is closed."); review++; continue; }
                if (entry.Status is TimeEntryStatus.Approved or TimeEntryStatus.NonBillable)
                {
                    var withdrawn = await approvals.WithdrawAdmittedAsync(entry, admission.Value, ct);
                    if (!withdrawn.IsSuccess) throw new TimeAdmissionException(withdrawn.Error!.Code);
                }
                entry.ApplySource(incoming); updated++;
            }
        }
        await write.SaveChangesAsync(ct); await mutation.CommitAsync(ct);
        return new(created, updated, unchanged, review);
    }
    private static TimeSource Source(string system) => Enum.TryParse<TimeSource>(system, true, out var source) ? source : TimeSource.Atera;
}
