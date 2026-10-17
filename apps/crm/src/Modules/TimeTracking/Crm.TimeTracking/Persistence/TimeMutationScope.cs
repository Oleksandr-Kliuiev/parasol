using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.TimeTracking.Persistence;

/// <summary>Never replay a financial callback. Inbox handlers join their owner's transaction through its commit.</summary>
internal sealed class TimeMutationScope : IAsyncDisposable
{
    private readonly IDbContextTransaction? ownedTransaction;
    private readonly bool ownsContext;
    private TimeMutationScope(TimeTrackingDbContext db, IDbContextTransaction? transaction, bool owns)
    { Db = db; ownedTransaction = transaction; ownsContext = owns; }
    internal TimeTrackingDbContext Db { get; }
    internal void RequireFinancialOwner()
    {
        if (ownedTransaction is null) throw new InvalidOperationException("A Time/bank command must own its complete transaction.");
    }

    internal static TimeTrackingDbContext Fresh(TimeTrackingDbContext source) => new(
        new DbContextOptionsBuilder<TimeTrackingDbContext>((DbContextOptions<TimeTrackingDbContext>)source.GetService<IDbContextOptions>())
            .UseSqlServer(sql => sql.ExecutionStrategy(d => new NonRetryingExecutionStrategy(d))).Options);

    internal static async Task<TimeMutationScope> OpenAsync(TimeTrackingDbContext source, CancellationToken ct)
    {
        if (source.Database.CurrentTransaction is not null) return new(source, null, false);
        var db = Fresh(source);
        try { return new(db, await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct), true); }
        catch { await db.DisposeAsync(); throw; }
    }
    internal Task CommitAsync(CancellationToken ct) => ownedTransaction?.CommitAsync(ct) ?? Task.CompletedTask;
    public async ValueTask DisposeAsync()
    {
        if (ownedTransaction is not null) await ownedTransaction.DisposeAsync();
        if (ownsContext) await Db.DisposeAsync();
    }
}
