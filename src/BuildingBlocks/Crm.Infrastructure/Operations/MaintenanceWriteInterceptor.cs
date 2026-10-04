using System.Data.Common;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Crm.Infrastructure.Operations;

/// <summary>
/// The database half of read-only maintenance (DEV-13): while the CRM is read-only no module context saves anything — whatever
/// the path, a request, an import, a job or a hidden write in a read — unless the code opened a <see cref="MaintenanceScope"/>
/// for one of the few writes maintenance allows. Runs before the auditing interceptor, so a refused save writes no audit
/// entry or outbox message either. Writes that bypass SaveChanges are refused by <see cref="MaintenanceCommandInterceptor"/>.
/// </summary>
internal sealed class MaintenanceWriteInterceptor(IMaintenanceGate gate) : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result)
    {
        Guard(eventData, gate.Last);
        return result;
    }

    public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        if (MaintenanceScope.AllowedBy is null && eventData.Context?.ChangeTracker.HasChanges() == true)
        {
            Guard(eventData, await gate.CurrentAsync(cancellationToken));
        }

        return result;
    }

    private static void Guard(DbContextEventData eventData, MaintenanceState state)
    {
        if (state.IsReadOnly && MaintenanceScope.AllowedBy is null && eventData.Context?.ChangeTracker.HasChanges() == true)
        {
            throw new MaintenanceReadOnlyException(state);
        }
    }
}

/// <summary>
/// The other half of the database guard: <c>ExecuteUpdate</c>, <c>ExecuteDelete</c> and raw <c>ExecuteSql</c> statements go to
/// the database without SaveChanges — leases, settlements, bulk changes — and are refused here on the same terms. Queries and
/// migrations pass: maintenance reads, and a restored copy may need the migration job before it is reconciled.
/// </summary>
internal sealed class MaintenanceCommandInterceptor(IMaintenanceGate gate) : DbCommandInterceptor
{
    public override InterceptionResult<int> NonQueryExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
    {
        Guard(eventData, gate.Last);
        return result;
    }

    public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        if (Writes(eventData) && MaintenanceScope.AllowedBy is null)
        {
            Guard(eventData, await gate.CurrentAsync(cancellationToken));
        }

        return result;
    }

    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
    {
        Guard(eventData, gate.Last);
        return result;
    }

    public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        if (Writes(eventData) && MaintenanceScope.AllowedBy is null)
        {
            Guard(eventData, await gate.CurrentAsync(cancellationToken));
        }

        return result;
    }

    /// <summary>Statements that change rows without SaveChanges (SaveChanges has its own interceptor).</summary>
    internal static bool Writes(CommandEventData eventData) => eventData.CommandSource is
        CommandSource.ExecuteUpdate or CommandSource.ExecuteDelete or CommandSource.ExecuteSqlRaw;

    private static void Guard(CommandEventData eventData, MaintenanceState state)
    {
        if (state.IsReadOnly && MaintenanceScope.AllowedBy is null && Writes(eventData))
        {
            throw new MaintenanceReadOnlyException(state);
        }
    }
}
