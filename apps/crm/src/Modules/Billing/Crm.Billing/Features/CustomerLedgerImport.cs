using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

internal sealed partial class BillingApi
{
    public async Task<IReadOnlyList<string?>> GetCustomerLedgerSourcesAsync(string system, CancellationToken ct) =>
        (await db.CustomerLedgerSnapshots.AsNoTracking().Where(s => s.System == system).OrderBy(s => s.CustomerKey)
            .Select(s => s.CustomerKey).ToListAsync(ct)).Select(s => s.Length == 0 ? null : s).ToList();

    public async Task<CustomerLedgerImportResult> ImportCustomerLedgerAsync(CustomerLedgerBatch batch, CancellationToken ct)
    {
        if (batch.OrganizationId is { } organization)
        {
            var leased = await customers.WithUsableOrganizationAsync<CustomerLedgerImportResult>(organization,
                async (_, token) => await SaveLedgerAsync(batch, token), ct);
            if (leased.IsSuccess) return leased.Value;
        }
        return await SaveLedgerAsync(batch with { OrganizationId = null }, ct);
    }

    private async Task<CustomerLedgerImportResult> SaveLedgerAsync(CustomerLedgerBatch batch, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(batch.System) || batch.System.Length > 32 || batch.ExternalCustomerId?.Length > 64 ||
            batch.ExternalCustomerId is { Length: 0 } || batch.ScanId == Guid.Empty || batch.Entries.Any(e => e.ExternalCustomerId != batch.ExternalCustomerId) ||
            batch.Entries.Select(e => e.ExternalId).Distinct().Count() != batch.Entries.Count)
            throw new InvalidOperationException("Invalid customer ledger batch.");
        if (db.ChangeTracker.HasChanges()) throw new InvalidOperationException("Ledger import requires a clean context.");
        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await AcquireInvoiceLockAsync(batch.System, ct);
            var customer = batch.ExternalCustomerId ?? "";
            var snapshot = await db.CustomerLedgerSnapshots.SingleOrDefaultAsync(s => s.System == batch.System && s.CustomerKey == customer, ct);
            if (snapshot is null)
            {
                snapshot = new CustomerLedgerSnapshot { System = batch.System, CustomerKey = customer };
                db.CustomerLedgerSnapshots.Add(snapshot);
            }
            else if (batch.ReadStartedAt < snapshot.ReadStartedAt)
                throw new InvalidOperationException("An older ledger scan cannot replace a newer one.");
            snapshot.OrganizationId = batch.OrganizationId;
            snapshot.ScanId = batch.ScanId;
            snapshot.ReadStartedAt = batch.ReadStartedAt;
            snapshot.SavedAt = time.GetUtcNow();
            // Write the state row first: serializable readers hold it until their entries/links are read consistently.
            await db.SaveChangesAsync(ct);
            var existing = await db.CustomerLedgerEntries.Where(e => e.System == batch.System && e.CustomerKey == customer)
                .ToDictionaryAsync(e => e.ExternalId, ct);
            // A later CustomerId can fill an orphan with the same source ID. Bound SQL parameter counts for long histories.
            if (customer.Length > 0 && await db.CustomerLedgerEntries.AnyAsync(e => e.System == batch.System && e.CustomerKey == "", ct))
                foreach (var ids in batch.Entries.Select(e => e.ExternalId).Chunk(500))
                    foreach (var orphan in await db.CustomerLedgerEntries.Where(e => e.System == batch.System && e.CustomerKey == "" && ids.Contains(e.ExternalId)).ToListAsync(ct))
                        existing.Add(orphan.ExternalId, orphan);
            int created = 0, updated = 0, unchanged = 0;
            foreach (var incoming in batch.Entries)
            {
                var entry = existing.GetValueOrDefault(incoming.ExternalId);
                if (entry is null)
                {
                    db.CustomerLedgerEntries.Add(CustomerLedgerEntry.From(batch.System, incoming, batch.ScanId, snapshot.SavedAt));
                    created++;
                }
                else if (entry.Apply(incoming, batch.ScanId, snapshot.SavedAt)) updated++;
                else unchanged++;
            }
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return new CustomerLedgerImportResult(created, updated, unchanged);
        });
    }
}
