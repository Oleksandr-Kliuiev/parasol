using Crm.Authorization;
using Crm.Sales.Domain;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace Crm.Sales.Features;

public sealed class SalesOperationalSignals(SalesDbContext db, TimeProvider time, IConfiguration configuration) : IOperationalSignalSource
{
    public async Task<IReadOnlyList<OperationalSignal>> ReadAsync(CancellationToken cancellationToken)
    {
        var minutes = Math.Clamp(configuration.GetValue("Monitoring:DocumentPreparingMinutes", 15), 1, 1440);
        var cutoff = time.GetUtcNow().AddMinutes(-minutes);
        var preparing = db.QuoteDocuments.AsNoTracking().Where(d => d.Status == QuoteDocumentStatus.Preparing &&
            d.ErasedAt == null && d.CreatedAt < cutoff);
        return
        [
            new("sales:documents", "Integration", "sales", "DocumentPreparing",
                await preparing.Select(d => (DateTimeOffset?)d.CreatedAt).MinAsync(cancellationToken),
                await preparing.CountAsync(cancellationToken), "QuoteDocumentsUnavailable", "docs/runbooks/15-monitoring.md#documents",
                Permissions.QuotesAll),
        ];
    }
}
