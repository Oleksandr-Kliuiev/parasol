using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Allowlisted persisted facts only. Stored success is historical evidence, not current provider health.</summary>
internal sealed class LocalReadinessStoredState(IntegrationDbContext db) : ILocalReadinessStoredState
{
    private const string Exact = "Latin1_General_100_BIN2";
    private static readonly string[] AteraJobs = ["atera-customers", "atera-contacts", "atera-tickets", "atera-tickets-recent", "atera-work-hours", "atera-agents", "atera-alerts"];
    private static readonly string[] PowerOfficeJobs = ["poweroffice-customers", "poweroffice-contact-persons", "poweroffice-products", "poweroffice-invoices"];

    public async Task<LocalStoredState> ReadAsync(CancellationToken ct)
    {
        var atera = await ProviderAsync("atera", AteraJobs, ct);
        var powerOffice = await ProviderAsync("poweroffice", PowerOfficeJobs, ct);
        var graph = await db.SyncSuccesses.AsNoTracking().Where(row => row.System == "microsoft-graph" && EF.Functions.Collate(row.System, Exact) == "microsoft-graph"
                && (row.Job == "entra-user-sync" || row.Job == "entra-role-sync"))
            .Select(row => new { row.System, row.Job, row.SucceededAt }).ToListAsync(ct);
        // SQL collations may match differently-cased corrupt names; never promote them to canonical evidence.
        var directory = graph.SingleOrDefault(row => row.System == "microsoft-graph" && row.Job == "entra-user-sync")?.SucceededAt;
        var roles = graph.SingleOrDefault(row => row.System == "microsoft-graph" && row.Job == "entra-role-sync")?.SucceededAt;
        return new(atera, powerOffice, new(directory, roles));
    }

    private async Task<ProviderStoredState> ProviderAsync(string system, string[] jobs, CancellationToken ct)
    {
        var records = db.ExternalRecords.AsNoTracking().Where(row => row.System == system && EF.Functions.Collate(row.System, Exact) == system && !row.IsGone);
        var successes = await db.SyncSuccesses.AsNoTracking().Where(row => row.System == system && EF.Functions.Collate(row.System, Exact) == system && jobs.Contains(row.Job))
            .Select(row => new { row.System, row.Job, row.SucceededAt }).ToListAsync(ct);
        var lastSuccess = successes.Where(row => row.System == system && jobs.Contains(row.Job, StringComparer.Ordinal))
            .Select(row => (DateTimeOffset?)row.SucceededAt).Max();
        // These related counts share one SQL scan, so an ordinary concurrent sync cannot make unlinked exceed records.
        var recordCounts = await records.GroupBy(_ => 1).Select(group => new
        {
            Records = group.Count(),
            Unlinked = group.Count(row => !db.ExternalLinks.Any(link => link.System == row.System && EF.Functions.Collate(link.System, Exact) == row.System
                && link.ExternalType == row.ExternalType && link.ExternalId == row.ExternalId)),
        }).SingleOrDefaultAsync(ct);
        return new(await db.IntegrationSwitches.AsNoTracking().AnyAsync(row => row.System == system && EF.Functions.Collate(row.System, Exact) == system && row.IsPaused, ct), lastSuccess,
            recordCounts?.Records ?? 0, recordCounts?.Unlinked ?? 0,
            await db.OutboundOperations.CountAsync(row => row.System == system && EF.Functions.Collate(row.System, Exact) == system && row.Status == OutboundStatus.Pending, ct),
            await db.OutboundOperations.CountAsync(row => row.System == system && EF.Functions.Collate(row.System, Exact) == system && (row.Status == OutboundStatus.Failed || row.Status == OutboundStatus.DeadLetter), ct));
    }
}
