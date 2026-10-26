using Crm.SharedKernel.Domain;

namespace Crm.Notifications.Contracts;

/// <summary>What a notification is about. The text is rendered from the kind and its parameters, so it follows the reader's language.</summary>
public enum NotificationKind
{
    ContractEnding,
    NoticeDeadline,
    HourBankLow,
    SubscriptionCancellationWindow,
    SubscriptionRenewal,
    StaleOpportunity,
    InvoiceOverdue,

    /// <summary>An action the person asked of a vendor got no clear answer (M39): they check at the vendor and record what they found.</summary>
    VendorActionUncertain,
}

/// <summary>
/// One notice for one person. <paramref name="DedupeKey"/> makes it idempotent: a job may run again, and an event may be
/// delivered more than once, without the reader seeing the same notice twice.
/// </summary>
public sealed record NotificationRequest(
    NotificationKind Kind,
    Guid RecipientId,
    string DedupeKey,
    IReadOnlyDictionary<string, string> Parameters,
    Guid? OrganizationId = null,
    string? Link = null,
    DateOnly? DueDate = null,
    bool Warning = false);

/// <summary>Public API of the Notifications module: other modules and integrations enqueue notices for a person.</summary>
public interface INotificationsApi
{
    /// <summary>Returns false when the notice already existed (same dedupe key).</summary>
    Task<bool> EnqueueAsync(NotificationRequest request, CancellationToken cancellationToken);
}

/// <summary>
/// A notice asked for through the outbox (M39). A domain event handler changes its own module only (DEV-07), so a handler elsewhere
/// that decides a person should hear of something raises this instead of calling <see cref="INotificationsApi"/>, and the
/// Notifications module enqueues it; the dedupe key keeps a repeated delivery from adding a second notice.
/// </summary>
public sealed record NotificationRequested(NotificationRequest Request) : DomainEvent;

/// <summary>One e-mail, already rendered in the reader's language.</summary>
public sealed record NotificationEmail(string ToAddress, string? ToName, string Subject, string HtmlBody, string TextBody);

/// <summary>
/// Sends the digest e-mail. Implemented by the Microsoft Graph integration, so the module stays independent of it
/// (docs/03-architecture.md §5.2).
/// </summary>
public interface INotificationEmailSender
{
    /// <summary>False when Graph or the sender mailbox is not configured; the digest is then only kept in the CRM.</summary>
    bool IsConfigured { get; }

    Task SendAsync(NotificationEmail email, CancellationToken cancellationToken);
}

/// <summary>The Teams channel a message belongs in; each maps to a Workflows webhook in configuration (FR-ACT-04).</summary>
public enum TeamsChannel
{
    Sales,
    Finance,
    Operations,
}

public sealed record TeamsFact(string Label, string Value);

/// <summary>A short card for a Teams channel: a headline, a few facts and one link back into the CRM.</summary>
public sealed record TeamsCard(string Title, string Text, IReadOnlyList<TeamsFact> Facts, string? Link, string? LinkText);

/// <summary>
/// Posts to the team's channels through Power Automate Workflows webhooks (Office 365 connectors were retired in May 2026).
/// Implemented by the Microsoft Graph integration; each channel is configured separately and silently skipped when it is not.
/// </summary>
public interface ITeamsChannelSender
{
    bool IsConfigured(TeamsChannel channel);

    Task SendAsync(TeamsChannel channel, TeamsCard card, CancellationToken cancellationToken);
}
