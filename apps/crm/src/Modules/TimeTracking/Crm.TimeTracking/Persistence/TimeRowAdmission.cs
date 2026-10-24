using Crm.SharedKernel.Results;
using Crm.TimeTracking.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.TimeTracking.Persistence;

internal static class TimeRowAdmission
{
    internal static async Task<Result<MonthAdmission>> DiscoverAsync(TimeTrackingDbContext db, IReadOnlyCollection<Guid> ids,
        MonthMode mode, IEnumerable<DateOnly> incoming, CancellationToken ct)
    {
        var dates = await db.TimeEntries.AsNoTracking().Where(e => ids.Contains(e.Id)).Select(e => e.WorkDate).ToListAsync(ct);
        return await MonthAdmission.AcquireAsync(db, dates.Concat(incoming).Select(TimeMonth.Of), mode, ct);
    }

    internal static async Task<Result<IReadOnlyList<TimeEntry>>> ReadAsync(TimeTrackingDbContext db, IReadOnlyCollection<Guid> ids,
        MonthAdmission admitted, CancellationToken ct)
    {
        var rows = new List<TimeEntry>();
        foreach (var id in ids.Distinct().Order())
        {
            var row = await db.TimeEntries.FromSqlInterpolated($"SELECT * FROM [time].[TimeEntries] WITH (UPDLOCK) WHERE [Id]={id}")
                .Include(e => e.Allocations).SingleOrDefaultAsync(ct);
            if (row is null) continue;
            if (!admitted.Covers(row.WorkDate)) return MonthAdmission.Changed;
            rows.Add(row);
        }
        return rows;
    }
}
