using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.TimeTracking.Features;

internal sealed class TimeFinancialReviewService(TimeTrackingDbContext db, IContractsApi contracts, ITimeBillingReader billing,
    ICustomersApi customers, ICurrentUser user, TimeProvider time)
{
    public static readonly string[] RequiredPermissions = [Permissions.TimeRead, Permissions.FinanceRead,
        Permissions.ContractsRead, Permissions.BillingRead, Permissions.CustomersRead];

    public async Task<Result<TimeFinancialReview>> ReadAsync(Guid id, CancellationToken ct)
    {
        if (!user.IsAuthenticated || !RequiredPermissions.All(user.HasPermission))
            return Error.Forbidden("TIM_REVIEW_FORBIDDEN", "Financial review requires Time, Finance, Contracts, Billing and Customer read access.");
        var candidate = await db.TimeEntries.AsNoTracking().Where(e => e.Id == id).Select(e => new { e.OrganizationId }).SingleOrDefaultAsync(ct);
        if (candidate is null) return TimeErrors.NotFound(id);
        // Resolve customer display data before taking the ordered Time lease; never re-enter Customers while holding it.
        var names = await customers.GetOrganizationNamesAsync([candidate.OrganizationId], ct);
        await using var lease = await TimeMutationScope.OpenAsync(db, ct); var read = lease.Db;
        var admission = await TimeRowAdmission.DiscoverAsync(read, [id], MonthMode.Shared, [], ct);
        if (!admission.IsSuccess) return admission.Error!;
        var current = await TimeRowAdmission.ReadAsync(read, [id], admission.Value, ct);
        if (!current.IsSuccess) return current.Error!;
        if (current.Value.SingleOrDefault() is not { } entry) return TimeErrors.NotFound(id);
        if (entry.OrganizationId != candidate.OrganizationId) return MonthAdmission.Changed;
        var receipts = await contracts.GetSourceBankUsageAsync("TimeEntry", id + ":", ct);
        var bankIds = receipts.Select(r => r.HourBankId).Concat(entry.CurrentAllocations.Where(a => a.HourBankId != null).Select(a => a.HourBankId!.Value)).Distinct().ToList();
        var references = await contracts.GetHourBankReviewRefsAsync(bankIds, ct);
        var claims = await billing.ReadAsync([new(id, entry.OrganizationId)], ct);
        var history = await read.TimeAllocations.IgnoreQueryFilters().AsNoTracking().Where(a => a.TimeEntryId == id).Select(a => a.Id).ToListAsync(ct);
        var closed = (await MonthAdmission.ClosedAsync(read, admission.Value, ct)).Contains(TimeMonth.Of(entry.WorkDate));
        var result = FinancialReviewAnalysis.Evaluate(entry, history, receipts, references, claims, closed);
        // No SaveChanges or commit: this read lease rolls back and releases its locks on return, without durable effects.
        return new TimeFinancialReview(1, id, entry.OrganizationId, names.GetValueOrDefault(entry.OrganizationId), entry.WorkDate,
            entry.Hours, entry.Status, entry.ApprovalCount, entry.ReviewNote, closed, read.GetETag(entry), time.GetUtcNow(), result.RequiresReview,
            result.Findings, result.Banks, result.Billing);
    }
}
