using System.Data;
using System.Data.Common;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

internal static class TimePeriodTestSupport
{
    private static int nextYear = 4200;
    internal static DateOnly Date() => new(Interlocked.Increment(ref nextYear), 3, 17);
    internal static TimeEntryRequest Request(Guid org, DateOnly date, Guid? requestId = null) =>
        new(org, null, date, 1m, "Remote", true, false, false, "Synthetic explicit work", null, null, null, ClientRequestId: requestId);
    internal static ExternalTimeEntry Incoming(Guid org, DateOnly date, string? external = null) =>
        new("atera", external ?? Guid.NewGuid().ToString("N"), org, null, null, "Synthetic ticket", null, "synthetic-technician-" + Guid.NewGuid().ToString("N"), "Synthetic employee", date, null, null, 1m, "Remote", true, false, "Synthetic source work");
    internal static async Task<TimeEntry> Seed(CrmWebFactory factory, Guid org, Guid employee, DateOnly date, bool approved = false, ExternalTimeEntry? incoming = null)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var row = incoming is null ? TimeEntry.CreateManual(new(org, employee, date, 1m, "Remote", true, false, false, "Synthetic seed", null, null, null, null)).Value : TimeEntry.FromSource(incoming);
        if (approved) row.Approve(employee, DateTimeOffset.UtcNow, null, [new(row.Id, TimeClassification.Rate, 1m, 1m, 100m, null)]);
        db.TimeEntries.Add(row); await db.SaveChangesAsync(TestContext.Current.CancellationToken); return row;
    }
    internal static async Task<int> Probe(CrmWebFactory factory, DateOnly date, string mode, int timeout = 0)
    {
        var ct = TestContext.Current.CancellationToken;
        await using var connection = new SqlConnection(factory.RuntimeConnectionString); await connection.OpenAsync(ct);
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(ct);
        await using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=@resource, @LockMode=@mode,@LockOwner='Transaction',@DbPrincipal='public',@LockTimeout=@timeout; SELECT @r;";
        command.Parameters.AddWithValue("resource", TimeMonth.Of(date).Resource); command.Parameters.AddWithValue("mode", mode); command.Parameters.AddWithValue("timeout", timeout);
        return (int)(await command.ExecuteScalarAsync(ct))!;
    }
    internal static async Task WaitForSqlWait(CrmWebFactory factory, int sessionId)
    {
        var ct = TestContext.Current.CancellationToken;
        await using var connection = new SqlConnection(factory.AdminConnectionString); await connection.OpenAsync(ct);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(10));
        while (true)
        {
            await using var query = connection.CreateCommand();
            query.CommandText = "SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id=@session AND wait_type LIKE 'LCK_M_%' AND blocking_session_id>0";
            query.Parameters.AddWithValue("session", sessionId);
            if ((int)(await query.ExecuteScalarAsync(deadline.Token))! > 0) return;
            await Task.Delay(20, deadline.Token);
        }
    }
    internal sealed class LockGate(DateOnly date, bool pause = false) : DbCommandInterceptor
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("sys.sp_getapplock") && command.Parameters.Cast<DbParameter>().Any(p => Equals(p.Value, TimeMonth.Of(date).Resource)))
            { Entered.TrySetResult(); if (pause) await Resume.Task.WaitAsync(cancellationToken); }
            return result;
        }
    }
    internal sealed class SaveGate(DateOnly date, bool period) : SaveChangesInterceptor
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is TimeTrackingDbContext db && (period
                ? db.ChangeTracker.Entries<TimePeriod>().Any(e => e.Entity.Year == date.Year && e.Entity.Month == date.Month)
                : db.ChangeTracker.Entries<TimeEntry>().Any(e => e.Entity.WorkDate == date && e.State is EntityState.Added or EntityState.Modified or EntityState.Deleted)))
            { Entered.TrySetResult(); await Resume.Task.WaitAsync(cancellationToken); }
            return result;
        }
    }
}
