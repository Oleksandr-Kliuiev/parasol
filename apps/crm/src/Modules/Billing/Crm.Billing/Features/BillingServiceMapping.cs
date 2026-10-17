using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Billing.Features;

internal sealed partial class BillingService
{
    // ---------- Helpers ----------

    private async Task<decimal> VatRateOfAsync(Guid? productId, CancellationToken ct)
    {
        if (productId is not { } id)
        {
            return 25m;
        }

        var products = await catalog.GetProductsAsync([id], ct);
        return products.GetValueOrDefault(id)?.VatRate ?? 25m;
    }

    private async Task<BillingBasis?> LoadBasisAsync(Guid id, CancellationToken ct) =>
        await db.BillingBases.Include(b => b.Lines).Include(b => b.Attempts).SingleOrDefaultAsync(b => b.Id == id, ct);

    private async Task<Result<RunResponse>> MutateAsync(Guid id, Func<BillingRun, Result> mutate, CancellationToken ct)
    {
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == id, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(id);
        }

        var result = mutate(run);
        if (!result.IsSuccess)
        {
            return result.Error!;
        }

        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(run, ct);
    }

    /// <summary>
    /// Changes one basis. A change of an open run's content is a new revision of the run in the same transaction, so a
    /// parallel approval of the old revision fails on the run's row version instead of approving content nobody saw.
    /// </summary>
    private async Task<Result<BasisResponse>> MutateBasisAsync(
        Guid id, string? ifMatch, Func<BillingBasis, Task<Result>> mutate, CancellationToken ct, string? resetReason = ApprovalResetReasons.LinesChanged)
    {
        if (await LoadBasisAsync(id, ct) is not { } basis)
        {
            return BillingErrors.BasisNotFound(id);
        }

        if (ifMatch is not null && !db.ApplyIfMatch(basis, ifMatch))
        {
            return Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
        }

        var result = await mutate(basis);
        if (!result.IsSuccess)
        {
            return result.Error!;
        }

        if (resetReason is not null && await db.BillingRuns.Include(r => r.Approvals).SingleOrDefaultAsync(r => r.Id == basis.RunId, ct) is { IsLocked: false } run)
        {
            run.ContentChanged(resetReason, time.GetUtcNow());
        }

        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(basis, ct);
    }

    private async Task<BillingRun?> LoadRunAsync(Guid id, CancellationToken ct) =>
        await db.BillingRuns.Include(r => r.Approvals).SingleOrDefaultAsync(r => r.Id == id, ct);

    private async Task<RunResponse> ToResponseAsync(BillingRun run, CancellationToken ct)
    {
        var bases = await db.BillingBases.AsNoTracking().Include(b => b.Lines).Where(b => b.RunId == run.Id).ToListAsync(ct);
        var approvals = await db.BillingApprovals.AsNoTracking().Where(a => a.RunId == run.Id).OrderBy(a => a.ApprovedAt).ToListAsync(ct);
        var approvers = await users.GetUsersAsync(
            new[] { run.ApprovedBy, run.SecondApprovedBy }.Concat(approvals.Select(a => (Guid?)a.ApprovedBy))
                .Where(id => id is not null).Select(id => id!.Value).Distinct().ToList(), ct);
        RefDto Person(Guid id) => approvers.TryGetValue(id, out var user) ? new RefDto(user.Id, user.DisplayName) : new RefDto(id, "—");
        var threshold = options.Value.SecondApprovalThreshold;
        return new RunResponse(
            run.Id,
            run.PeriodStart,
            run.PeriodEnd,
            run.Kind,
            run.Status,
            bases.Count,
            bases.Count(b => b.AnomaliesJson != null),
            bases.Count(b => b.Status == BillingBasisStatus.Exported),
            bases.Count(b => b.Status == BillingBasisStatus.Failed),
            decimal.Round(bases.Sum(b => b.TotalExVat), 2),
            // An open run says what its content needs now; an approved one keeps what it was released with.
            run.IsLocked ? run.RequiresSecondApproval : BillingRun.NeedsSecondApproval(bases, threshold),
            run.ApprovedBy is { } first ? Person(first) : null,
            run.SecondApprovedBy is { } secondId ? Person(secondId) : null,
            run.CollectedAt,
            run.ApprovedAt,
            run.ExportedAt,
            run.ClosedAt,
            run.Notes,
            bases.Sum(b => b.ConflictCount),
            run.ContentRevision,
            run.ApprovedRevision,
            approvals
                .Select(a => new ApprovalDto(a.Kind, Person(a.ApprovedBy), a.ApprovedAt, a.ContentRevision, a.InvalidatedAt is null && a.ContentRevision == run.ContentRevision, a.InvalidatedAt, a.InvalidationReason))
                .ToList(),
            db.GetETag(run));
    }

    private async Task<BasisResponse> ToResponseAsync(BillingBasis basis, CancellationToken ct)
    {
        var run = await db.BillingRuns.AsNoTracking().SingleAsync(r => r.Id == basis.RunId, ct);
        var names = await customers.GetOrganizationNamesAsync([basis.OrganizationId], ct);
        var productIds = basis.CurrentLines.Where(l => l.ProductId is not null).Select(l => l.ProductId!.Value).Distinct().ToList();
        var products = await catalog.GetProductsAsync(productIds, ct);
        var invoices = await db.Invoices.AsNoTracking().Include(i => i.Payments).Where(i => i.BasisId == basis.Id).ToListAsync(ct);
        var today = Today;
        var sourceCustomers = basis.CurrentLines
            .Where(l => l.SourceOrganizationId is { } source && source != basis.OrganizationId)
            .Select(l => l.SourceOrganizationId!.Value)
            .Distinct()
            .ToList();
        var customerNames = sourceCustomers.Count == 0 ? names : await customers.GetOrganizationNamesAsync([basis.OrganizationId, .. sourceCustomers], ct);
        var editors = await users.GetUsersAsync(
            basis.CurrentLines.Where(l => l.ChangedBy is not null).Select(l => l.ChangedBy!.Value).Distinct().ToList(), ct);

        return new BasisResponse(
            basis.Id,
            basis.RunId,
            run.PeriodStart,
            run.PeriodEnd,
            run.Status,
            new RefDto(basis.OrganizationId, names.GetValueOrDefault(basis.OrganizationId, "—")),
            basis.Status,
            basis.TotalExVat,
            basis.PreviousPeriodTotal,
            basis.Anomalies,
            basis.CustomerReference,
            basis.OrderNo,
            basis.ExportedAt,
            basis.SendStartedAt is not null,
            basis.CurrentLines
                .OrderBy(l => l.Group)
                .ThenBy(l => l.Description, StringComparer.Ordinal)
                .Select(l => new BasisLineDto(
                    l.Id, l.Group, l.ProductId, l.ProductId is { } pid ? products.GetValueOrDefault(pid)?.Name : null, l.ProductCode,
                    l.Description, l.Quantity, l.UnitPrice, l.DiscountPct, l.VatRate, l.LineTotal, l.ManuallyAdjusted, l.SourceRefs,
                    l.Origin,
                    l.SourceKey,
                    l.SourceOrganizationId is { } source && source != basis.OrganizationId
                        ? new RefDto(source, customerNames.GetValueOrDefault(source, "—"))
                        : null,
                    l.Decision,
                    l.Conflict,
                    l.SourceDescription,
                    l.SourceQuantity,
                    l.SourceUnitPrice,
                    l.SourceDiscountPct,
                    l.SourceLineTotal,
                    l.ChangeReason,
                    l.ChangedBy is { } editor && editors.TryGetValue(editor, out var editorUser) ? new RefDto(editorUser.Id, editorUser.DisplayName) : null,
                    l.ChangedAt))
                .ToList(),
            basis.Attempts.OrderByDescending(a => a.At).Select(a => new ExportAttemptDto(a.At, a.Result, a.Message, a.CorrelationId)).ToList(),
            invoices.Select(i => ToDto(i, names, today)).ToList(),
            basis.Revision,
            basis.ConflictCount,
            db.GetETag(basis));
    }

    private static InvoiceDto ToDto(Invoice invoice, IReadOnlyDictionary<Guid, string> names, DateOnly today) => new(
        invoice.Id,
        invoice.System,
        invoice.InvoiceNo,
        invoice.OrderNo,
        invoice.OrganizationId is { } id ? new RefDto(id, names.GetValueOrDefault(id, "—")) : null,
        invoice.BasisId,
        invoice.InvoiceDate,
        invoice.DueDate,
        invoice.TotalIncVat,
        invoice.Outstanding,
        invoice.Status,
        invoice.IsOverdue(today),
        invoice.Url,
        invoice.SyncedAt,
        invoice.Payments.OrderBy(p => p.ObservedOn).ThenBy(p => p.Id).Select(p => new InvoiceMovementDto(p.Kind, p.ObservedOn, p.Amount, p.Source)).ToList());

    private async Task<Dictionary<Guid, (int Organizations, int WithAnomalies, decimal Total, decimal LargestBasis)>> TotalsAsync(
        IReadOnlyCollection<Guid> runIds, CancellationToken ct)
    {
        var rows = await db.BillingBases.AsNoTracking()
            .Where(b => runIds.Contains(b.RunId))
            .GroupBy(b => b.RunId)
            .Select(g => new
            {
                g.Key,
                Organizations = g.Count(),
                WithAnomalies = g.Count(b => b.AnomaliesJson != null),
                Total = g.Sum(b => b.TotalExVat),
                LargestBasis = g.Where(b => b.Status != BillingBasisStatus.Cancelled).Max(b => (decimal?)b.TotalExVat) ?? 0m,
            })
            .ToListAsync(ct);
        return rows.ToDictionary(r => r.Key, r => (r.Organizations, r.WithAnomalies, decimal.Round(r.Total, 2), r.LargestBasis));
    }

    public decimal SecondApprovalThreshold => options.Value.SecondApprovalThreshold;
}
