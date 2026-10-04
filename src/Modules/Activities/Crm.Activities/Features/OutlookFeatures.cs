using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Operations;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Activities.Features;

/// <summary>What the signed-in user's Outlook can do right now; the interface explains itself instead of failing.</summary>
public sealed record OutlookStatusDto(bool Calendar, bool Mail);

public sealed record MailMessageDto(
    string Id,
    string MessageId,
    string Subject,
    string? Preview,
    string FromAddress,
    string? FromName,
    IReadOnlyList<string> ToAddresses,
    DateTimeOffset ReceivedAt,
    bool HasAttachments,
    string? WebLink,
    string Mailbox,
    bool IsSaved);

/// <summary>
/// The messages, and what was searched for them (DEV-12): the customer's domains first — one search covers every address there —
/// then addresses outside those domains, up to <see cref="OutlookService.MaxMailTerms"/>. <c>NotSearched</c> counts the rest.
/// </summary>
public sealed record MailListResponse(IReadOnlyList<MailMessageDto> Messages, IReadOnlyList<string> Searched, int NotSearched);

public sealed record SaveMailRequest(
    Guid OrganizationId,
    Guid? OpportunityId,
    Guid? ContractId,
    Guid? ContactId,
    string MessageId,
    string Subject,
    string? Preview,
    string FromAddress,
    string? FromName,
    DateTimeOffset ReceivedAt,
    string? WebLink);

public sealed record CalendarSyncResult(int Read, int Updated);

internal sealed class SaveMailRequestValidator : AbstractValidator<SaveMailRequest>
{
    public SaveMailRequestValidator()
    {
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.MessageId).NotEmpty().MaximumLength(512);
        RuleFor(x => x.Subject).NotEmpty().MaximumLength(256);
        RuleFor(x => x.Preview).MaximumLength(8000);
        RuleFor(x => x.FromAddress).NotEmpty().MaximumLength(256);
        RuleFor(x => x.WebLink).MaximumLength(1024);
    }
}

internal static class OutlookErrors
{
    public static Error NotRecorded => Error.Conflict(
        "ACT_CALENDAR_NOT_RECORDED",
        "The meeting could not be recorded in the external effect journal, so it was not put into Outlook. Try again in a moment.");

    public static Error CalendarUnavailable => Error.Conflict(
        "ACT_CALENDAR_UNAVAILABLE",
        "Outlook calendar is not connected for this session (Microsoft Graph or the calendar feature is off, or you signed in with the development sign-in).");

    public static Error MailUnavailable => Error.Conflict(
        "ACT_MAIL_UNAVAILABLE",
        "Outlook mail is not connected for this session (Microsoft Graph or the mail feature is off, or you signed in with the development sign-in).");

    public static Error NotConnected => Error.Conflict(
        "ACT_GRAPH_NOT_CONNECTED", "Your session has no Microsoft Graph token; sign out and in again to grant access.");
}

/// <summary>
/// The Outlook half of activities: meetings in the organizer's calendar (FR-ACT-02) and the customer's correspondence
/// read live from the mailbox (FR-ACT-03). Nothing from Exchange is stored unless somebody saves a message.
/// </summary>
internal sealed class OutlookService(
    ActivitiesDbContext db,
    IUserCalendar calendar,
    IUserMailbox mailbox,
    ICustomersApi customers,
    IUserDirectory users,
    ICurrentUser currentUser,
    TimeProvider time,
    IExternalEffectJournal journal,
    IMaintenanceGate maintenance,
    ILogger<OutlookService> logger)
{
    /// <summary>Journal kind of a meeting pushed to Outlook; the record is the activity, the reference the event id (DEV-13).</summary>
    public const string CalendarEffect = "calendar-event";

    /// <summary>Search terms one mail view sends to Exchange (each is one request per mailbox).</summary>
    public const int MaxMailTerms = 6;

    public OutlookStatusDto Status => new(calendar.IsAvailable, mailbox.IsAvailable);

    /// <summary>Pushes a meeting to the organizer's calendar, or updates the event that is already there.</summary>
    public async Task<Result> PushMeetingAsync(Activity activity, CancellationToken ct)
    {
        if (activity.Type != ActivityType.Meeting)
        {
            return Error.Validation("ACT_NOT_A_MEETING", "Only meetings go into the calendar.");
        }

        if (!calendar.IsAvailable)
        {
            return OutlookErrors.CalendarUnavailable;
        }

        var draft = await DraftAsync(activity, ct);
        ExternalEffectEntry effect;
        string? eventId;
        try
        {
            // DEV-13: a database restored to before the push forgets the event; the journal outside it still names the event,
            // so the meeting is updated there instead of being put into the calendar a second time.
            eventId = activity.GraphEventId ?? ExternalEffects.LatestReference(
                (await journal.ForEntityAsync(nameof(Activity), activity.Id, ct)).Where(e => e.Kind == CalendarEffect));
            effect = await journal.BeginAsync(new ExternalEffect("graph", CalendarEffect, nameof(Activity), activity.Id), ct);
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or MaintenanceReadOnlyException or MaintenanceStateUnavailableException))
        {
            logger.LogWarning("The meeting {Activity} is not pushed: the external effect journal is unavailable ({Error}).", activity.Id, ex.GetType().Name);
            return OutlookErrors.NotRecorded;
        }

        try
        {
            CalendarEventState state;
            try
            {
                state = eventId is not null
                    ? await calendar.UpdateAsync(eventId, draft, ct)
                    : await calendar.CreateAsync(draft, ct);
            }
            catch (HttpRequestException gone) when (activity.GraphEventId is null && gone.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Gone)
            {
                // The journaled event was deleted in Outlook meanwhile: the meeting goes in as a new event.
                state = await calendar.CreateAsync(draft, ct);
            }

            await journal.CompleteAsync(effect, EffectPhase.Sent, state.EventId, ct);
            activity.LinkCalendarEvent(state.EventId, state.WebLink, time.GetUtcNow());
            return Result.Success();
        }
        catch (UserNotConnectedException)
        {
            await journal.CompleteAsync(effect, EffectPhase.Failed, null, ct);
            return OutlookErrors.NotConnected;
        }
    }

    /// <summary>Removes the event from Outlook; the meeting itself stays in the CRM.</summary>
    public async Task RemoveMeetingAsync(Activity activity, CancellationToken ct)
    {
        if (activity.GraphEventId is not { } eventId)
        {
            return;
        }

        try
        {
            if (calendar.IsAvailable)
            {
                // DEV-13: taking the event out of the calendar is an external effect as well — none once maintenance began.
                await maintenance.EnsureMaySendAsync(ct);
                await calendar.CancelAsync(eventId, ct);
            }
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning(exception, "Cancelling the Outlook event of activity {Activity} failed.", activity.Id);
        }

        activity.ForgetCalendarEvent();
    }

    /// <summary>
    /// Reads the user's calendar for a window and applies what changed in Outlook to their meetings (FR-ACT-02). The CRM
    /// pulls instead of subscribing: change notifications need a public endpoint and renewals, which is R3 work.
    /// </summary>
    public async Task<Result<CalendarSyncResult>> PullCalendarAsync(int days, CancellationToken ct)
    {
        if (!calendar.IsAvailable)
        {
            return OutlookErrors.CalendarUnavailable;
        }

        var now = time.GetUtcNow();
        var from = now.AddDays(-Math.Clamp(days, 1, 90));
        var to = now.AddDays(Math.Clamp(days, 1, 90));
        var events = await calendar.ReadWindowAsync(from, to, ct);
        var byEventId = events.Where(e => e.ActivityId is not null).ToDictionary(e => e.ActivityId!.Value);
        if (byEventId.Count == 0)
        {
            return new CalendarSyncResult(events.Count, 0);
        }

        var ids = byEventId.Keys.ToList();
        var activities = await db.Activities.Where(a => ids.Contains(a.Id) && a.GraphEventId != null).ToListAsync(ct);
        var updated = 0;
        foreach (var activity in activities)
        {
            var state = byEventId[activity.Id];
            if (activity.ApplyCalendarChange(state.Subject, state.StartsAt, state.EndsAt, state.IsCancelled, now))
            {
                updated++;
            }
        }

        if (updated > 0)
        {
            await db.SaveChangesAsync(ct);
        }

        return new CalendarSyncResult(events.Count, updated);
    }

    /// <summary>Messages exchanged with the customer's contacts and e-mail domains, newest first (FR-ACT-03).</summary>
    public async Task<Result<MailListResponse>> ListMailAsync(Guid organizationId, int take, CancellationToken ct)
    {
        if (!mailbox.IsAvailable)
        {
            return OutlookErrors.MailUnavailable;
        }

        if (await customers.GetOrganizationForSyncAsync(organizationId, ct) is not { } organization)
        {
            return Error.NotFound("ACT_UNKNOWN_ORGANIZATION", "The organization does not exist.");
        }

        var contacts = await ContactAddressesAsync(organizationId, ct);
        var addresses = contacts
            .Concat(organization.Email is { Length: > 0 } email ? [email] : Array.Empty<string>())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var domains = organization.Domains.Where(d => !string.IsNullOrWhiteSpace(d)).Select(d => d.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (addresses.Count == 0 && domains.Count == 0)
        {
            return new MailListResponse([], [], 0);
        }

        // Each term is one request per mailbox, so a page view asks Exchange for a bounded number of them. Domains go first: they
        // find every address there, so only addresses outside them need a term of their own (DEV-12: what is left out is counted).
        var outside = addresses.Where(a => !domains.Exists(d => a.EndsWith("@" + d, StringComparison.OrdinalIgnoreCase))).ToList();
        var searchedDomains = domains.Take(MaxMailTerms).ToList();
        var searchedAddresses = outside.Take(MaxMailTerms - searchedDomains.Count).ToList();
        var notSearched = domains.Count - searchedDomains.Count + outside.Count - searchedAddresses.Count;

        IReadOnlyList<MailMessage> messages;
        try
        {
            messages = await mailbox.SearchAsync(new MailSearch(searchedAddresses, searchedDomains, Math.Clamp(take, 1, 50)), ct);
        }
        catch (UserNotConnectedException)
        {
            return OutlookErrors.NotConnected;
        }

        var messageIds = messages.Select(m => m.InternetMessageId).ToList();
        var saved = await db.Activities
            .Where(a => a.OrganizationId == organizationId && a.ExternalMessageId != null && messageIds.Contains(a.ExternalMessageId))
            .Select(a => a.ExternalMessageId!)
            .ToListAsync(ct);

        return new MailListResponse(
            messages.Select(m => new MailMessageDto(
                m.Id, m.InternetMessageId, m.Subject, m.Preview, m.FromAddress, m.FromName, m.ToAddresses, m.ReceivedAt,
                m.HasAttachments, m.WebLink, m.Mailbox, saved.Contains(m.InternetMessageId, StringComparer.OrdinalIgnoreCase))).ToList(),
            [.. searchedDomains, .. searchedAddresses],
            notSearched);
    }

    /// <summary>Saves a message against the customer: metadata and a link only (SEC-GDPR-06).</summary>
    public async Task<Result<ActivityDto>> SaveMailAsync(SaveMailRequest request, CancellationToken ct)
    {
        if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
        {
            return Error.Validation("ACT_UNKNOWN_ORGANIZATION", "The organization does not exist.");
        }

        if (await db.Activities.AnyAsync(a => a.OrganizationId == request.OrganizationId && a.ExternalMessageId == request.MessageId, ct))
        {
            return Error.Conflict("ACT_MAIL_ALREADY_SAVED", "This message is already on the customer.");
        }

        var activity = Activity.FromMail(
            new SavedMailDetails(
                request.OrganizationId, request.OpportunityId, request.ContractId, request.ContactId, request.Subject,
                request.Preview, request.FromAddress, request.FromName, request.ReceivedAt, request.MessageId, request.WebLink),
            currentUser.UserId,
            time.GetUtcNow());
        db.Activities.Add(activity);
        await db.SaveChangesAsync(ct);

        var organizations = await customers.GetOrganizationNamesAsync([activity.OrganizationId], ct);
        var people = await users.GetUsersAsync(activity.AssigneeId is { } assignee ? [assignee] : [], ct);
        RefDto? person = activity.AssigneeId is { } id && people.TryGetValue(id, out var user) ? new RefDto(user.Id, user.DisplayName) : null;
        return new ActivityDto(
            activity.Id, activity.Type, activity.OrganizationId, organizations.GetValueOrDefault(activity.OrganizationId),
            activity.OpportunityId, activity.ContractId, activity.ContactId, null, activity.Subject, activity.Body, null, null, null,
            activity.Priority, person, activity.Status, activity.CompletedAt, false, false, null, activity.WebLink, activity.FromAddress,
            activity.CreatedAt, person, db.GetETag(activity));
    }

    private async Task<CalendarEventDraft> DraftAsync(Activity activity, CancellationToken ct)
    {
        var attendees = new List<string>();
        if (activity.ContactId is { } contactId && await customers.GetContactForSyncAsync(contactId, ct) is { Email: { Length: > 0 } email })
        {
            attendees.Add(email);
        }

        var start = activity.DueAt ?? time.GetUtcNow();
        return new CalendarEventDraft(
            activity.Id, activity.Subject, activity.Body, start, start.AddMinutes(activity.DurationMinutes ?? 60), activity.Location, attendees);
    }

    private async Task<IReadOnlyList<string>> ContactAddressesAsync(Guid organizationId, CancellationToken ct) =>
        (await customers.GetOrganizationContactsAsync(organizationId, ct))
        .Where(contact => !contact.IsDeleted)
        .Select(contact => contact.Email)
        .OfType<string>()
        .Where(email => email.Length > 0)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToList();
}
