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
    /// <summary>
    /// Approves the revision the caller saw: <paramref name="ifMatch"/> is the run's ETag, which changes with every collect and
    /// every change of the lines, so an approval of an older screen fails with 412 and writes nothing. The run computes the
    /// threshold and the content digest from the bases as they are in this transaction (BR-BIL-04, ADR-012).
    /// </summary>
    public async Task<Result<RunResponse>> ApproveAsync(Guid id, bool second, string ifMatch, CancellationToken ct)
    {
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

        if (currentUser.UserId is not { } approver)
        {
            return BillingErrors.ApproverRequired;
        }

        // The sign-in cache may lag behind a deactivation; an approval always reads the account as it is now.
        if (await users.GetProfileAsync(approver, ct) is not { IsActive: true })
        {
            return BillingErrors.ApproverInactive;
        }

        if (run.Status is not (BillingRunStatus.Collected or BillingRunStatus.InReview))
            return BillingErrors.InvalidStatus(run.Status, "approved");

        var bases = await db.BillingBases.Include(b => b.Lines).Where(b => b.RunId == run.Id).ToListAsync(ct);
        var now = time.GetUtcNow();
        if (db.Database.CurrentTransaction is not null) throw new InvalidOperationException("Billing approval must own its local command.");
        var source = await timeAdmission.HoldAsync(TimeBillingSources.Selections(bases), ct);
        if (!source.IsSuccess) return source.Error!;
        await using (source.Value)
        {
            var approved = run.Approve(second ? BillingApprovalKind.Second : BillingApprovalKind.First, approver, now, bases, options.Value.SecondApprovalThreshold);
            if (!approved.IsSuccess)
            {
                return approved.Error!;
            }
            if (run.Status == BillingRunStatus.Approved)
            {
                // Approving the run approves every basis: from here on they are immutable (BR-BIL-10), and the obligations they
                // bill are committed in the same transaction (ADR-013).
                foreach (var basis in bases)
                {
                    basis.Approve();
                }

                await ledger.CommitAsync(run.Id, bases, now, ct);
            }

            await db.SaveChangesAsync(ct);
        }
        return await ToResponseAsync(run, ct);
    }

}
