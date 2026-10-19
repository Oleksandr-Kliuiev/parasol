using System.Data;
using System.Security.Cryptography;
using System.Text;
using Crm.Integrations.Core.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.Core;

public sealed partial class SyncRunner
{
    /// <summary>
    /// Serializes all sync streams of one integration across worker processes. Data is committed normally, not in a
    /// transaction held across provider HTTP. After an interruption the job replays from its last completed cursor.
    /// </summary>
    public async Task<SyncRun> RunExclusiveAsync(string system, string job,
        Func<SyncProgress, CancellationToken, Task> work, CancellationToken cancellationToken, int lockTimeoutMilliseconds = 30_000)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(system);
        ArgumentOutOfRangeException.ThrowIfNegative(lockTimeoutMilliseconds);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(lockTimeoutMilliseconds, 30_000);
        if (db.Database.GetDbConnection().State != ConnectionState.Closed || db.Database.CurrentTransaction is not null || db.ChangeTracker.HasChanges())
        {
            throw new InvalidOperationException("An exclusive synchronization requires a clean, dedicated context.");
        }

        var original = db.Database.GetConnectionString();
        // A session lock must never survive in a connection pool or be lost behind a transparently reconnected statement.
        // The outer EF strategy owns the whole attempt; nested SaveChanges/queries must not retry individual statements
        // on a new, unlocked session. SqlClient's separate idle reconnection is disabled as well.
        var connection = new SqlConnectionStringBuilder(original) { Pooling = false, ConnectRetryCount = 0 };
        db.Database.SetConnectionString(connection.ConnectionString);
        var resource = "crm-sync:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(system)));
        try
        {
            return await new ExclusiveAttemptStrategy(db).ExecuteAsync(async () =>
            {
                db.ChangeTracker.Clear();
                try
                {
                    await db.Database.OpenConnectionAsync(cancellationToken);
                    var result = new SqlParameter("@result", SqlDbType.Int) { Direction = ParameterDirection.Output };
                    await db.Database.ExecuteSqlRawAsync(
                        "EXEC @result = sys.sp_getapplock @Resource=@resource, @LockMode=N'Exclusive', " +
                        "@LockOwner=N'Session', @DbPrincipal=N'public', @LockTimeout=@timeout;",
                        [result, new SqlParameter("@resource", resource), new SqlParameter("@timeout", lockTimeoutMilliseconds)], cancellationToken);
                    if ((int)result.Value < 0)
                    {
                        throw new SyncFailedException(system, job, "SyncBusy");
                    }

                    db.ExclusiveSyncResource = resource;
                    return await RunAsync(system, job, work, cancellationToken);
                }
                finally
                {
                    db.ExclusiveSyncResource = null;
                    // Pooling=false makes this a physical logout: it releases the lock after success, failure or cancellation.
                    // A killed connection also fails the attempt; no cursor/data statement may reconnect on its own.
                    await db.Database.CloseConnectionAsync();
                }
            });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException("Synchronization cancelled.", cancellationToken);
        }
        catch (SyncFailedException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError("Synchronization {System}/{Job} failed ({ErrorType})", system, job, ex.GetType().Name);
            throw new SyncFailedException(system, job, ex.GetType().Name);
        }
        finally
        {
            db.Database.SetConnectionString(original);
        }
    }

    // Setting ExecutionStrategy.Current for the whole attempt suppresses nested statement retries. Recovery is an explicit
    // fresh job invocation with a newly acquired lock, never an implicit repeat of a callback holding obsolete source reads.
    private sealed class ExclusiveAttemptStrategy(DbContext context) : ExecutionStrategy(context, 0, TimeSpan.Zero)
    {
        protected override bool ShouldRetryOn(Exception exception) => false;
    }
}
