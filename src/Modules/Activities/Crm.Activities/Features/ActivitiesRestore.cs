using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Activities.Features;

/// <summary>
/// Activities' part in a restore (DEV-13): a meeting the journal shows pushed to Outlook after the restore point is linked to its
/// event again, so the next change updates that event instead of putting the meeting into the calendar twice. A meeting the
/// copy lost leaves its event in Outlook, which the report names.
/// </summary>
internal sealed class ActivitiesRestoreParticipant(ActivitiesDbContext db, TimeProvider time) : IRestoreParticipant
{
    public string Area => "activities";

    public Task<int> InFlightAsync(CancellationToken cancellationToken) => Task.FromResult(0);

    public Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<RestoreLine>>([]);

    public async Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken)
    {
        var lines = new List<RestoreLine>();
        foreach (var meeting in effects.Where(e => e.Kind == OutlookService.CalendarEffect && e.EntityType == nameof(Activity)).GroupBy(e => e.EntityId))
        {
            if (ExternalEffects.LatestReference(meeting) is not { } eventId)
            {
                continue;
            }

            var activity = await db.Activities.SingleOrDefaultAsync(a => a.Id == meeting.Key, cancellationToken);
            if (activity is null)
            {
                lines.Add(new RestoreLine(Area, $"activity {meeting.Key}", "A meeting the restored copy does not have is in the organizer's Outlook calendar.",
                    "The organizer keeps or deletes the event in Outlook and recreates the meeting in the CRM if it still holds.", true));
                continue;
            }

            if (activity.GraphEventId == eventId)
            {
                continue;
            }

            if (apply)
            {
                activity.LinkCalendarEvent(eventId, null, time.GetUtcNow());
            }

            lines.Add(new RestoreLine(Area, $"activity {meeting.Key}", "The meeting went to Outlook after the restore point; the restored copy lost the link.",
                apply ? "Linked to its event again: the next change updates it." : "Would be linked to its event again.", false));
        }

        if (apply)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        return lines;
    }
}
