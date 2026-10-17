using Crm.Billing.Contracts;
using Crm.Identity.Contracts;
using Crm.SharedKernel.Domain;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.TimeTracking.Features;

/// <summary>Terminal marking is allowed in closed history; admission stays with the inbox transaction through its commit.</summary>
internal sealed class BasisExportedHandler(TimeTrackingDbContext db, IBillingApi billing, ILogger<BasisExportedHandler> logger)
    : IDomainEventHandler<BillingBasisExported>
{
    public async Task HandleAsync(BillingBasisExported domainEvent, CancellationToken ct)
    {
        var ids = await billing.GetInvoicedTimeEntryIdsAsync(domainEvent.BasisId, ct);
        if (ids.Count == 0) return;
        await using var mutation = await TimeMutationScope.OpenAsync(db, ct); var write = mutation.Db;
        var admission = await TimeRowAdmission.DiscoverAsync(write, ids, MonthMode.Shared, [], ct);
        if (!admission.IsSuccess) throw new TimeAdmissionException(admission.Error!.Code);
        var current = await TimeRowAdmission.ReadAsync(write, ids, admission.Value, ct);
        if (!current.IsSuccess) throw new TimeAdmissionException(current.Error!.Code);
        var entries = current.Value.Where(e => e.Status == TimeEntryStatus.Approved).ToList();
        foreach (var entry in entries) entry.MarkInvoiced();
        await write.SaveChangesAsync(ct); await mutation.CommitAsync(ct);
        logger.LogInformation("Basis {BasisId} exported as {OrderNo}: {Count} time entries marked invoiced.", domainEvent.BasisId, domainEvent.OrderNo, entries.Count);
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
