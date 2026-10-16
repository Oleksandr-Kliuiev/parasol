using System.Globalization;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Privacy.Contracts;
using Microsoft.EntityFrameworkCore;

namespace Crm.Activities.Features.Privacy;

/// <summary>
/// The activities module's part in subject requests (DEV-11): calls, meetings, notes and tasks with the person, and e-mails
/// saved from them. They are removed with the person (SEC-GDPR-04); the work they record is not financial evidence — time
/// and billing keep their own records.
/// </summary>
internal sealed class ActivitiesPersonalData(ActivitiesDbContext db) : IPersonalDataContributor
{
    public const string Class = "activities.activity";

    public string Module => ActivitiesDbContext.SchemaName;

    public async Task<PersonalDataSection> ExportAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        var activities = await Of(subject).AsNoTracking().OrderBy(a => a.CreatedAt).ToListAsync(cancellationToken);
        return new PersonalDataSection(Module, activities.Select(a => new PersonalDataItem("activity", a.Id, new Dictionary<string, string?>
        {
            ["type"] = a.Type.ToString(),
            ["subject"] = a.Subject,
            ["body"] = a.Body,
            ["location"] = a.Location,
            ["dueAt"] = a.DueAt is { } due ? due.ToString("O", CultureInfo.InvariantCulture) : null,
            ["fromAddress"] = a.FromAddress,
            ["link"] = a.WebLink,
            ["status"] = a.Status.ToString(),
            ["createdAt"] = a.CreatedAt.ToString("O", CultureInfo.InvariantCulture),
        })).ToList(),
        [
            "Meeting invitations in Outlook and saved e-mails' bodies stay in Microsoft 365 (SEC-GDPR-06b).",
        ]);
    }

    public async Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken cancellationToken) =>
        (await Of(subject).AsNoTracking().Select(a => a.Id).ToListAsync(cancellationToken))
            .Select(id => new PlannedErasure(new RecordRef(Module, nameof(Activity), id), ErasureAction.Delete, Class))
            .ToList();

    public async Task<IReadOnlyList<ErasedRecord>> EraseAsync(
        DataSubject subject, IReadOnlyList<PlannedErasure> plan, string reference, CancellationToken cancellationToken)
    {
        var ids = plan.Where(p => p.Action != ErasureAction.Retain).Select(p => p.Record.EntityId).ToList();
        foreach (var activity in await db.Activities.IgnoreQueryFilters().Where(a => ids.Contains(a.Id)).ToListAsync(cancellationToken))
        {
            activity.Erase(reference);
        }

        await db.SaveChangesAsync(cancellationToken);
        return plan.Where(p => p.Action != ErasureAction.Retain).Select(p => new ErasedRecord(p.Record, p.Action, p.DataClass)).ToList();
    }

    public async Task<int> ReapplyAsync(IReadOnlyList<ErasedRecord> records, string reference, CancellationToken cancellationToken)
    {
        var ids = records.Select(r => r.Record.EntityId).ToList();
        var applied = 0;
        foreach (var activity in await db.Activities.IgnoreQueryFilters().Where(a => ids.Contains(a.Id)).ToListAsync(cancellationToken))
        {
            applied += activity.Erase(reference) ? 1 : 0;
        }

        await db.SaveChangesAsync(cancellationToken);
        return applied;
    }

    /// <summary>
    /// With the person: their contact record, or an e-mail saved from one of their addresses — deleted ones included, since a
    /// deleted activity keeps its text; an erased one points at nobody and is not found again.
    /// </summary>
    private IQueryable<Activity> Of(DataSubject subject)
    {
        var emails = subject.Emails.Select(e => e.Trim().ToLowerInvariant()).ToList();
        var activities = db.Activities.IgnoreQueryFilters();
        return subject.Kind == DataSubjectKind.Contact
            ? activities.Where(a => a.ContactId == subject.Id || (a.FromAddress != null && emails.Contains(a.FromAddress)))
            : activities.Where(a => a.FromAddress != null && emails.Contains(a.FromAddress));
    }
}
