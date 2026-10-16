using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Crm.Infrastructure.Outbox;

public sealed record OutboxRetentionResult(int Messages, int Receipts, int ReplayRequests);

/// <summary>
/// Retention of the delivery tables (DEV-07). Only delivered messages are removed, after <see cref="ProcessedRetention"/>;
/// dead and quarantined ones stay until a person deals with them. A receipt outlives its message: it is removed after
/// <see cref="ReceiptRetention"/>, and never while its message is still undelivered in any module, so a replay never
/// repeats a handler that is done.
/// </summary>
public sealed class OutboxRetentionJob(
    IServiceScopeFactory scopeFactory,
    ModuleDbContextRegistry registry,
    TimeProvider timeProvider,
    ILogger<OutboxRetentionJob> logger)
{
    public const string JobId = "outbox-retention";
    public static readonly TimeSpan ProcessedRetention = TimeSpan.FromDays(30);
    public static readonly TimeSpan ReceiptRetention = TimeSpan.FromDays(180);

    public async Task<OutboxRetentionResult> RunAsync(CancellationToken cancellationToken)
    {
        var now = timeProvider.GetUtcNow();
        var processedBefore = now - ProcessedRetention;
        var receiptsBefore = now - ReceiptRetention;

        // A receipt lives in the handler's module, its message in the module that raised it: the open messages of every
        // module are gathered first.
        var open = new HashSet<Guid>();
        foreach (var contextType in registry.Contexts)
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
            open.UnionWith(await context.OutboxMessages.AsNoTracking().Where(m => m.ProcessedAt == null).Select(m => m.Id).ToListAsync(cancellationToken));
        }

        int messages = 0, receipts = 0, requests = 0;
        foreach (var contextType in registry.Contexts)
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
            if (context.IsAuditModule)
            {
                // Nothing is ever delivered there, and the application may not delete in the audit schema (DEV-04).
                continue;
            }

            messages += await context.OutboxMessages
                .Where(m => m.Status == OutboxStatus.Processed && m.ProcessedAt != null && m.ProcessedAt < processedBefore)
                .ExecuteDeleteAsync(cancellationToken);

            var expired = await context.InboxReceipts.AsNoTracking()
                .Where(r => r.ProcessedAt < receiptsBefore)
                .Select(r => r.MessageId)
                .Distinct()
                .ToListAsync(cancellationToken);
            foreach (var chunk in expired.Where(id => !open.Contains(id)).Chunk(500))
            {
                receipts += await context.InboxReceipts.Where(r => chunk.Contains(r.MessageId)).ExecuteDeleteAsync(cancellationToken);
            }

            requests += await context.OutboxReplayRequests
                .Where(r => r.AppliedAt != null && r.AppliedAt < receiptsBefore)
                .ExecuteDeleteAsync(cancellationToken);
        }

        logger.LogInformation("Outbox retention removed {Messages} delivered messages, {Receipts} receipts and {Requests} applied replay requests",
            messages, receipts, requests);
        return new OutboxRetentionResult(messages, receipts, requests);
    }
}
