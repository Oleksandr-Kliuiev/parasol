namespace Crm.Notifications;

/// <summary>Notification settings (docs/02 §4.11). E-mail is off until the company has a sender mailbox.</summary>
public sealed class NotificationsOptions
{
    public const string SectionName = "Notifications";

    /// <summary>Send digest e-mails. Off by default: without it notices only live in the CRM.</summary>
    public bool EmailEnabled { get; set; }

    /// <summary>Mailbox the digest is sent from (a shared mailbox, not a person).</summary>
    public string? FromAddress { get; set; }

    /// <summary>Base URL used for links in e-mails, e.g. https://crm.vardahei.no.</summary>
    public string? AppBaseUrl { get; set; }

    /// <summary>At most this many notices per digest; the rest are summarized as "and N more".</summary>
    public int MaxItemsPerEmail { get; set; } = 20;

    public string ScanCron { get; set; } = "30 6 * * *";

    public string DigestCron { get; set; } = "0 * * * *";
}
