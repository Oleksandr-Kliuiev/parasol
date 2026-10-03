using Crm.SharedKernel.Domain;

namespace Crm.Activities.Contracts;

public enum ActivityType
{
    Task,
    Call,
    Meeting,
    Note,

    /// <summary>A message from Outlook saved against the customer; the CRM keeps metadata and a link (FR-ACT-03).</summary>
    Email,
}

public enum ActivityStatus
{
    Open,
    Done,
    Cancelled,
}

public enum ActivityPriority
{
    Low,
    Normal,
    High,
}

/// <summary>Something was logged against a customer (and possibly a deal or contract); "stale deal" watching uses it (BR-SAL-03).</summary>
public sealed record ActivityLogged(Guid ActivityId, Guid OrganizationId, Guid? OpportunityId, Guid? ContractId, DateTimeOffset At) : DomainEvent;

/// <summary>
/// The session has no delegated token for the external system: nobody is signed in with Entra ID (development sign-in),
/// or consent for the scopes is missing. Callers turn it into a readable answer instead of a 500.
/// </summary>
public sealed class UserNotConnectedException(string system) : Exception($"{system} is not connected for the signed-in user.")
{
    public string System { get; } = system;
}

/// <summary>A meeting as Outlook should show it (FR-ACT-02).</summary>
public sealed record CalendarEventDraft(
    Guid ActivityId,
    string Subject,
    string? Body,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    string? Location,
    IReadOnlyList<string> Attendees);

/// <summary>What Outlook says about an event the CRM created.</summary>
public sealed record CalendarEventState(
    string EventId,
    Guid? ActivityId,
    string Subject,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    bool IsCancelled,
    string? WebLink);

/// <summary>
/// The signed-in user's Outlook calendar (FR-ACT-02). Implemented by the Microsoft Graph integration with the user's own
/// delegated token, so a meeting appears in their calendar and the invitation comes from them.
/// </summary>
public interface IUserCalendar
{
    /// <summary>False when Graph is off, the calendar feature is off, or the session has no delegated token (development sign-in).</summary>
    bool IsAvailable { get; }

    Task<CalendarEventState> CreateAsync(CalendarEventDraft draft, CancellationToken cancellationToken);

    Task<CalendarEventState> UpdateAsync(string eventId, CalendarEventDraft draft, CancellationToken cancellationToken);

    Task CancelAsync(string eventId, CancellationToken cancellationToken);

    /// <summary>
    /// The user's calendar between two moments, for reading changes back into the CRM. Events the CRM created carry the
    /// activity id in an open extension, so they can be matched without storing anything in Outlook's subject.
    /// </summary>
    Task<IReadOnlyList<CalendarEventState>> ReadWindowAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);
}

/// <summary>A message in the user's mailbox; only metadata, never the body (SEC-GDPR-06).</summary>
public sealed record MailMessage(
    string Id,
    string InternetMessageId,
    string Subject,
    string? Preview,
    string FromAddress,
    string? FromName,
    IReadOnlyList<string> ToAddresses,
    DateTimeOffset ReceivedAt,
    bool HasAttachments,
    string? WebLink,
    string Mailbox);

public sealed record MailSearch(IReadOnlyList<string> Addresses, IReadOnlyList<string> Domains, int Take = 25);

/// <summary>
/// Reads the signed-in user's mailbox and the shared mailboxes they may open (FR-ACT-03). Bodies stay in Exchange: the CRM
/// shows metadata and a link, and only stores something when the user saves a message as an activity.
/// </summary>
public interface IUserMailbox
{
    bool IsAvailable { get; }

    /// <summary>Messages exchanged with the given addresses or e-mail domains, newest first.</summary>
    Task<IReadOnlyList<MailMessage>> SearchAsync(MailSearch search, CancellationToken cancellationToken);
}
