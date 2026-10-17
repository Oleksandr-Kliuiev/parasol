using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.TimeTracking.Features;

internal sealed partial class TimeEntryService
{
    public Task<Result> AdjustAsync(Guid id, AdjustTimeEntryRequest request, CancellationToken ct) =>
        MutateEntryAsync(id, entry => entry.Adjust(request.Billable, request.WorkType, request.AfterHours), ct);

    public Task<Result> DeleteAsync(Guid id, CancellationToken ct) => MutateEntryAsync(id, entry =>
    {
        if (entry.Source != TimeSource.Crm || entry.Status != TimeEntryStatus.New)
            return Error.Conflict("TIM_NOT_DELETABLE", "Only new entries made in the CRM can be deleted.");
        entry.MarkDeleted(); return Result.Success();
    }, ct);

    private async Task<Result> MutateEntryAsync(Guid id, Func<TimeEntry, Result> action, CancellationToken ct)
    {
        await using var mutation = await TimeMutationScope.OpenAsync(db, ct); var write = mutation.Db;
        var admission = await TimeRowAdmission.DiscoverAsync(write, [id], MonthMode.Shared, [], ct);
        if (!admission.IsSuccess) return admission.Error!;
        var rows = await TimeRowAdmission.ReadAsync(write, [id], admission.Value, ct);
        if (!rows.IsSuccess) return rows.Error!;
        if (rows.Value.SingleOrDefault() is not { } entry) return TimeErrors.NotFound(id);
        if (!CanEdit(entry)) return TimeErrors.Forbidden;
        if ((await MonthAdmission.ClosedAsync(write, admission.Value, ct)).Contains(TimeMonth.Of(entry.WorkDate))) return TimeErrors.PeriodClosed;
        var result = action(entry);
        if (!result.IsSuccess) return result;
        await write.SaveChangesAsync(ct); await mutation.CommitAsync(ct); return Result.Success();
    }

    public async Task<Result<PeriodDto>> ClosePeriodAsync(int year, int month, CancellationToken ct)
    {
        if (!ValidMonth(year, month)) return Error.Validation("TIM_PERIOD_INVALID", "Choose a valid year and month.");
        var key = new TimeMonth(year, month);
        await using (var mutation = await TimeMutationScope.OpenAsync(db, ct))
        {
            var write = mutation.Db;
            var admission = await MonthAdmission.AcquireAsync(write, [key], MonthMode.Exclusive, ct);
            if (!admission.IsSuccess) return admission.Error!;
            var period = await write.TimePeriods.SingleOrDefaultAsync(p => p.Year == year && p.Month == month, ct);
            if (period is null || !period.IsClosed)
            {
                var newEntries = await write.TimeEntries.CountAsync(e => e.WorkDate >= key.Start && e.WorkDate <= key.End && e.Status == TimeEntryStatus.New, ct);
                if (newEntries > 0) return Error.Conflict("TIM_UNAPPROVED_ENTRIES", $"{newEntries} entries are still waiting for approval.",
                    new Dictionary<string, object?> { ["newEntries"] = newEntries });
                if (period is null) { period = new TimePeriod(year, month); write.TimePeriods.Add(period); }
                period.Close(currentUser.UserId, time.GetUtcNow());
                await write.SaveChangesAsync(ct);
            }
            await mutation.CommitAsync(ct);
        }
        return (await ListPeriodsAsync(year, ct)).First(p => p.Month == month);
    }

    public async Task<Result<PeriodDto>> ReopenPeriodAsync(int year, int month, string reason, CancellationToken ct)
    {
        if (!ValidMonth(year, month)) return Error.Validation("TIM_PERIOD_INVALID", "Choose a valid year and month.");
        if (string.IsNullOrWhiteSpace(reason)) return Error.Validation("TIM_REASON_REQUIRED", "Give a reason for reopening the period; it is written to the audit log.");
        if (reason.Length > 512) return Error.Validation("TIM_REASON_TOO_LONG", "The reason must be at most 512 characters.");
        await using (var mutation = await TimeMutationScope.OpenAsync(db, ct))
        {
            var write = mutation.Db;
            var admission = await MonthAdmission.AcquireAsync(write, [new(year, month)], MonthMode.Exclusive, ct);
            if (!admission.IsSuccess) return admission.Error!;
            var period = await write.TimePeriods.SingleOrDefaultAsync(p => p.Year == year && p.Month == month, ct);
            if (period is null || !period.IsClosed) return Error.NotFound("TIM_PERIOD_NOT_CLOSED", "The period is not closed.");
            period.Reopen(reason, time.GetUtcNow()); await write.SaveChangesAsync(ct); await mutation.CommitAsync(ct);
        }
        return (await ListPeriodsAsync(year, ct)).First(p => p.Month == month);
    }
    private static bool ValidMonth(int year, int month) => year is >= 1 and <= 9999 && month is >= 1 and <= 12;
}
