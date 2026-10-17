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

public sealed record RunQuery(BillingRunStatus? Status, int? Year, int? Limit, string? Cursor = null, bool OpenOnly = false);

public sealed record BasisQuery(Guid RunId, bool AnomaliesOnly, BillingBasisStatus? Status, string? Search);

public sealed record InvoiceQuery(Guid? OrganizationId, bool OpenOnly, bool OverdueOnly, int? Limit, string? Cursor = null);

internal sealed partial class BillingService(
    BillingDbContext db,
    BillingCollector collector,
    ChargeLedger ledger,
    ICustomersApi customers,
    ICatalogApi catalog,
    IUserDirectory users,
    ICurrentUser currentUser,
    IOptions<BillingOptions> options,
    TimeProvider time,
    Crm.TimeTracking.Contracts.ITimeBillingAdmission timeAdmission)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private DateOnly Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);

    // ---------- Runs ----------

    public async Task<PagedResult<RunListItem>> ListRunsAsync(RunQuery query, CancellationToken ct)
    {
        var runs = db.BillingRuns.AsNoTracking();
        if (query.Status is { } status)
        {
            runs = runs.Where(r => r.Status == status);
        }

        if (query.OpenOnly)
        {
            runs = runs.Where(r => r.Status != BillingRunStatus.Closed);
        }

        if (query.Year is { } year)
        {
            runs = runs.Where(r => r.PeriodStart.Year == year);
        }

        // Newest period first, then id — a supplementary run after the regular one (DEV-12): a page per request and the count of all.
        var total = await runs.CountAsync(ct);
        if (KeysetCursor.Decode(query.Cursor) is { } after &&
            DateOnly.TryParseExact(after.SortKey, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var period))
        {
            runs = runs.Where(r => r.PeriodStart < period || (r.PeriodStart == period && r.Id.CompareTo(after.Id) < 0));
        }

        var take = Math.Clamp(query.Limit ?? 24, 1, KeysetCursor.MaxLimit);
        var page = await runs.OrderByDescending(r => r.PeriodStart).ThenByDescending(r => r.Id).Take(take + 1).ToListAsync(ct);
        var rows = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(rows[^1].PeriodStart.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null;
        var totals = await TotalsAsync(rows.Select(r => r.Id).ToList(), ct);
        return new PagedResult<RunListItem>(rows.Select(r =>
        {
            var totalsOfRun = totals.GetValueOrDefault(r.Id);
            // Like the run itself: an open run says what its content needs now (BR-BIL-04), a released one what it was released with.
            var requiresSecond = r.IsLocked ? r.RequiresSecondApproval : totalsOfRun.LargestBasis > options.Value.SecondApprovalThreshold;
            return new RunListItem(
                r.Id, r.PeriodStart, r.PeriodEnd, r.Kind, r.Status, totalsOfRun.Organizations, totalsOfRun.WithAnomalies, totalsOfRun.Total,
                requiresSecond, r.CollectedAt, r.ApprovedAt, r.ExportedAt, r.ClosedAt);
        }).ToList(), next, total);
    }

    public async Task<Result<RunResponse>> GetRunAsync(Guid id, CancellationToken ct)
    {
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == id, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(id);
        }

        return await ToResponseAsync(run, ct);
    }

    /// <summary>
    /// One open run per period (BR-BIL-01). A period that is billed and closed gets no second regular run: a further run is
    /// a supplementary one, and like every run it bills only what the charge register does not hold yet (ADR-013).
    /// </summary>
    public async Task<Result<RunResponse>> CreateRunAsync(CreateRunRequest request, CancellationToken ct)
    {
        var periodStart = new DateOnly(request.Year, request.Month, 1);
        var statuses = await db.BillingRuns.Where(r => r.PeriodStart == periodStart).Select(r => r.Status).ToListAsync(ct);
        if (statuses.Any(s => s != BillingRunStatus.Closed))
        {
            return BillingErrors.PeriodBusy(periodStart);
        }

        var billed = statuses.Contains(BillingRunStatus.Closed);
        if (billed && !request.Supplementary)
        {
            return BillingErrors.PeriodAlreadyBilled(periodStart);
        }

        if (!billed && request.Supplementary)
        {
            return BillingErrors.NothingToSupplement(periodStart);
        }

        var run = BillingRun.Create(request.Year, request.Month, request.Notes, request.Supplementary ? BillingRunKind.Supplementary : BillingRunKind.Regular);
        db.BillingRuns.Add(run);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException exception) when (exception.IsUniqueViolation())
        {
            // Two runs for the period were created at the same moment: the unique index of open periods kept the other one.
            return BillingErrors.PeriodBusy(periodStart);
        }

        return await ToResponseAsync(run, ct);
    }

    /// <summary>
    /// Collects or re-collects the bases of a run (BR-BIL-02). Every collect is a new revision: earlier approvals no longer
    /// count. The collect is one transaction under the charge register's lock, so two collects never reserve one obligation
    /// twice (ADR-013); a transient failure repeats the whole transaction from a clean state.
    /// </summary>
    public async Task<Result<RunResponse>> CollectAsync(Guid id, string ifMatch, CancellationToken ct)
    {
        Result<BillingRun> collected;
        try
        {
            collected = await db.Database.CreateExecutionStrategy().ExecuteAsync(c => CollectInTransactionAsync(id, ifMatch, c), ct);
        }
        catch (Crm.TimeTracking.Contracts.TimeBillingReviewException)
        {
            return Error.Conflict("TIM_BILLING_SOURCE_CHANGED", "Historical billing allocations require Finance review before this run can be collected.");
        }
        catch (Microsoft.Data.SqlClient.SqlException exception) when (exception.Number == 51000)
        {
            return BillingErrors.CollectBusy;
        }

        return collected.IsSuccess ? await ToResponseAsync(collected.Value, ct) : collected.Error!;
    }

    private async Task<Result<BillingRun>> CollectInTransactionAsync(Guid id, string ifMatch, CancellationToken ct)
    {
        db.ChangeTracker.Clear();
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        if (await LoadRunAsync(id, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(id);
        }

        if (!db.ApplyIfMatch(run, ifMatch))
        {
            return Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
        }

        if (db.IsStale(run))
        {
            return BillingErrors.RunChanged;
        }

        if (run.IsLocked)
        {
            return BillingErrors.InvalidStatus(run.Status, "collected again");
        }

        await ledger.LockAsync(ct);
        var result = await collector.CollectAsync(run, ct);
        var marked = run.MarkCollected(time.GetUtcNow(), result.RequiresSecondApproval);
        if (!marked.IsSuccess)
        {
            return marked.Error!;
        }

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return run;
    }

    public Task<Result<RunResponse>> ReviewAsync(Guid id, CancellationToken ct) => MutateAsync(id, run => run.StartReview(), ct);

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
            await ledger.ReleaseAsync(basis.Id, "The run was discarded.", time.GetUtcNow(), ct);
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
        MutateBasisAsync(basisId, null, basis => Task.FromResult(basis.Retry()), ct, resetReason: null);

    /// <summary>
    /// Cancels a basis that was never sent and frees its obligations for a later run. A basis whose order may exist is
    /// reconciled first (ADR-013); an exported one is credited in the accounting system (BR-BIL-09).
    /// </summary>
    public Task<Result<BasisResponse>> CancelAsync(Guid basisId, CancelBasisRequest request, string ifMatch, CancellationToken ct) =>
        MutateBasisAsync(basisId, ifMatch, async basis =>
        {
            var now = time.GetUtcNow();
            var cancelled = basis.Cancel(now, request.Reason);
            if (cancelled.IsSuccess)
            {
                await ledger.ReleaseAsync(basis.Id, $"The basis was cancelled before anything was sent: {request.Reason}", now, ct);
            }

            return cancelled;
        }, ct, ApprovalResetReasons.BasisCancelled);

    /// <summary>
    /// Finance checked the accounting system for a basis whose send got no answer: the order exists (its number is recorded
    /// and the charges are billed) or it does not (the basis can be sent again or cancelled). Audited with the reason.
    /// </summary>
    public async Task<Result<BasisResponse>> ReconcileAsync(Guid basisId, ReconcileRequest request, string ifMatch, CancellationToken ct)
    {
        var reconciled = await MutateBasisAsync(basisId, ifMatch, async basis =>
        {
            var now = time.GetUtcNow();
            var result = basis.Reconcile(request.Created, request.OrderNo, request.Reason, basis.ExportSystem ?? "poweroffice", now, currentUser.UserId?.ToString());
            if (!result.IsSuccess)
            {
                return result;
            }

            if (request.Created)
            {
                await ledger.ConfirmExportAsync(basis.Id, now, $"Reconciled: {request.Reason}", ct);
            }
            else
            {
                await ledger.ReconciledNotCreatedAsync(basis.Id, now, $"Reconciled, no order: {request.Reason}", ct);
            }

            return Result.Success();
        }, ct, resetReason: null);

        if (reconciled.IsSuccess)
        {
            await BillingApi.UpdateRunStatusAsync(db, reconciled.Value.RunId, time.GetUtcNow(), ct);
        }

        return reconciled;
    }

    /// <summary>
    /// Adds to an exported line: a new one-time charge that refers to the line, with the amount and the reason, billed by the
    /// next run (BR-BIL-10, ADR-013). The exported order itself never changes; crediting stays in the accounting system.
    /// </summary>
    public async Task<Result<CorrectionResponse>> AddCorrectionAsync(Guid basisId, Guid lineId, CorrectionRequest request, CancellationToken ct)
    {
        if (await LoadBasisAsync(basisId, ct) is not { } basis)
        {
            return BillingErrors.BasisNotFound(basisId);
        }

        if (basis.Status != BillingBasisStatus.Exported)
        {
            return BillingErrors.NotExported;
        }

        if (basis.CurrentLines.FirstOrDefault(l => l.Id == lineId) is not { } line)
        {
            return BillingErrors.LineNotFound(lineId);
        }

        if (line.Decision == BillingLineDecision.Exclusion)
        {
            return BillingErrors.LineExcluded;
        }

        if (request.Amount < 0)
        {
            return BillingErrors.CreditNotEnabled;
        }

        var correction = PendingCharge.Correction(
            line.SourceOrganizationId ?? basis.OrganizationId,
            line.ProductId,
            string.IsNullOrWhiteSpace(request.Description) ? line.Description : request.Description.Trim(),
            request.Amount,
            line.VatRate,
            line.Id,
            SequentialId.New(time.GetUtcNow()),
            request.Reason.Trim(),
            Today);
        db.PendingCharges.Add(correction);
        await db.SaveChangesAsync(ct);
        return new CorrectionResponse(correction.Id, correction.Description, correction.UnitPrice, correction.ChargeableFrom, line.Id);
    }

    /// <summary>
    /// The lines billed before the register existed that the backfill could not prove (ADR-013): what they are, for which
    /// customer, period and amount, and why. They hold what they may cover until Finance decides (EXT-01).
    /// </summary>
    public async Task<LegacyChargeReport> LegacyChargesAsync(CancellationToken ct)
    {
        var charges = await db.Charges.Where(c => c.Status == ChargeStatus.LegacyUnresolved).OrderBy(c => c.ServiceFrom).ToListAsync(ct);
        var lineIds = charges.Where(c => c.LineId is not null).Select(c => c.LineId!.Value).ToList();
        var descriptions = await db.BillingLines.IgnoreQueryFilters().AsNoTracking().Where(l => lineIds.Contains(l.Id))
            .ToDictionaryAsync(l => l.Id, l => l.Description, ct);
        var names = await customers.GetOrganizationNamesAsync(charges.Select(c => c.PayerOrganizationId).Distinct().ToList(), ct);
        var items = charges
            .Select(c => new LegacyChargeItem(
                c.Id,
                new RefDto(c.PayerOrganizationId, names.GetValueOrDefault(c.PayerOrganizationId, "—")),
                c.ServiceFrom,
                c.LineId is { } id ? descriptions.GetValueOrDefault(id) : null,
                c.Amount,
                c.Reason,
                db.GetETag(c)))
            .ToList();
        return new LegacyChargeReport(
            items.Count,
            decimal.Round(charges.Sum(c => c.Amount), 2),
            charges.GroupBy(c => c.Reason ?? "—").Select(g => new LegacyChargeGroup(g.Key, g.Count(), decimal.Round(g.Sum(c => c.Amount), 2))).ToList(),
            items);
    }

    /// <summary>Finance's decision about a legacy line: billed back then (it keeps holding what it covers) or not (released).</summary>
    public async Task<Result> DecideLegacyAsync(Guid chargeId, LegacyDecisionRequest request, string ifMatch, CancellationToken ct)
    {
        if (await db.Charges.SingleOrDefaultAsync(c => c.Id == chargeId, ct) is not { } charge)
        {
            return BillingErrors.ChargeNotFound(chargeId);
        }

        if (!db.ApplyIfMatch(charge, ifMatch))
        {
            return Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
        }

        var decided = charge.DecideLegacy(request.Billed, request.Reason.Trim(), time.GetUtcNow());
        if (!decided.IsSuccess)
        {
            return decided;
        }

        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    // ---------- Invoices ----------

    /// <summary>
    /// One page of invoices, newest first, and the totals of every invoice the filter matches (DEV-12, A11): the count and the
    /// amounts are one SQL aggregate over the whole filter, never a sum of the rows that happen to be on the page.
    /// </summary>
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

        var totals = await invoices
            .GroupBy(_ => 1)
            .Select(g => new
            {
                Count = g.Count(),
                Outstanding = g.Sum(i => i.Outstanding),
                Overdue = g.Sum(i => i.Outstanding > 0 && i.DueDate != null && i.DueDate < today ? i.Outstanding : 0m),
            })
            .SingleOrDefaultAsync(ct);

        // Newest first: date, then number, then id — the id makes the order total, so a cursor neither repeats nor skips an
        // invoice that shares its date and number with another (two systems may number alike).
        if (KeysetCursor.Decode(query.Cursor) is { } cursor &&
            DateOnly.TryParseExact(cursor.SortKey, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
        {
            var number = cursor.Then ?? string.Empty;
            invoices = invoices.Where(i => i.InvoiceDate < date ||
                                           (i.InvoiceDate == date && (i.InvoiceNo.CompareTo(number) < 0 ||
                                                                      (i.InvoiceNo == number && i.Id.CompareTo(cursor.Id) < 0))));
        }

        var limit = KeysetCursor.ClampLimit(query.Limit);
        var page = await invoices.Include(i => i.Payments).OrderByDescending(i => i.InvoiceDate).ThenByDescending(i => i.InvoiceNo).ThenByDescending(i => i.Id)
            .Take(limit + 1).ToListAsync(ct);
        var rows = page.Take(limit).ToList();
        var names = await customers.GetOrganizationNamesAsync(rows.Where(i => i.OrganizationId != null).Select(i => i.OrganizationId!.Value).Distinct().ToList(), ct);
        var last = rows.LastOrDefault();
        return new InvoiceSummary(
            totals?.Count ?? 0,
            decimal.Round(totals?.Outstanding ?? 0m, 2),
            decimal.Round(totals?.Overdue ?? 0m, 2),
            rows.Select(i => ToDto(i, names, today)).ToList(),
            page.Count > limit && last is not null
                ? new KeysetCursor(last.InvoiceDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), last.Id, last.InvoiceNo).Encode()
                : null,
            today);
    }

}
