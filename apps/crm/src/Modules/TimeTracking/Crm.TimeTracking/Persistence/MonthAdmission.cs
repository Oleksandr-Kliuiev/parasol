using System.Data;
using System.Globalization;
using Crm.SharedKernel.Results;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Crm.TimeTracking.Persistence;

internal readonly record struct TimeMonth : IComparable<TimeMonth>
{
    internal TimeMonth(int year, int month)
    { _ = new DateOnly(year, month, 1); Year = year; Month = month; }
    internal int Year { get; }
    internal int Month { get; }
    internal DateOnly Start => new(Year, Month, 1);
    internal DateOnly End => new(Year, Month, DateTime.DaysInMonth(Year, Month));
    internal string Resource => string.Create(CultureInfo.InvariantCulture, $"time:period:{Year:D4}-{Month:D2}");
    internal static TimeMonth Of(DateOnly date) => new(date.Year, date.Month);
    public int CompareTo(TimeMonth other) => Year != other.Year ? Year.CompareTo(other.Year) : Month.CompareTo(other.Month);
}

internal enum MonthMode { Shared, Exclusive }

/// <summary>All Time writers cooperate, including missing period rows. Acquire the complete sorted set before entry locks.</summary>
internal sealed class MonthAdmission
{
    private readonly HashSet<TimeMonth> months;
    private MonthAdmission(IEnumerable<TimeMonth> admitted) => months = admitted.ToHashSet();
    internal bool Covers(DateOnly date) => months.Contains(TimeMonth.Of(date));
    internal static Error Changed => Error.Conflict("TIM_WORK_CHANGED", "The work moved to another period. Reload and review the current entries.");
    internal static Error Busy => Error.Conflict("TIM_PERIOD_BUSY", "The period is being changed. Refresh its state before trying again.");
    internal static TimeMonth[] Ordered(IEnumerable<TimeMonth> requested) => requested.Select(m => new TimeMonth(m.Year, m.Month)).Distinct().Order().ToArray();

    internal static async Task<Result<MonthAdmission>> AcquireAsync(TimeTrackingDbContext db, IEnumerable<TimeMonth> requested,
        MonthMode mode, CancellationToken ct, int timeoutMilliseconds = 15000)
    {
        if (!Enum.IsDefined(mode)) throw new ArgumentOutOfRangeException(nameof(mode));
        var ordered = Ordered(requested);
        foreach (var month in ordered)
            if (await LockAsync(db, month.Resource, mode.ToString(), timeoutMilliseconds, ct) < 0) return Busy;
        return new MonthAdmission(ordered);
    }

    // Imports and technician corrections first hold source namespace admission so new source rows cannot slip past
    // mapping discovery. Every source key is acquired before every month key, in ordinal order. Manual rows do not use it.
    internal static async Task LockSourcesAsync(TimeTrackingDbContext db, IEnumerable<string> sources, CancellationToken ct)
    {
        foreach (var source in sources.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
            if (await LockAsync(db, "time:source:" + source, "Exclusive", 15000, ct) < 0)
                throw new TimeAdmissionException(Busy.Code);
    }
    private static async Task<int> LockAsync(TimeTrackingDbContext db, string resource, string mode, int timeout, CancellationToken ct)
    {
        if (db.Database.CurrentTransaction is null) throw new InvalidOperationException("Time admission requires its owning transaction.");
        ArgumentOutOfRangeException.ThrowIfNegative(timeout);
        var result = new SqlParameter("@result", SqlDbType.Int) { Direction = ParameterDirection.Output };
        try
        {
            await db.Database.ExecuteSqlRawAsync("EXEC @result = sys.sp_getapplock @Resource=@resource, @LockMode=@mode, " +
                "@LockOwner=N'Transaction', @DbPrincipal=N'public', @LockTimeout=@timeout;",
                [result, new SqlParameter("@resource", SqlDbType.NVarChar, 255) { Value = resource },
                    new SqlParameter("@mode", SqlDbType.VarChar, 32) { Value = mode }, new SqlParameter("@timeout", timeout)], ct);
        }
        catch (SqlException exception) when (ct.IsCancellationRequested)
        { throw new OperationCanceledException("Time admission was cancelled.", exception, ct); }
        ct.ThrowIfCancellationRequested();
        return (int)result.Value;
    }
    internal static async Task<HashSet<TimeMonth>> ClosedAsync(TimeTrackingDbContext db, MonthAdmission admission, CancellationToken ct)
    {
        var closed = new HashSet<TimeMonth>();
        // Read exact admitted months, not an unfenced scan of the whole period table while entry locks are held.
        foreach (var month in admission.months.Order())
            if (await db.TimePeriods.AsNoTracking().AnyAsync(p => p.Year == month.Year && p.Month == month.Month && p.IsClosed, ct)) closed.Add(month);
        return closed;
    }
}

internal sealed class TimeAdmissionException(string code) : Exception(code);
