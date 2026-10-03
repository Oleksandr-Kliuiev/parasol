using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Billing.Features;

public sealed record RunQuery(BillingRunStatus? Status, int? Year, int? Limit);

public sealed record BasisQuery(Guid RunId, bool AnomaliesOnly, BillingBasisStatus? Status, string? Search);

public sealed record InvoiceQuery(Guid? OrganizationId, bool OpenOnly, bool OverdueOnly, int? Limit);

internal sealed class BillingService(
    BillingDbContext db,
    BillingCollector collector,
    ICustomersApi customers,
    ICatalogApi catalog,
    IUserDirectory users,
    ICurrentUser currentUser,
    IOptions<BillingOptions> options,
    TimeProvider time)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private DateOnly Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);

    // ---------- Runs ----------

    public async Task<IReadOnlyList<RunListItem>> ListRunsAsync(RunQuery query, CancellationToken ct)
    {
        var runs = db.BillingRuns.AsNoTracking();
        if (query.Status is { } status)
        {
            runs = runs.Where(r => r.Status == status);
        }

        if (query.Year is { } year)
        {
            runs = runs.Where(r => r.PeriodStart.Year == year);
        }

        var rows = await runs.OrderByDescending(r => r.PeriodStart).Take(Math.Clamp(query.Limit ?? 24, 1, 120)).ToListAsync(ct);
        var totals = await TotalsAsync(rows.Select(r => r.Id).ToList(), ct);
        return rows.Select(r =>
        {
            var totalsOfRun = totals.GetValueOrDefault(r.Id);
            return new RunListItem(
                r.Id, r.PeriodStart, r.PeriodEnd, r.Status, totalsOfRun.Organizations, totalsOfRun.WithAnomalies, totalsOfRun.Total,
                r.RequiresSecondApproval, r.CollectedAt, r.ApprovedAt, r.ExportedAt, r.ClosedAt);
        }).ToList();
    }

    public async Task<Result<RunResponse>> GetRunAsync(Guid id, CancellationToken ct)
    {
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == id, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(id);
        }

        return await ToResponseAsync(run, ct);
    }

    public async Task<Result<RunResponse>> CreateRunAsync(CreateRunRequest request, CancellationToken ct)
    {
        var periodStart = new DateOnly(request.Year, request.Month, 1);
        if (await db.BillingRuns.AnyAsync(r => r.PeriodStart == periodStart && r.Status != BillingRunStatus.Closed, ct))
        {
            return BillingErrors.PeriodBusy(periodStart);
        }

        var run = BillingRun.Create(request.Year, request.Month, request.Notes);
        db.BillingRuns.Add(run);
        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(run, ct);
    }

    /// <summary>Collects or re-collects the bases of a run (BR-BIL-02).</summary>
    public async Task<Result<RunResponse>> CollectAsync(Guid id, CancellationToken ct)
    {
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == id, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(id);
        }

        if (run.IsLocked)
        {
            return BillingErrors.InvalidStatus(run.Status, "collected again");
        }

        var result = await collector.CollectAsync(run, ct);
        var marked = run.MarkCollected(time.GetUtcNow(), result.RequiresSecondApproval);
        if (!marked.IsSuccess)
        {
            return marked.Error!;
        }

        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(run, ct);
    }

    public Task<Result<RunResponse>> ReviewAsync(Guid id, CancellationToken ct) => MutateAsync(id, run => run.StartReview(), ct);

    public async Task<Result<RunResponse>> ApproveAsync(Guid id, bool second, CancellationToken ct)
    {
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == id, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(id);
        }

        // A line whose source changed after Finance decided about it is not approved by accident (BR-BIL-02).
        var bases = await db.BillingBases.Include(b => b.Lines).Where(b => b.RunId == run.Id).ToListAsync(ct);
        var conflicts = bases.Sum(b => b.ConflictCount);
        if (conflicts > 0)
        {
            return BillingErrors.UnresolvedConflicts(conflicts);
        }

        var now = time.GetUtcNow();
        var approved = second ? run.SecondApprove(currentUser.UserId, now) : run.Approve(currentUser.UserId, now);
        if (!approved.IsSuccess)
        {
            return approved.Error!;
        }

        if (run.Status == BillingRunStatus.Approved)
        {
            // Approving the run approves every basis: from here on they are immutable (BR-BIL-10).
            foreach (var basis in bases)
            {
                basis.Approve();
            }
        }

        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(run, ct);
    }

    /// <summary>
    /// Sends the run again: bases that failed go back in the queue and the run reports it is exporting. Bases that are still
    /// waiting need no push — approving a run already queued them.
    /// </summary>
    public async Task<Result<RunResponse>> StartExportAsync(Guid id, CancellationToken ct)
    {
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == id, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(id);
        }

        var started = run.StartExport();
        if (!started.IsSuccess)
        {
            return started.Error!;
        }

        foreach (var basis in await db.BillingBases.Include(b => b.Lines).Where(b => b.RunId == id && b.Status == BillingBasisStatus.Failed).ToListAsync(ct))
        {
            basis.Retry();
        }

        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(run, ct);
    }

    public Task<Result<RunResponse>> CloseAsync(Guid id, CancellationToken ct) => MutateAsync(id, run => run.Close(time.GetUtcNow()), ct);

    public async Task<Result> DiscardAsync(Guid id, string ifMatch, CancellationToken ct)
    {
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == id, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(id);
        }

        if (!db.ApplyIfMatch(run, ifMatch))
        {
            return Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
        }

        var discarded = run.Discard();
        if (!discarded.IsSuccess)
        {
            return discarded.Error!;
        }

        foreach (var basis in await db.BillingBases.Include(b => b.Lines).Where(b => b.RunId == run.Id).ToListAsync(ct))
        {
            basis.MarkDeleted();
        }

        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    // ---------- Bases ----------

    public async Task<Result<IReadOnlyList<BasisListItem>>> ListBasesAsync(BasisQuery query, CancellationToken ct)
    {
        if (!await db.BillingRuns.AnyAsync(r => r.Id == query.RunId, ct))
        {
            return BillingErrors.RunNotFound(query.RunId);
        }

        var bases = db.BillingBases.AsNoTracking().Include(b => b.Lines).Where(b => b.RunId == query.RunId);
        if (query.Status is { } status)
        {
            bases = bases.Where(b => b.Status == status);
        }

        if (query.AnomaliesOnly)
        {
            bases = bases.Where(b => b.AnomaliesJson != null);
        }

        var rows = await bases.ToListAsync(ct);
        var names = await customers.GetOrganizationNamesAsync(rows.Select(b => b.OrganizationId).Distinct().ToList(), ct);
        var items = rows
            .Select(b => new BasisListItem(
                b.Id,
                new RefDto(b.OrganizationId, names.GetValueOrDefault(b.OrganizationId, "—")),
                b.Status,
                b.TotalExVat,
                b.PreviousPeriodTotal,
                b.Anomalies,
                b.CurrentLines.Count(),
                b.OrderNo,
                b.ExportedAt,
                b.ConflictCount))
            .Where(b => string.IsNullOrWhiteSpace(query.Search) || b.Organization.Name.Contains(query.Search!, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(b => b.Anomalies.Count > 0)
            .ThenByDescending(b => b.TotalExVat)
            .ToList();
        return items;
    }

    public async Task<Result<BasisResponse>> GetBasisAsync(Guid id, CancellationToken ct)
    {
        if (await LoadBasisAsync(id, ct) is not { } basis)
        {
            return BillingErrors.BasisNotFound(id);
        }

        return await ToResponseAsync(basis, ct);
    }

    public async Task<Result<BasisResponse>> AddLineAsync(Guid basisId, ManualLineRequest request, string ifMatch, CancellationToken ct) =>
        await MutateBasisAsync(basisId, ifMatch, async basis =>
        {
            var vatRate = request.VatRate ?? await VatRateOfAsync(request.ProductId, ct);
            var added = basis.AddManualLine(new LineDraft(
                BillingGroup.OneOff, request.ProductId, request.Description, request.Quantity, request.UnitPrice,
                request.DiscountPct ?? 0, vatRate, null), currentUser.UserId, time.GetUtcNow(), request.Reason);
            return added.IsSuccess ? Result.Success() : added.Error!;
        }, ct);

    /// <summary>Edits a manual line, or overrides a collected one; an override needs a reason and keeps the source values.</summary>
    public Task<Result<BasisResponse>> AdjustLineAsync(Guid basisId, Guid lineId, AdjustLineRequest request, string ifMatch, CancellationToken ct) =>
        MutateBasisAsync(basisId, ifMatch, basis => Task.FromResult(basis.UpdateLine(
            lineId, request.Quantity, request.UnitPrice, request.DiscountPct, request.Description, request.Reason, currentUser.UserId, time.GetUtcNow())), ct);

    /// <summary>Deletes a manual line. A collected line is excluded instead (<see cref="ExcludeLineAsync"/>), which needs a reason.</summary>
    public Task<Result<BasisResponse>> RemoveLineAsync(Guid basisId, Guid lineId, string ifMatch, CancellationToken ct) =>
        MutateBasisAsync(basisId, ifMatch, basis => Task.FromResult(basis.RemoveLine(lineId, null, currentUser.UserId, time.GetUtcNow())), ct);

    public Task<Result<BasisResponse>> ExcludeLineAsync(Guid basisId, Guid lineId, LineDecisionRequest request, string ifMatch, CancellationToken ct) =>
        MutateBasisAsync(basisId, ifMatch, basis => Task.FromResult(basis.RemoveLine(lineId, request.Reason, currentUser.UserId, time.GetUtcNow())), ct);

    public Task<Result<BasisResponse>> RevertLineAsync(Guid basisId, Guid lineId, string ifMatch, CancellationToken ct) =>
        MutateBasisAsync(basisId, ifMatch, basis => Task.FromResult(basis.RevertLine(lineId, currentUser.UserId, time.GetUtcNow())), ct);

    public Task<Result<BasisResponse>> KeepLineAsync(Guid basisId, Guid lineId, LineDecisionRequest request, string ifMatch, CancellationToken ct) =>
        MutateBasisAsync(basisId, ifMatch, basis => Task.FromResult(basis.KeepLine(lineId, request.Reason, currentUser.UserId, time.GetUtcNow())), ct);

    /// <summary>
    /// Dry run of the charge-key migration (DEV-01): how the lines of open bases will be treated by their next collect. Lines of
    /// approved or exported bases keep their legacy shape and are reconciled by the charge register (DEV-03).
    /// </summary>
    public async Task<LegacyLinesReport> LegacyLinesAsync(CancellationToken ct)
    {
        var rows = await (
                from line in db.BillingLines.AsNoTracking()
                join basis in db.BillingBases.AsNoTracking() on line.BasisId equals basis.Id
                where line.Origin == BillingLineOrigin.Collected && line.SourceKey == null
                group line by new { basis.Status, line.ManuallyAdjusted } into g
                select new { g.Key.Status, g.Key.ManuallyAdjusted, Lines = g.Count(), Amount = g.Sum(l => l.LineTotal) })
            .ToListAsync(ct);
        var open = rows.Where(r => r.Status == BillingBasisStatus.Draft).ToList();
        var closed = rows.Where(r => r.Status != BillingBasisStatus.Draft).ToList();
        return new LegacyLinesReport(
            open.Where(r => !r.ManuallyAdjusted).Sum(r => r.Lines),
            open.Where(r => r.ManuallyAdjusted).Sum(r => r.Lines),
            decimal.Round(open.Where(r => r.ManuallyAdjusted).Sum(r => r.Amount), 2),
            closed.Sum(r => r.Lines),
            decimal.Round(closed.Sum(r => r.Amount), 2));
    }

    public Task<Result<BasisResponse>> RetryAsync(Guid basisId, CancellationToken ct) =>
        MutateBasisAsync(basisId, null, basis => Task.FromResult(basis.Retry()), ct);

    public Task<Result<BasisResponse>> CancelAsync(Guid basisId, CancelBasisRequest request, CancellationToken ct) =>
        MutateBasisAsync(basisId, null, basis => Task.FromResult(basis.Cancel(time.GetUtcNow(), request.Reason)), ct);

    // ---------- Invoices ----------

    public async Task<InvoiceSummary> ListInvoicesAsync(InvoiceQuery query, CancellationToken ct)
    {
        var invoices = db.Invoices.AsNoTracking();
        if (query.OrganizationId is { } organizationId)
        {
            invoices = invoices.Where(i => i.OrganizationId == organizationId);
        }

        if (query.OpenOnly)
        {
            invoices = invoices.Where(i => i.Outstanding > 0);
        }

        var today = Today;
        if (query.OverdueOnly)
        {
            invoices = invoices.Where(i => i.Outstanding > 0 && i.DueDate != null && i.DueDate < today);
        }

        var rows = await invoices.OrderByDescending(i => i.InvoiceDate).ThenByDescending(i => i.InvoiceNo)
            .Take(Math.Clamp(query.Limit ?? 100, 1, 500)).ToListAsync(ct);
        var names = await customers.GetOrganizationNamesAsync(rows.Where(i => i.OrganizationId != null).Select(i => i.OrganizationId!.Value).Distinct().ToList(), ct);
        var items = rows.Select(i => ToDto(i, names, today)).ToList();
        return new InvoiceSummary(
            items.Count,
            decimal.Round(rows.Sum(i => i.Outstanding), 2),
            decimal.Round(rows.Where(i => i.IsOverdue(today)).Sum(i => i.Outstanding), 2),
            items);
    }

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

    private async Task<Result<BasisResponse>> MutateBasisAsync(
        Guid id, string? ifMatch, Func<BillingBasis, Task<Result>> mutate, CancellationToken ct)
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

        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(basis, ct);
    }

    private async Task<RunResponse> ToResponseAsync(BillingRun run, CancellationToken ct)
    {
        var bases = await db.BillingBases.AsNoTracking().Include(b => b.Lines).Where(b => b.RunId == run.Id).ToListAsync(ct);
        var approvers = await users.GetUsersAsync(
            new[] { run.ApprovedBy, run.SecondApprovedBy }.Where(id => id is not null).Select(id => id!.Value).Distinct().ToList(), ct);
        return new RunResponse(
            run.Id,
            run.PeriodStart,
            run.PeriodEnd,
            run.Status,
            bases.Count,
            bases.Count(b => b.AnomaliesJson != null),
            bases.Count(b => b.Status == BillingBasisStatus.Exported),
            bases.Count(b => b.Status == BillingBasisStatus.Failed),
            decimal.Round(bases.Sum(b => b.TotalExVat), 2),
            run.RequiresSecondApproval,
            run.ApprovedBy is { } first && approvers.TryGetValue(first, out var firstUser) ? new RefDto(firstUser.Id, firstUser.DisplayName) : null,
            run.SecondApprovedBy is { } secondId && approvers.TryGetValue(secondId, out var secondUser) ? new RefDto(secondUser.Id, secondUser.DisplayName) : null,
            run.CollectedAt,
            run.ApprovedAt,
            run.ExportedAt,
            run.ClosedAt,
            run.Notes,
            bases.Sum(b => b.ConflictCount),
            db.GetETag(run));
    }

    private async Task<BasisResponse> ToResponseAsync(BillingBasis basis, CancellationToken ct)
    {
        var run = await db.BillingRuns.AsNoTracking().SingleAsync(r => r.Id == basis.RunId, ct);
        var names = await customers.GetOrganizationNamesAsync([basis.OrganizationId], ct);
        var productIds = basis.CurrentLines.Where(l => l.ProductId is not null).Select(l => l.ProductId!.Value).Distinct().ToList();
        var products = await catalog.GetProductsAsync(productIds, ct);
        var invoices = await db.Invoices.AsNoTracking().Where(i => i.BasisId == basis.Id).ToListAsync(ct);
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
        invoice.SyncedAt);

    private async Task<Dictionary<Guid, (int Organizations, int WithAnomalies, decimal Total)>> TotalsAsync(
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
            })
            .ToListAsync(ct);
        return rows.ToDictionary(r => r.Key, r => (r.Organizations, r.WithAnomalies, decimal.Round(r.Total, 2)));
    }

    public decimal SecondApprovalThreshold => options.Value.SecondApprovalThreshold;
}
