using System.Text.Json;
using Crm.Notifications.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Notifications.Domain;

public enum EmailStatus
{
    /// <summary>Waiting for the next digest.</summary>
    Pending,
    Sent,
    Failed,

    /// <summary>Not sent on purpose: e-mail is off for the tenant or muted by the reader.</summary>
    Suppressed,
}

/// <summary>
/// A notice for one person (FR-ACT-04, FR-CON-04). The text is not stored: the kind and its parameters are, so the reader
/// sees it in their own language and an e-mail digest can render the same notice again.
/// </summary>
public sealed class Notification : AuditableEntity
{
    private Notification() { }

    public NotificationKind Kind { get; private set; }
    public Guid RecipientId { get; private set; }
    public Guid? OrganizationId { get; private set; }

    /// <summary>JSON object with the values the text needs (contract number, hours left, amount).</summary>
    public string ParametersJson { get; private set; } = "{}";

    public string? Link { get; private set; }
    public DateOnly? DueDate { get; private set; }
    public bool Warning { get; private set; }

    /// <summary>Makes creation idempotent (kind + subject + date), so a repeated scan adds nothing.</summary>
    public string DedupeKey { get; private set; } = string.Empty;

    public DateTimeOffset? ReadAt { get; private set; }
    public EmailStatus EmailStatus { get; private set; }
    public DateTimeOffset? EmailSentAt { get; private set; }
    public string? EmailError { get; private set; }

    public bool IsUnread => ReadAt is null;

    public IReadOnlyDictionary<string, string> Parameters =>
        JsonSerializer.Deserialize<Dictionary<string, string>>(ParametersJson) ?? [];

    public static Notification Create(NotificationRequest request) => new()
    {
        Kind = request.Kind,
        RecipientId = request.RecipientId,
        OrganizationId = request.OrganizationId,
        ParametersJson = JsonSerializer.Serialize(request.Parameters),
        Link = Trim(request.Link, 512),
        DueDate = request.DueDate,
        Warning = request.Warning,
        DedupeKey = Trim(request.DedupeKey, 200)!,
        EmailStatus = EmailStatus.Pending,
    };

    public void MarkRead(DateTimeOffset at) => ReadAt ??= at;

    public void MarkEmailSent(DateTimeOffset at)
    {
        EmailStatus = EmailStatus.Sent;
        EmailSentAt = at;
        EmailError = null;
    }

    public void MarkEmailFailed(string error)
    {
        EmailStatus = EmailStatus.Failed;
        EmailError = Trim(error, 512);
    }

    /// <summary>The notice stays in the CRM, but no e-mail goes out (e-mail off, muted kind, or no address).</summary>
    public void SuppressEmail(string reason)
    {
        EmailStatus = EmailStatus.Suppressed;
        EmailError = Trim(reason, 512);
    }

    private static string? Trim(string? value, int max) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim() is { } trimmed && trimmed.Length > max ? trimmed[..max] : value.Trim();
}

/// <summary>What a person wants to hear about, and when the daily digest reaches them.</summary>
public sealed class NotificationPreference : AuditableEntity
{
    public const int DefaultDigestHour = 7;

    private NotificationPreference() { }

    public Guid UserId { get; private set; }
    public bool EmailEnabled { get; private set; } = true;

    /// <summary>Hour of the day in Europe/Oslo when the digest is sent (0–23).</summary>
    public int DigestHour { get; private set; } = DefaultDigestHour;

    /// <summary>JSON array of muted kinds.</summary>
    public string MutedKindsJson { get; private set; } = "[]";

    public IReadOnlyList<NotificationKind> MutedKinds =>
        JsonSerializer.Deserialize<List<NotificationKind>>(MutedKindsJson) ?? [];

    public static NotificationPreference Default(Guid userId) => new() { UserId = userId };

    public bool IsMuted(NotificationKind kind) => MutedKinds.Contains(kind);

    public void Update(bool emailEnabled, int digestHour, IReadOnlyCollection<NotificationKind> mutedKinds)
    {
        EmailEnabled = emailEnabled;
        DigestHour = Math.Clamp(digestHour, 0, 23);
        MutedKindsJson = JsonSerializer.Serialize(mutedKinds.Distinct().ToList());
    }
}
