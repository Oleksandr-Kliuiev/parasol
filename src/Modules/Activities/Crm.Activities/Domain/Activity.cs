using Crm.Activities.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Activities.Domain;

public sealed record ActivityDetails(
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
    string? Location = null);

/// <summary>A message from Outlook saved against a customer: metadata and a link, never the body (SEC-GDPR-06).</summary>
public sealed record SavedMailDetails(
    Guid OrganizationId,
    Guid? OpportunityId,
    Guid? ContractId,
    Guid? ContactId,
    string Subject,
    string? Preview,
    string FromAddress,
    string? FromName,
    DateTimeOffset ReceivedAt,
    string MessageId,
    string? WebLink);

/// <summary>
/// A task, call, meeting, note or saved e-mail about a customer (FR-ACT-01). A meeting can live in the organizer's Outlook
/// calendar as well (FR-ACT-02), and a saved message keeps only metadata and a link (FR-ACT-03).
/// </summary>
public sealed class Activity : AuditableEntity
{
    private Activity() { }

    public ActivityType Type { get; private set; }
    public Guid OrganizationId { get; private set; }
    public Guid? OpportunityId { get; private set; }
    public Guid? ContractId { get; private set; }
    public Guid? ContactId { get; private set; }
    public string Subject { get; private set; } = string.Empty;
    public string? Body { get; private set; }

    /// <summary>When a task is due or a meeting starts.</summary>
    public DateTimeOffset? DueAt { get; private set; }

    /// <summary>How long a meeting lasts; the Outlook event gets the same length (FR-ACT-02).</summary>
    public int? DurationMinutes { get; private set; }

    public string? Location { get; private set; }

    public ActivityPriority Priority { get; private set; }
    public Guid? AssigneeId { get; private set; }

    /// <summary>Id of the event in the organizer's Outlook calendar, once the meeting was pushed there.</summary>
    public string? GraphEventId { get; private set; }

    public DateTimeOffset? CalendarSyncedAt { get; private set; }

    /// <summary>Link to the event or the message in Outlook on the web.</summary>
    public string? WebLink { get; private set; }

    /// <summary>Internet message id of a saved e-mail; it keeps the same message from being saved twice.</summary>
    public string? ExternalMessageId { get; private set; }

    public string? FromAddress { get; private set; }
    public ActivityStatus Status { get; private set; }
    public DateTimeOffset? CompletedAt { get; private set; }
    public Guid? CompletedBy { get; private set; }

    public static Result<Activity> Create(ActivityDetails details, DateTimeOffset now)
    {
        var activity = new Activity();
        var applied = activity.Apply(details);
        if (!applied.IsSuccess)
        {
            return applied.Error!;
        }

        // Notes and logged calls are done the moment they are written; tasks and meetings stay open.
        activity.Status = details.Type is ActivityType.Note or ActivityType.Call ? ActivityStatus.Done : ActivityStatus.Open;
        activity.CompletedAt = activity.Status == ActivityStatus.Done ? now : null;
        activity.Raise(new ActivityLogged(activity.Id, activity.OrganizationId, activity.OpportunityId, activity.ContractId, now));
        return activity;
    }

    public Result Update(ActivityDetails details, DateTimeOffset now)
    {
        if (Status == ActivityStatus.Cancelled)
        {
            return Error.Conflict("ACT_CANCELLED", "The activity is cancelled.");
        }

        if (Type == ActivityType.Email)
        {
            return Error.Conflict("ACT_MAIL_READONLY", "A saved e-mail is a record of what was sent; it cannot be edited.");
        }

        var applied = Apply(details);
        if (applied.IsSuccess)
        {
            Raise(new ActivityLogged(Id, OrganizationId, OpportunityId, ContractId, now));
        }

        return applied;
    }

    public Result Complete(Guid? userId, DateTimeOffset at)
    {
        if (Status == ActivityStatus.Cancelled)
        {
            return Error.Conflict("ACT_CANCELLED", "The activity is cancelled.");
        }

        Status = ActivityStatus.Done;
        CompletedAt = at;
        CompletedBy = userId;
        Raise(new ActivityLogged(Id, OrganizationId, OpportunityId, ContractId, at));
        return Result.Success();
    }

    /// <summary>FR-ACT-03: an Outlook message becomes a read-only activity; the body stays in Exchange.</summary>
    public static Activity FromMail(SavedMailDetails mail, Guid? savedBy, DateTimeOffset now)
    {
        var activity = new Activity
        {
            Type = ActivityType.Email,
            OrganizationId = mail.OrganizationId,
            OpportunityId = mail.OpportunityId,
            ContractId = mail.ContractId,
            ContactId = mail.ContactId,
            Subject = mail.Subject.Trim(),
            Body = string.IsNullOrWhiteSpace(mail.Preview) ? null : mail.Preview.Trim(),
            DueAt = null,
            Priority = ActivityPriority.Normal,
            AssigneeId = savedBy,
            Status = ActivityStatus.Done,
            CompletedAt = mail.ReceivedAt,
            ExternalMessageId = mail.MessageId,
            FromAddress = mail.FromAddress,
            WebLink = mail.WebLink,
        };
        activity.Raise(new ActivityLogged(activity.Id, activity.OrganizationId, activity.OpportunityId, activity.ContractId, now));
        return activity;
    }

    /// <summary>Remembers the Outlook event a meeting was pushed to.</summary>
    public void LinkCalendarEvent(string eventId, string? webLink, DateTimeOffset at)
    {
        GraphEventId = eventId;
        WebLink = webLink;
        CalendarSyncedAt = at;
    }

    public void ForgetCalendarEvent()
    {
        GraphEventId = null;
        CalendarSyncedAt = null;
        WebLink = null;
    }

    /// <summary>
    /// Applies what Outlook says about the event (FR-ACT-02): a moved or renamed meeting follows into the CRM, and a
    /// meeting cancelled in Outlook is cancelled here. Returns whether anything changed.
    /// </summary>
    public bool ApplyCalendarChange(string subject, DateTimeOffset startsAt, DateTimeOffset endsAt, bool isCancelled, DateTimeOffset at)
    {
        var changed = false;
        if (isCancelled && Status != ActivityStatus.Cancelled)
        {
            Status = ActivityStatus.Cancelled;
            CompletedAt = null;
            changed = true;
        }

        if (!isCancelled)
        {
            if (!string.IsNullOrWhiteSpace(subject) && subject != Subject)
            {
                Subject = subject.Trim();
                changed = true;
            }

            if (startsAt != default && startsAt != DueAt)
            {
                DueAt = startsAt;
                changed = true;
            }

            var minutes = (int)Math.Round((endsAt - startsAt).TotalMinutes);
            if (endsAt > startsAt && minutes != DurationMinutes)
            {
                DurationMinutes = minutes;
                changed = true;
            }
        }

        CalendarSyncedAt = at;
        return changed;
    }

    public Result Reopen()
    {
        if (Type is ActivityType.Note)
        {
            return Error.Conflict("ACT_NOTE", "A note cannot be reopened.");
        }

        Status = ActivityStatus.Open;
        CompletedAt = null;
        CompletedBy = null;
        return Result.Success();
    }

    public void Cancel()
    {
        Status = ActivityStatus.Cancelled;
        CompletedAt = null;
    }

    public void MoveToOrganization(Guid targetOrganizationId) => OrganizationId = targetOrganizationId;

    public bool IsOverdue(DateTimeOffset now) => Status == ActivityStatus.Open && DueAt is { } due && due < now;

    private Result Apply(ActivityDetails d)
    {
        if (string.IsNullOrWhiteSpace(d.Subject))
        {
            return Error.Validation("ACT_SUBJECT_REQUIRED", "The activity needs a subject.");
        }

        if (d.OrganizationId == Guid.Empty)
        {
            return Error.Validation("ACT_ORGANIZATION_REQUIRED", "Choose the customer the activity belongs to.");
        }

        Type = d.Type;
        OrganizationId = d.OrganizationId;
        OpportunityId = d.OpportunityId;
        ContractId = d.ContractId;
        ContactId = d.ContactId;
        Subject = d.Subject.Trim();
        Body = string.IsNullOrWhiteSpace(d.Body) ? null : d.Body.Trim();
        DueAt = d.Type is ActivityType.Task or ActivityType.Meeting ? d.DueAt : null;
        DurationMinutes = d.Type == ActivityType.Meeting ? Math.Clamp(d.DurationMinutes ?? 60, 5, 24 * 60) : null;
        Location = d.Type == ActivityType.Meeting && !string.IsNullOrWhiteSpace(d.Location) ? d.Location.Trim() : null;
        Priority = d.Priority;
        AssigneeId = d.AssigneeId;
        return Result.Success();
    }
}
