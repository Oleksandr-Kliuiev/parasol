using Crm.Billing.Contracts;
using Crm.Identity.Contracts;
using Crm.SharedKernel.Domain;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.TimeTracking.Features;

/// <summary>Terminal marking is allowed in closed history; admission stays with the inbox transaction through its commit.</summary>
internal sealed class BasisExportedHandler(TimeTrackingDbContext db, ITimeBillingReader billing, ILogger<BasisExportedHandler> logger)
    : IDomainEventHandler<BillingBasisExported>
{
    public async Task HandleAsync(BillingBasisExported domainEvent, CancellationToken ct)
    {
        var claims = await billing.ReadExportedBasisAsync(domainEvent.BasisId, ct);
        if (claims.Count == 0) return;
        var ids = claims.SelectMany(c => c.EntryIds).Distinct().ToList();
        if (ids.Count == 0) throw new TimeAdmissionException(TimeBillingGuard.Changed.Code);
        await using var mutation = await TimeMutationScope.OpenAsync(db, ct); var write = mutation.Db;
        var admission = await TimeRowAdmission.DiscoverAsync(write, ids, MonthMode.Shared, [], ct);
        if (!admission.IsSuccess) throw new TimeAdmissionException(admission.Error!.Code);
        var current = await TimeRowAdmission.ReadAsync(write, ids, admission.Value, ct);
        if (!current.IsSuccess) throw new TimeAdmissionException(current.Error!.Code);
        var entries = current.Value.ToList();
        var selections = claims.Select(c => new TimeBillingSelection(c.OrganizationId, c.EntryIds, c.AllocationIds, c.Proven)).ToList();
        var marked = 0;
        if (!TimeBillingAdmission.Matches(selections, entries, allowInvoiced: true))
        {
            foreach (var entry in entries) entry.FlagForReview("The exported allocation snapshot differs from the current approval. Finance must reconcile the historical revisions; the current revision was not marked invoiced.");
        }
        else
        {
            var allClaims = await billing.ReadAsync(entries.Select(e => new TimeBillingEntry(e.Id, e.OrganizationId)).ToList(), ct);
            var exported = allClaims.Where(c => c.Exported && c.Proven).SelectMany(c => c.AllocationIds).ToHashSet();
            foreach (var entry in entries.Where(e => e.Status == TimeEntryStatus.Approved))
            {
                if (entry.CurrentAllocations.All(a => exported.Contains(a.Id))) { entry.MarkInvoiced(); marked++; }
                else if (entry.ReviewNote is null) entry.FlagForReview("Only some approved allocations are exported. Remaining allocations must be billed separately; Finance must not withdraw this approval.");
            }
        }
        await write.SaveChangesAsync(ct); await mutation.CommitAsync(ct);
        logger.LogInformation("Basis {BasisId} exported as {OrderNo}: {Count} time entries marked invoiced.", domainEvent.BasisId, domainEvent.OrderNo, marked);
    }
}

/// <summary>Source-scoped identity metadata may be corrected in closed history; tracked writes retain their audit.</summary>
internal sealed class TechnicianMappingHandler(TimeTrackingDbContext db) : IDomainEventHandler<TechnicianMappingChanged>
{
    public async Task HandleAsync(TechnicianMappingChanged domainEvent, CancellationToken ct)
    {
        if (domainEvent.UserId is not { } userId || !Enum.TryParse<TimeSource>(domainEvent.System, true, out var source)
            || !Enum.IsDefined(source) || source == TimeSource.Crm) return;
        await using var mutation = await TimeMutationScope.OpenAsync(db, ct); var write = mutation.Db;
        await MonthAdmission.LockSourcesAsync(write, [source.ToString()], ct);
        var ids = await write.TimeEntries.AsNoTracking().Where(e => e.Source == source && e.TechnicianExternalId == domainEvent.ExternalId && e.TechnicianId != userId)
            .Select(e => e.Id).ToListAsync(ct);
        var admission = await TimeRowAdmission.DiscoverAsync(write, ids, MonthMode.Shared, [], ct);
        if (!admission.IsSuccess) throw new TimeAdmissionException(admission.Error!.Code);
        var current = await TimeRowAdmission.ReadAsync(write, ids, admission.Value, ct);
        if (!current.IsSuccess) throw new TimeAdmissionException(current.Error!.Code);
        foreach (var entry in current.Value.Where(e => e.Source == source && e.TechnicianExternalId == domainEvent.ExternalId)) entry.AssignTechnician(userId);
        await write.SaveChangesAsync(ct); await mutation.CommitAsync(ct);
    }
}
