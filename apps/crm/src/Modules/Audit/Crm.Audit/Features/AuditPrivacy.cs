using System.Globalization;
using Crm.Audit.Persistence;
using Crm.Privacy.Contracts;
using Microsoft.EntityFrameworkCore;

namespace Crm.Audit.Features;

/// <summary>
/// The audit trail's part in subject requests (DEV-11): the history of the person's own records — what changed and when —
/// without who changed it (that is about employees). The application never changes the trail: what a privacy case erased is
/// hidden from every view at once and its payload cleared by the privacy operator's procedure audit.ClearErasedPayloads.
/// </summary>
internal sealed class AuditPersonalData(AuditDbContext db) : IPersonalDataContributor
{
    public string Module => AuditDbContext.SchemaName;

    public async Task<PersonalDataSection> ExportAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        var items = new List<PersonalDataItem>();
        foreach (var record in new[] { subject.Record }.Concat(subject.RelatedRecords))
        {
            var entries = await db.AuditEntries.AsNoTracking()
                .Where(e => e.Module == record.Module && e.EntityType == record.EntityType && e.EntityId == record.EntityId)
                .OrderBy(e => e.Id)
                .Select(e => new { e.At, e.Action, e.EntityType, e.Changes })
                .ToListAsync(cancellationToken);
            items.AddRange(entries.Select(e => new PersonalDataItem("history", record.EntityId, new Dictionary<string, string?>
            {
                ["at"] = e.At.ToString("O", CultureInfo.InvariantCulture),
                ["record"] = e.EntityType,
                ["action"] = e.Action,
                ["changes"] = e.Changes,
            })));
        }

        return new PersonalDataSection(Module, items,
        [
            "Who made each change is left out: that is information about the company's employees.",
            "The history of other records (activities, quotes, tickets) is represented by their current state in the other sections.",
        ]);
    }

    public Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<PlannedErasure>>([]);

    public Task<IReadOnlyList<ErasedRecord>> EraseAsync(
        DataSubject subject, IReadOnlyList<PlannedErasure> plan, string reference, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<ErasedRecord>>([]);

    public Task<int> ReapplyAsync(IReadOnlyList<ErasedRecord> records, string reference, CancellationToken cancellationToken) => Task.FromResult(0);
}
