using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

public sealed partial class ExternalLinkService
{
    /// <summary>Hold the exact source link (or its absent-key range) while a different module commits its own copy.</summary>
    public async Task<T> WithExternalLinkAsync<T>(string system, string type, string externalId,
        Func<ExternalLink?, CancellationToken, Task<T>> action, CancellationToken cancellationToken) =>
        await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            var link = await db.ExternalLinks.FromSqlInterpolated($"""
                SELECT * FROM [integration].[ExternalLinks] WITH (UPDLOCK, HOLDLOCK)
                WHERE [System]={system} AND [ExternalType]={type} AND [ExternalId]={externalId}
                """).AsNoTracking().SingleOrDefaultAsync(cancellationToken);
            var result = await action(link, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return result;
        });
}
