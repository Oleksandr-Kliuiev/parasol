using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.Infrastructure.Persistence;

/// <summary>
/// Explicit request/job boundary for Time and prepaid-bank work in ONE SQL database. Each module still owns its context,
/// audit and API. Only the Time owner commits; no ambient TransactionScope, distributed transaction or callback replay.
/// Domain-event handlers retain their single-module inbox boundary and cannot opt into this command boundary.
/// </summary>
public sealed class TimeBankTransaction(MessageHandlingContext handling)
{
    private ModuleDbContext? owner;
    private IDbContextTransaction? transaction;

    public IDisposable Bind(ModuleDbContext timeOwner)
    {
        ArgumentNullException.ThrowIfNull(timeOwner);
        if (owner is not null) throw new InvalidOperationException("A Time/bank command boundary is already active in this scope.");
        if (handling.MessageId is not null) throw new InvalidOperationException("Time/bank commands cannot run inside an inbox handler.");
        if (timeOwner.Schema != "time" || !timeOwner.Database.IsSqlServer() || timeOwner.Database.CurrentTransaction is not { } current)
            throw new InvalidOperationException("Time/bank work requires the Time owner's SQL transaction.");
        if (ExecutionStrategy.Current is not null || timeOwner.Database.CreateExecutionStrategy().RetriesOnFailure)
            throw new InvalidOperationException("A financial command boundary must not replay its callback.");
        owner = timeOwner; transaction = current;
        return new Binding(this);
    }

    public async Task<TContext?> JoinAsync<TContext>(TContext source, Func<DbContextOptions<TContext>, TContext> create, CancellationToken ct)
        where TContext : ModuleDbContext
    {
        var timeOwner = owner; var activeTransaction = transaction;
        if (timeOwner is null) return null;
        if (activeTransaction is null) throw new InvalidOperationException("The Time/bank owner transaction is missing.");
        if (source.Schema != "contracts" || !source.Database.IsSqlServer() || source.Database.CurrentTransaction is not null)
            throw new InvalidOperationException("Only a fresh Contracts context can join Time/bank work.");
        if (timeOwner.Database.CurrentTransaction != activeTransaction || activeTransaction.GetDbTransaction().Connection is null)
            throw new InvalidOperationException("The Time/bank owner transaction is no longer active.");
        var connection = timeOwner.Database.GetDbConnection();
        var configured = new SqlConnectionStringBuilder(source.Database.GetConnectionString());
        var active = new SqlConnectionStringBuilder(connection.ConnectionString);
        // Fail closed rather than redirecting a module to another database or using another module's privileged identity.
        if (!Same(configured.DataSource, active.DataSource) || !Same(configured.InitialCatalog, active.InitialCatalog)
            || !Same(configured.UserID, active.UserID) || configured.IntegratedSecurity != active.IntegratedSecurity
            || configured.Authentication != active.Authentication)
            throw new InvalidOperationException("Time and Contracts must use the same database and SQL identity.");
        var options = new DbContextOptionsBuilder<TContext>((DbContextOptions<TContext>)source.GetService<IDbContextOptions>())
            .UseSqlServer(connection, contextOwnsConnection: false, sql => sql.ExecutionStrategy(d => new NonRetryingExecutionStrategy(d))).Options;
        var joined = create(options);
        try { await joined.Database.UseTransactionAsync(activeTransaction.GetDbTransaction(), ct); return joined; }
        catch { await joined.DisposeAsync(); throw; }
    }
    private static bool Same(string one, string two) => string.Equals(one, two, StringComparison.Ordinal);
    private sealed class Binding(TimeBankTransaction boundary) : IDisposable
    {
        private bool disposed;
        public void Dispose()
        {
            if (disposed) return;
            disposed = true; boundary.owner = null; boundary.transaction = null;
        }
    }
}
