using System.Data.Common;
using Crm.Integrations.Core.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Crm.Integrations.Core;

/// <summary>Fail closed if EF opens a new session while an exclusive job is still running.</summary>
internal sealed class SyncExclusiveCommandInterceptor : DbCommandInterceptor
{
    public static readonly SyncExclusiveCommandInterceptor Instance = new();

    private static void Guard(DbCommand command, CommandEventData eventData)
    {
        if (eventData.Context is not IntegrationDbContext { ExclusiveSyncResource: { } resource }) return;
        const string parameter = "@__parasolExclusiveSyncResource";
        // The same command can pass through an execution hook again. Its session must still own the actual SQL lock.
        if (command.Parameters.Contains(parameter)) return;
        command.Parameters.Add(new SqlParameter(parameter, resource));
        command.CommandText = "IF COALESCE(APPLOCK_MODE(N'public', " + parameter + ", N'Session'), N'NoLock') <> N'Exclusive' " +
            "THROW 51001, 'Exclusive synchronization session was lost.', 1;\n" + command.CommandText;
    }

    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
    {
        Guard(command, eventData);
        return result;
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData,
        InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        Guard(command, eventData);
        return ValueTask.FromResult(result);
    }

    public override InterceptionResult<int> NonQueryExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
    {
        Guard(command, eventData);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
        InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        Guard(command, eventData);
        return ValueTask.FromResult(result);
    }

    public override InterceptionResult<object> ScalarExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<object> result)
    {
        Guard(command, eventData);
        return result;
    }

    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand command, CommandEventData eventData,
        InterceptionResult<object> result, CancellationToken cancellationToken = default)
    {
        Guard(command, eventData);
        return ValueTask.FromResult(result);
    }
}
