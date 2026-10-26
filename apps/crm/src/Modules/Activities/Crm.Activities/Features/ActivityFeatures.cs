using System.Globalization;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Activities.Features;

public sealed record RefDto(Guid Id, string Name);

public sealed record ActivityRequest(
    ActivityType Type,
    Guid OrganizationId,
    Guid? OpportunityId,
    Guid? ContractId,
    Guid? ContactId,
    string Subject,
    string? Body,
    DateTimeOffset? DueAt,
    ActivityPriority Priority,
    Guid? AssigneeId,
    int? DurationMinutes = null,
    string? Location = null,
    bool AddToCalendar = false);

internal sealed class ActivityRequestValidator : AbstractValidator<ActivityRequest>
{
    public ActivityRequestValidator()
    {
        RuleFor(x => x.Type).IsInEnum();
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.Subject).NotEmpty().MaximumLength(256);
        RuleFor(x => x.Body).MaximumLength(8000);
        RuleFor(x => x.Priority).IsInEnum();
        RuleFor(x => x.DueAt).NotNull().When(x => x.Type == ActivityType.Meeting).WithMessage("A meeting needs a date and time.");
        RuleFor(x => x.DurationMinutes).InclusiveBetween(5, 24 * 60).When(x => x.DurationMinutes is not null);
        RuleFor(x => x.Location).MaximumLength(256);
        RuleFor(x => x.Type).Must(t => t != ActivityType.Email).WithMessage("E-mails are saved from the mail list, not created by hand.");
    }
}

public sealed record ActivityDto(
    Guid Id,
    ActivityType Type,
    Guid OrganizationId,
    string? OrganizationName,
    Guid? OpportunityId,
    Guid? ContractId,
    Guid? ContactId,
    string? ContactName,
    string Subject,
    string? Body,
    DateTimeOffset? DueAt,
    int? DurationMinutes,
    string? Location,
    ActivityPriority Priority,
    RefDto? Assignee,
    ActivityStatus Status,
    DateTimeOffset? CompletedAt,
    bool IsOverdue,
    bool InCalendar,
    DateTimeOffset? CalendarSyncedAt,
    string? WebLink,
    string? FromAddress,
    DateTimeOffset CreatedAt,
    RefDto? CreatedBy,
    string Etag,
    bool HasTechnicalSource = false);

public sealed record ActivityQuery(
    Guid? OrganizationId, Guid? OpportunityId, Guid? ContractId, ActivityType? Type, bool MineOnly, bool OpenOnly,
    int? Limit = null, string? Cursor = null, Guid? ActivityId = null);

internal sealed class ActivityService(
    ActivitiesDbContext db,
    ICustomersApi customers,
    IUserDirectory users,
    ICurrentUser currentUser,
    OutlookService outlook,
    TimeProvider time)
{
    /// <summary>
    /// One page of the timeline — open items first by due date, then everything newest first — and how many the filter matches
    /// (DEV-12). The cursor carries the whole sort key, so a page continues exactly where the previous one ended.
    /// </summary>
    public async Task<Result<PagedResult<ActivityDto>>> ListAsync(ActivityQuery query, CancellationToken ct)
    {
        // A selected activity stays inside its live customer. A stale link must never fall back to the whole timeline.
        if (query.ActivityId is { } selectedId)
        {
            if (selectedId == Guid.Empty || query.OrganizationId is null || query.OrganizationId == Guid.Empty)
                return Error.Validation("ACT_SELECTION_SCOPE_REQUIRED", "Select an activity within its customer.");
            if (query.Cursor is not null)
                return Error.Validation("ACT_SELECTION_CURSOR_INVALID", "A selected activity cannot use a continuation cursor.");
            if (await customers.GetOrganizationAsync(query.OrganizationId.Value, ct) is null)
                return new PagedResult<ActivityDto>([], null, 0);
        }

        // Tracked: rows carry their ETag so the timeline can edit an item straight away.
        var activities = db.Activities.AsQueryable();
        if (query.ActivityId is { } activityId)
        {
            activities = activities.Where(a => a.Id == activityId);
        }
        if (query.OrganizationId is { } organizationId)
        {
            activities = activities.Where(a => a.OrganizationId == organizationId);
        }

        if (query.OpportunityId is { } opportunityId)
        {
            activities = activities.Where(a => a.OpportunityId == opportunityId);
        }

        if (query.ContractId is { } contractId)
        {
            activities = activities.Where(a => a.ContractId == contractId);
        }

        if (query.Type is { } type)
        {
            activities = activities.Where(a => a.Type == type);
        }

        if (query.MineOnly)
        {
            var userId = currentUser.UserId;
            activities = activities.Where(a => a.AssigneeId == userId);
        }

        if (query.OpenOnly)
        {
            activities = activities.Where(a => a.Status == ActivityStatus.Open);
        }

        if (query.ActivityId is not null)
        {
            // Exact selection has no continuation or page walk. Its count describes only the returned row.
            var selectedActivity = await activities.SingleOrDefaultAsync(ct);
            if (selectedActivity is null) return new PagedResult<ActivityDto>([], null, 0);
            var selectedRows = await ToDtosAsync([selectedActivity], ct);
            if (await customers.GetOrganizationAsync(query.OrganizationId!.Value, ct) is null)
                return new PagedResult<ActivityDto>([], null, 0);
            return new PagedResult<ActivityDto>(selectedRows, null, selectedRows.Count);
        }

        var total = await activities.CountAsync(ct);
        if (KeysetCursor.Decode(query.Cursor) is { Then: { } then } after && then.Split('|') is [var dueText, var createdText] &&
            DateTimeOffset.TryParseExact(createdText, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var created))
        {
            var rank = after.SortKey == "0" ? 0 : 1;
            var open = ActivityStatus.Open;
            if (dueText.Length == 0)
            {
                // The cursor's row has no due date (sorted first in its rank): later come rows with one, then older rows without.
                activities = activities.Where(a => (a.Status == open ? 0 : 1) > rank ||
                    ((a.Status == open ? 0 : 1) == rank &&
                     ((a.Status == open ? a.DueAt : null) != null ||
                      a.CreatedAt < created || (a.CreatedAt == created && a.Id.CompareTo(after.Id) < 0))));
            }
            else if (DateTimeOffset.TryParseExact(dueText, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var due))
            {
                activities = activities.Where(a => (a.Status == open ? 0 : 1) > rank ||
                    ((a.Status == open ? 0 : 1) == rank &&
                     ((a.Status == open ? a.DueAt : null) > due ||
                      ((a.Status == open ? a.DueAt : null) == due && (a.CreatedAt < created || (a.CreatedAt == created && a.Id.CompareTo(after.Id) < 0))))));
            }
        }

        var limit = KeysetCursor.ClampLimit(query.Limit);
        var page = await activities
            .OrderBy(a => a.Status == ActivityStatus.Open ? 0 : 1)
            .ThenBy(a => a.Status == ActivityStatus.Open ? a.DueAt : null)
            .ThenByDescending(a => a.CreatedAt)
            .ThenByDescending(a => a.Id)
            .Take(limit + 1)
            .ToListAsync(ct);
        var rows = page.Take(limit).ToList();
        var last = rows.LastOrDefault();
        string? next = null;
        if (page.Count > limit && last is not null)
        {
            var isOpen = last.Status == ActivityStatus.Open;
            var due = isOpen && last.DueAt is { } d ? d.ToString("O", CultureInfo.InvariantCulture) : string.Empty;
            next = new KeysetCursor(isOpen ? "0" : "1", last.Id, $"{due}|{last.CreatedAt.ToString("O", CultureInfo.InvariantCulture)}").Encode();
        }

        return new PagedResult<ActivityDto>(await ToDtosAsync(rows, ct), next, total);
    }

    public async Task<Result<ActivityDto>> CreateAsync(ActivityRequest request, CancellationToken ct)
    {
        if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
        {
            return Error.Validation("ACT_UNKNOWN_ORGANIZATION", "The organization does not exist.");
        }

        var created = Activity.Create(ToDetails(request, currentUser.UserId), time.GetUtcNow());
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        // The event is created before the activity is stored, so a refused calendar leaves nothing half-done.
        if (request.AddToCalendar && created.Value.Type == ActivityType.Meeting
            && await outlook.PushMeetingAsync(created.Value, ct) is { IsSuccess: false } pushed)
        {
            return pushed.Error!;
        }

        db.Activities.Add(created.Value);
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([created.Value], ct))[0];
    }

    public async Task<Result<ActivityDto>> UpdateAsync(Guid id, ActivityRequest request, string ifMatch, CancellationToken ct)
    {
        if (await db.SourceTaskLinks.AsNoTracking().AnyAsync(l => l.ActivityId == id, ct)
            && await db.Activities.AsNoTracking().SingleOrDefaultAsync(a => a.Id == id, ct) is { } sourceTask)
        {
            if (request.Type != ActivityType.Task || request.OrganizationId != sourceTask.OrganizationId)
                return Error.Conflict("ACT_SOURCE_TASK_IDENTITY_LOCKED", "A task made from an alert keeps its type and customer.");
            var assigneeId = request.AssigneeId ?? sourceTask.AssigneeId;
            if (assigneeId != sourceTask.AssigneeId && (assigneeId is null
                || await users.GetProfileAsync(assigneeId.Value, ct) is not { } assignee || !SourceTaskApi.IsEligibleAssignee(assignee)))
                return Error.Validation("ACT_SOURCE_TASK_ASSIGNEE_INVALID", "Choose an active employee who works on tasks and service data.");
        }
        return await MutateAsync(
            id,
            ifMatch,
            activity => activity.Update(ToDetails(request, activity.AssigneeId), time.GetUtcNow()),
            ct,
            async (activity, token) =>
            {
                // A meeting that is in Outlook follows every edit; unticking the box takes it out again.
                if (activity.Type != ActivityType.Meeting)
                {
                    return Result.Success();
                }

                if (!request.AddToCalendar && activity.GraphEventId is not null)
                {
                    await outlook.RemoveMeetingAsync(activity, token);
                    return Result.Success();
                }

                return request.AddToCalendar || activity.GraphEventId is not null
                    ? await outlook.PushMeetingAsync(activity, token)
                    : Result.Success();
            });
    }

    /// <summary>Puts an existing meeting into the calendar, or refreshes the event after a failed attempt.</summary>
    public async Task<Result<ActivityDto>> AddToCalendarAsync(Guid id, CancellationToken ct) =>
        await MutateAsync(id, null, _ => Result.Success(), ct, (activity, token) => outlook.PushMeetingAsync(activity, token));

    public async Task<Result<ActivityDto>> RemoveFromCalendarAsync(Guid id, CancellationToken ct) =>
        await MutateAsync(id, null, _ => Result.Success(), ct, async (activity, token) =>
        {
            await outlook.RemoveMeetingAsync(activity, token);
            return Result.Success();
        });

    public async Task<Result<ActivityDto>> CompleteAsync(Guid id, string ifMatch, CancellationToken ct) =>
        await MutateAsync(id, ifMatch, activity => activity.Complete(currentUser.UserId, time.GetUtcNow()), ct);

    public async Task<Result<ActivityDto>> ReopenAsync(Guid id, string ifMatch, CancellationToken ct) =>
        await MutateAsync(id, ifMatch, activity => activity.Reopen(), ct);

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct)
    {
        if (await db.Activities.SingleOrDefaultAsync(a => a.Id == id, ct) is not { } activity)
        {
            return Error.NotFound("ACT_NOT_FOUND", $"Activity {id} was not found.");
        }

        // A deleted meeting should not stay in the organizer's calendar either.
        await outlook.RemoveMeetingAsync(activity, ct);
        activity.MarkDeleted();
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    private async Task<Result<ActivityDto>> MutateAsync(
        Guid id,
        string? ifMatch,
        Func<Activity, Result> change,
        CancellationToken ct,
        Func<Activity, CancellationToken, Task<Result>>? afterChange = null)
    {
        if (await db.Activities.SingleOrDefaultAsync(a => a.Id == id, ct) is not { } activity)
        {
            return Error.NotFound("ACT_NOT_FOUND", $"Activity {id} was not found.");
        }

        if (ifMatch is not null && !db.ApplyIfMatch(activity, ifMatch))
        {
            return Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
        }

        // Reject before a no-op or an external effect. Actual changes still use SQL rowversion at SaveChanges.
        if (ifMatch is not null && db.IsStale(activity))
        {
            return Error.PreconditionFailed("CONCURRENCY_CONFLICT",
                "The record was changed by someone else. Reload it and apply your changes again.");
        }

        var result = change(activity);
        if (!result.IsSuccess)
        {
            return result.Error!;
        }

        if (afterChange is not null && await afterChange(activity, ct) is { IsSuccess: false } outcome)
        {
            return outcome.Error!;
        }

        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([activity], ct))[0];
    }

    private static ActivityDetails ToDetails(ActivityRequest r, Guid? fallbackAssignee) => new(
        r.Type, r.OrganizationId, r.OpportunityId, r.ContractId, r.ContactId, r.Subject, r.Body, r.DueAt, r.Priority,
        r.AssigneeId ?? (r.Type is ActivityType.Task or ActivityType.Meeting ? fallbackAssignee : null), r.DurationMinutes, r.Location);

    private async Task<IReadOnlyList<ActivityDto>> ToDtosAsync(IReadOnlyList<Activity> activities, CancellationToken ct)
    {
        var organizations = await customers.GetOrganizationNamesAsync(activities.Select(a => a.OrganizationId).Distinct().ToList(), ct);
        var contacts = await customers.GetContactNamesAsync(activities.Where(a => a.ContactId != null).Select(a => a.ContactId!.Value).Distinct().ToList(), ct);
        var userIds = activities.SelectMany(a => new[] { a.AssigneeId, a.CreatedBy }).OfType<Guid>().Distinct().ToList();
        var people = await users.GetUsersAsync(userIds, ct);
        var activityIds = activities.Select(a => a.Id).ToList();
        // A receipt of a system the CRM no longer reads keeps its task's type and customer but offers no source to open.
        var supported = SourceTaskIdentityRules.SupportedSystems.ToList();
        var sourceIds = (await db.SourceTaskLinks.AsNoTracking().Where(l => activityIds.Contains(l.ActivityId) && supported.Contains(l.System))
            .Select(l => l.ActivityId).ToListAsync(ct)).ToHashSet();
        var now = time.GetUtcNow();
        RefDto? Person(Guid? id) => id is { } value && people.TryGetValue(value, out var user) ? new RefDto(user.Id, user.DisplayName) : null;

        return activities.Select(a => new ActivityDto(
            a.Id, a.Type, a.OrganizationId, organizations.GetValueOrDefault(a.OrganizationId), a.OpportunityId, a.ContractId, a.ContactId,
            a.ContactId is { } contactId ? contacts.GetValueOrDefault(contactId) : null, a.Subject, a.Body, a.DueAt, a.DurationMinutes,
            a.Location, a.Priority, Person(a.AssigneeId), a.Status, a.CompletedAt, a.IsOverdue(now), a.GraphEventId is not null,
            a.CalendarSyncedAt, a.WebLink, a.FromAddress, a.CreatedAt, Person(a.CreatedBy), db.GetETag(a), sourceIds.Contains(a.Id))).ToList();
    }
}

/// <summary>Activities follow their organization into a merge.</summary>
internal sealed class ActivitiesMergeHandler(ActivitiesDbContext db, ICustomersApi customers) : IDomainEventHandler<OrganizationsMerged>
{
    public async Task HandleAsync(OrganizationsMerged domainEvent, CancellationToken cancellationToken)
    {
        // Delivered late (retried or replayed) after the merge was undone: the organizations are apart again (DEV-07).
        if (await customers.IsMergeUndoneAsync(domainEvent.MergeId, cancellationToken))
        {
            return;
        }

        await db.Activities.Where(a => a.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(a => a.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
    }
}
