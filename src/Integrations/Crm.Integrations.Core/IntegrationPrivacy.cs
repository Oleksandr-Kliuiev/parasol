using System.Globalization;
using Crm.Integrations.Core.Persistence;
using Crm.Privacy.Contracts;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

/// <summary>
/// The integrations' part in subject requests (DEV-11) for a contact person: the links to Atera and PowerOffice, the mirrored
/// person records (linked, or carrying the person's address) and the changes queued for those systems. Erasure removes the
/// links, leaves each mirrored record as a bare key, and withdraws what was still to be sent. The external systems keep
/// their own records: the receipt names them, and erasing there is their owners' step.
/// </summary>
internal sealed class IntegrationPersonalData(IntegrationDbContext db) : IPersonalDataContributor, IExternalReferenceSource
{
    public const string LinkClass = "integration.link";
    public const string RecordClass = "integration.external-record";
    public const string OutboundClass = "integration.outbound";

    public string Module => IntegrationDbContext.SchemaName;

    public async Task<IReadOnlyList<ExternalReference>> ReferencesAsync(DataSubject subject, CancellationToken cancellationToken) =>
        subject.Kind != DataSubjectKind.Contact
            ? []
            : (await PersonRecordsAsync(subject, cancellationToken)).Select(r => new ExternalReference(r.System, r.ExternalType, r.ExternalId))
                .Concat((await LinksAsync(subject, cancellationToken)).Select(l => new ExternalReference(l.System, l.ExternalType, l.ExternalId)))
                .Distinct()
                .ToList();

    public async Task<PersonalDataSection> ExportAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        if (subject.Kind != DataSubjectKind.Contact)
        {
            return new PersonalDataSection(Module, [], ["A lead is not linked to external systems."]);
        }

        var items = (await LinksAsync(subject, cancellationToken)).Select(l => new PersonalDataItem("externalLink", l.Id, new Dictionary<string, string?>
        {
            ["system"] = l.System,
            ["type"] = l.ExternalType,
            ["externalId"] = l.ExternalId,
            ["linkedAt"] = l.LinkedAt.ToString("O", CultureInfo.InvariantCulture),
        })).ToList();
        items.AddRange((await PersonRecordsAsync(subject, cancellationToken)).Select(r => new PersonalDataItem("externalRecord", r.Id, new Dictionary<string, string?>
        {
            ["system"] = r.System,
            ["type"] = r.ExternalType,
            ["externalId"] = r.ExternalId,
            ["name"] = r.DisplayName,
            ["email"] = r.Email,
            ["phone"] = r.Phone,
            ["payload"] = r.Payload,
            ["lastSeenAt"] = r.LastSeenAt.ToString("O", CultureInfo.InvariantCulture),
        })));
        items.AddRange((await OutboundAsync(subject, cancellationToken)).Select(o => new PersonalDataItem("outboundOperation", o.Id, new Dictionary<string, string?>
        {
            ["system"] = o.System,
            ["operation"] = o.Operation,
            ["status"] = o.Status.ToString(),
            ["createdAt"] = o.CreatedAt.ToString("O", CultureInfo.InvariantCulture),
        })));
        return new PersonalDataSection(Module, items, ["Atera and PowerOffice hold their own records of the person; ask their owners for them."]);
    }

    public async Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        if (subject.Kind != DataSubjectKind.Contact)
        {
            return [];
        }

        var plan = (await LinksAsync(subject, cancellationToken))
            .Select(l => new PlannedErasure(new RecordRef(Module, nameof(ExternalLink), l.Id), ErasureAction.Delete, LinkClass)).ToList();
        plan.AddRange((await PersonRecordsAsync(subject, cancellationToken))
            .Select(r => new PlannedErasure(new RecordRef(Module, nameof(ExternalRecord), r.Id), ErasureAction.Pseudonymize, RecordClass)));
        plan.AddRange((await OutboundAsync(subject, cancellationToken))
            .Select(o => new PlannedErasure(new RecordRef(Module, nameof(OutboundOperation), o.Id), ErasureAction.Pseudonymize, OutboundClass)));
        return plan;
    }

    public async Task<IReadOnlyList<ErasedRecord>> EraseAsync(
        DataSubject subject, IReadOnlyList<PlannedErasure> plan, string reference, CancellationToken cancellationToken)
    {
        var due = plan.Where(p => p.Action != ErasureAction.Retain).ToList();
        await ApplyAsync(due.Select(p => p.Record).ToList(), cancellationToken);
        return due.Select(p => new ErasedRecord(p.Record, p.Action, p.DataClass)).ToList();
    }

    public Task<int> ReapplyAsync(IReadOnlyList<ErasedRecord> records, string reference, CancellationToken cancellationToken) =>
        ApplyAsync(records.Select(r => r.Record).ToList(), cancellationToken);

    private async Task<int> ApplyAsync(IReadOnlyList<RecordRef> records, CancellationToken ct)
    {
        var linkIds = Ids(records, nameof(ExternalLink));
        var recordIds = Ids(records, nameof(ExternalRecord));
        var operationIds = Ids(records, nameof(OutboundOperation));
        var applied = 0;
        foreach (var link in await db.ExternalLinks.Where(l => linkIds.Contains(l.Id)).ToListAsync(ct))
        {
            db.ExternalLinks.Remove(link);
            applied++;
        }

        foreach (var record in await db.ExternalRecords.Where(r => recordIds.Contains(r.Id)).ToListAsync(ct))
        {
            applied += ExternalRecordStore.Redact(record) ? 1 : 0;
        }

        foreach (var operation in await db.OutboundOperations.Where(o => operationIds.Contains(o.Id)).ToListAsync(ct))
        {
            // Nothing more goes out about the person; what went out is the external system's to erase.
            var changed = operation.LastError is not null || operation.Result is not null;
            if (operation.Status is OutboundStatus.Pending or OutboundStatus.Failed or OutboundStatus.DeadLetter)
            {
                operation.Status = OutboundStatus.Cancelled;
                operation.LockedUntil = null;
                operation.LeaseOwner = null;
                changed = true;
            }

            operation.LastError = null;
            operation.Result = null;
            applied += changed ? 1 : 0;
        }

        await db.SaveChangesAsync(ct);
        return applied;
    }

    private static List<Guid> Ids(IEnumerable<RecordRef> records, string type) =>
        records.Where(r => r.EntityType == type).Select(r => r.EntityId).ToList();

    private Task<List<ExternalLink>> LinksAsync(DataSubject subject, CancellationToken ct) =>
        db.ExternalLinks.AsNoTracking().Where(l => l.EntityType == EntityTypes.Contact && l.EntityId == subject.Id).ToListAsync(ct);

    /// <summary>
    /// The person's mirrored records: those linked to the contact, and person records — child records of a customer, as the
    /// adapters store contact persons — carrying one of their addresses.
    /// </summary>
    private async Task<List<ExternalRecord>> PersonRecordsAsync(DataSubject subject, CancellationToken ct)
    {
        var result = new List<ExternalRecord>();
        foreach (var link in await LinksAsync(subject, ct))
        {
            if (await db.ExternalRecords.AsNoTracking().SingleOrDefaultAsync(
                    r => r.System == link.System && r.ExternalType == link.ExternalType && r.ExternalId == link.ExternalId, ct) is { } linked)
            {
                result.Add(linked);
            }
        }

        var emails = subject.Emails.Select(e => e.Trim().ToLowerInvariant()).ToList();
        if (emails.Count > 0)
        {
            result.AddRange(await db.ExternalRecords.AsNoTracking()
                .Where(r => r.Email != null && emails.Contains(r.Email) && r.ParentExternalId != null).ToListAsync(ct));
        }

        return result.DistinctBy(r => r.Id).ToList();
    }

    private Task<List<OutboundOperation>> OutboundAsync(DataSubject subject, CancellationToken ct) =>
        db.OutboundOperations.AsNoTracking().Where(o => o.EntityType == EntityTypes.Contact && o.EntityId == subject.Id).ToListAsync(ct);
}

/// <summary>Raw payloads of mirrored records (docs/04 §8: kept for troubleshooting): cleared once older than the approved period.</summary>
internal sealed class ExternalPayloadRetention(IntegrationDbContext db) : IRetentionContributor
{
    public const string Class = "integration.external-payloads";

    public string DataClass => Class;

    public Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken) => Due(olderThan).CountAsync(cancellationToken);

    public async Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken)
    {
        var ids = await Due(olderThan).OrderBy(r => r.Id).Select(r => r.Id).Take(batchSize).ToListAsync(cancellationToken);
        return ids.Count == 0
            ? 0
            : await db.ExternalRecords.Where(r => ids.Contains(r.Id)).ExecuteUpdateAsync(s => s.SetProperty(r => r.Payload, ExternalRecordStore.RedactedPayload), cancellationToken);
    }

    // Only records no longer in use: gone from the source, or not seen since — a live record's payload is what the mapping
    // screen and the next import read.
    private IQueryable<ExternalRecord> Due(DateTimeOffset olderThan) =>
        db.ExternalRecords.Where(r => r.Payload != ExternalRecordStore.RedactedPayload && r.LastSeenAt < olderThan);
}

/// <summary>The synchronization log (docs/04 §8: 180 days proposed): runs older than the approved period are removed.</summary>
internal sealed class SyncRunRetention(IntegrationDbContext db) : IRetentionContributor
{
    public const string Class = "integration.sync-runs";

    public string DataClass => Class;

    public Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken) =>
        db.SyncRuns.CountAsync(r => r.StartedAt < olderThan && r.Status != SyncRunStatus.Running, cancellationToken);

    public async Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken)
    {
        var ids = await db.SyncRuns.Where(r => r.StartedAt < olderThan && r.Status != SyncRunStatus.Running)
            .OrderBy(r => r.StartedAt).Select(r => r.Id).Take(batchSize).ToListAsync(cancellationToken);
        return ids.Count == 0 ? 0 : await db.SyncRuns.Where(r => ids.Contains(r.Id)).ExecuteDeleteAsync(cancellationToken);
    }
}
