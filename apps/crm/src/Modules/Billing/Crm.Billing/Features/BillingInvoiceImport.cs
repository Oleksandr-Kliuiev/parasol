using System.Security.Cryptography;
using System.Text;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

internal sealed partial class BillingApi
{
    public async Task<InvoiceSyncResult> UpsertInvoicesAsync(IReadOnlyCollection<ExternalInvoice> invoices, CancellationToken cancellationToken)
    {
        int created = 0, updated = 0, unchanged = 0, unmatched = 0;
        foreach (var incoming in invoices)
        {
            InvoiceSyncResult result;
            if (incoming.History is not null && incoming.OrganizationId is { } organizationId)
            {
                var leased = await customers.WithUsableOrganizationAsync<InvoiceSyncResult>(organizationId,
                    async (_, ct) => await SaveInvoiceAsync(incoming, ct), cancellationToken);
                result = leased.IsSuccess ? leased.Value : await SaveInvoiceAsync(incoming with { OrganizationId = null }, cancellationToken);
            }
            else result = await SaveInvoiceAsync(incoming, cancellationToken);
            created += result.Created;
            updated += result.Updated;
            unchanged += result.Unchanged;
            unmatched += result.Unmatched;
        }
        return new InvoiceSyncResult(created, updated, unchanged, unmatched);
    }

    private async Task<InvoiceSyncResult> SaveInvoiceAsync(ExternalInvoice incoming, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(incoming.System) || incoming.System.Length > 32 || string.IsNullOrWhiteSpace(incoming.InvoiceNo) || incoming.InvoiceNo.Length > 64)
            throw new InvalidOperationException("Invalid invoice identity.");
        if (db.ChangeTracker.HasChanges()) throw new InvalidOperationException("Invoice import requires a clean context.");
        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await AcquireInvoiceLockAsync(incoming.System, ct);

            var history = incoming.History;
            var existing = history is not null
                ? await db.Invoices.Include(i => i.Payments).SingleOrDefaultAsync(i => i.System == incoming.System && i.ExternalId == history.ExternalId, ct)
                : await db.Invoices.Include(i => i.Payments).SingleOrDefaultAsync(i => i.System == incoming.System && i.ExternalId == null && i.InvoiceNo == incoming.InvoiceNo, ct);
            if (history is null && existing is null && await db.Invoices.AnyAsync(i => i.System == incoming.System && i.InvoiceNo == incoming.InvoiceNo, ct))
                throw new InvalidOperationException("A keyed historical invoice cannot be updated by number alone.");

            // Legacy rows have no proven source UUID. Keep them; a reused document number is not authority to merge history.
            var basis = incoming.ExternalReference is { Length: > 0 } reference
                ? await db.BillingBases.AsNoTracking().Where(b => b.IdempotencyKey == reference)
                    .Select(b => new { b.Id, b.OrganizationId }).SingleOrDefaultAsync(ct)
                : null;
            if (basis is null && incoming.OrderNo is { Length: > 0 } order)
                basis = await db.BillingBases.AsNoTracking().Where(b => b.OrderNo == order)
                    .OrderByDescending(b => b.ExportedAt).ThenByDescending(b => b.Id)
                    .Select(b => new { b.Id, b.OrganizationId }).FirstOrDefaultAsync(ct);
            var organizationId = history is null ? incoming.OrganizationId ?? basis?.OrganizationId : incoming.OrganizationId;
            var basisId = history is null || organizationId is not null && basis?.OrganizationId == organizationId ? basis?.Id : null;
            int created = 0, updated = 0, unchanged = 0;
            if (existing is null)
            {
                db.Invoices.Add(Invoice.From(incoming, organizationId, basisId, time.GetUtcNow()));
                created = 1;
            }
            else if (existing.Apply(incoming, organizationId, basisId, time.GetUtcNow())) updated = 1;
            else unchanged = 1;
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return new InvoiceSyncResult(created, updated, unchanged, organizationId is null ? 1 : 0);
        });
    }

    public async Task<IReadOnlyList<InvoiceCustomerBinding>> GetInvoiceCustomerBindingsAsync(string system, CancellationToken cancellationToken) =>
        await db.Invoices.AsNoTracking().Where(i => i.System == system && i.ExternalId != null && i.ExternalCustomerId != null)
            .OrderBy(i => i.Id).Select(i => new InvoiceCustomerBinding(i.Id, i.ExternalCustomerId!)).ToListAsync(cancellationToken);

    public async Task BindHistoricalInvoiceAsync(Guid invoiceId, string expectedExternalCustomerId, Guid? organizationId, CancellationToken cancellationToken)
    {
        if (organizationId is { } id)
        {
            var leased = await customers.WithUsableOrganizationAsync<bool>(id, async (_, ct) =>
            {
                await BindAsync(invoiceId, expectedExternalCustomerId, organizationId, ct);
                return true;
            }, cancellationToken);
            if (leased.IsSuccess) return;
        }
        await BindAsync(invoiceId, expectedExternalCustomerId, null, cancellationToken);
    }

    private async Task BindAsync(Guid invoiceId, string expectedExternalCustomerId, Guid? organizationId, CancellationToken ct)
    {
        if (db.ChangeTracker.HasChanges()) throw new InvalidOperationException("Invoice binding requires a clean context.");
        await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            var system = await db.Invoices.Where(i => i.Id == invoiceId).Select(i => i.System).SingleAsync(ct);
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await AcquireInvoiceLockAsync(system, ct);
            var invoice = await db.Invoices.SingleAsync(i => i.Id == invoiceId, ct);
            if (invoice.ExternalId is null || invoice.ExternalCustomerId != expectedExternalCustomerId)
                throw new InvalidOperationException("Historical invoice customer identity changed.");
            var basisId = invoice.BasisId is { } basis && organizationId is not null &&
                          await db.BillingBases.AnyAsync(b => b.Id == basis && b.OrganizationId == organizationId, ct) ? invoice.BasisId : null;
            invoice.BindHistoricalCustomer(organizationId, basisId);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
        });
    }

    private async Task AcquireInvoiceLockAsync(string system, CancellationToken ct)
    {
        var resource = "crm-invoices:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(system)));
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={resource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=10000;
            IF @r < 0 THROW 51000, 'Invoice import is busy.', 1;
            """, ct);
    }
}
