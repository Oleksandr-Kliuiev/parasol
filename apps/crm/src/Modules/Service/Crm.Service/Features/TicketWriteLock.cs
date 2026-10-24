using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>
/// One writer of a desk's tickets at a time (M39). The open, recent and conversation reads, a run started by hand and a ticket read
/// back after an action save the same rows; two of them inserting one new ticket, or updating it after the other had read it, would
/// fail a whole read, and the read line would say the read did not finish. A writer waits for the other instead (at most 30 s), as
/// the alert snapshot does.
/// </summary>
internal static class TicketWriteLock
{
    public static Task<T> RunAsync<T>(ServiceDbContext db, string system, Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken)
    {
        var resource = "service-tickets:" + system;
        var attempt = 0;
        // The lock and the writes land together, and the SQL Server retry strategy needs the transaction inside it.
        return db.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
        {
            // A retried attempt starts from the database again, not from what the failed attempt had changed or added.
            if (attempt++ > 0)
            {
                db.ChangeTracker.Clear();
            }

            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={resource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=30000;
                IF @r < 0 THROW 51000, 'Another read of these tickets is being stored.', 1;
                """, ct);
            var result = await work(ct);
            await transaction.CommitAsync(ct);
            return result;
        }, cancellationToken);
    }
}
