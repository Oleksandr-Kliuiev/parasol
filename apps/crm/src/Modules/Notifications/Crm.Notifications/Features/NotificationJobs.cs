using System.Globalization;
using System.Net;
using System.Text;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Licensing.Contracts;
using Crm.Notifications.Contracts;
using Crm.Notifications.Domain;
using Crm.Notifications.Persistence;
using Crm.Sales.Contracts;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Notifications.Features;

public sealed record ScanResult(int Created);

/// <summary>
/// Turns what other modules know needs attention into notices for the responsible person: open cancellation windows and
/// renewals (BR-LIC-02), deals that went quiet (BR-SAL-03) and overdue invoices. Reminders about contracts and hour banks
/// arrive as events instead, so they appear the moment they are created.
/// </summary>
public sealed class NotificationScanJob(
    INotificationsApi notifications,
    ILicensingApi licensing,
    ISalesApi sales,
    IBillingApi billing,
    ICustomersApi customers,
    TimeProvider time,
    ILogger<NotificationScanJob> logger)
{
    public const string JobId = "notification-scan";

    public async Task<ScanResult> RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var today = OsloTime.Today(now);
        var created = 0;
        var accountManagers = new Dictionary<Guid, Guid?>();

        async Task<Guid?> AccountManagerAsync(Guid? organizationId)
        {
            if (organizationId is not { } id)
            {
                return null;
            }

            if (!accountManagers.TryGetValue(id, out var manager))
            {
                manager = (await customers.GetOrganizationAsync(id, cancellationToken))?.AccountManagerId;
                accountManagers[id] = manager;
            }

            return manager;
        }

        var names = new Dictionary<Guid, string>();
        async Task<string> NameAsync(Guid? organizationId)
        {
            if (organizationId is not { } id)
            {
                return "—";
            }

            if (!names.TryGetValue(id, out var name))
            {
                name = (await customers.GetOrganizationAsync(id, cancellationToken))?.Name ?? "—";
                names[id] = name;
            }

            return name;
        }

        foreach (var subscription in await licensing.GetAttentionAsync(today, cancellationToken))
        {
            if (await AccountManagerAsync(subscription.OrganizationId) is not { } recipient)
            {
                continue;
            }

            var kind = subscription.Kind == SubscriptionAttentionKind.CancellationWindow
                ? NotificationKind.SubscriptionCancellationWindow
                : NotificationKind.SubscriptionRenewal;
            var date = subscription.Kind == SubscriptionAttentionKind.CancellationWindow
                ? subscription.WindowEndsAt?.ToString("dd.MM.yyyy HH:mm", CultureInfo.InvariantCulture) ?? "—"
                : subscription.Date?.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture) ?? "—";
            created += await EnqueueAsync(new NotificationRequest(
                kind,
                recipient,
                $"{kind}:{subscription.SubscriptionId}:{today:yyyy-MM-dd}",
                new Dictionary<string, string>
                {
                    ["offer"] = subscription.OfferName,
                    ["organization"] = await NameAsync(subscription.OrganizationId),
                    ["date"] = date,
                    ["quantity"] = subscription.Quantity.ToString(CultureInfo.InvariantCulture),
                },
                subscription.OrganizationId,
                "/licenses?window=true",
                subscription.Date,
                Warning: subscription.Kind == SubscriptionAttentionKind.CancellationWindow), cancellationToken);
        }

        foreach (var deal in await sales.GetStaleOpportunitiesAsync(now, cancellationToken))
        {
            var recipient = deal.OwnerId ?? await AccountManagerAsync(deal.OrganizationId);
            if (recipient is not { } target)
            {
                continue;
            }

            // Weekly, not daily: a quiet deal should nudge, not nag.
            var week = ISOWeek.GetWeekOfYear(today.ToDateTime(TimeOnly.MinValue));
            created += await EnqueueAsync(new NotificationRequest(
                NotificationKind.StaleOpportunity,
                target,
                $"{NotificationKind.StaleOpportunity}:{deal.OpportunityId}:{today.Year}-W{week}",
                new Dictionary<string, string>
                {
                    ["name"] = deal.Name,
                    ["organization"] = await NameAsync(deal.OrganizationId),
                    ["days"] = deal.DaysQuiet.ToString(CultureInfo.InvariantCulture),
                },
                deal.OrganizationId,
                $"/sales/opportunities/{deal.OpportunityId}"), cancellationToken);
        }

        foreach (var invoice in await billing.GetOverdueInvoicesAsync(today, cancellationToken))
        {
            if (await AccountManagerAsync(invoice.OrganizationId) is not { } recipient)
            {
                continue;
            }

            created += await EnqueueAsync(new NotificationRequest(
                NotificationKind.InvoiceOverdue,
                recipient,
                $"{NotificationKind.InvoiceOverdue}:{invoice.InvoiceId}:{today:yyyy-MM}",
                new Dictionary<string, string>
                {
                    ["number"] = invoice.InvoiceNo,
                    ["organization"] = await NameAsync(invoice.OrganizationId),
                    ["date"] = invoice.DueDate.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture),
                    ["amount"] = NotificationTexts.Money(invoice.Outstanding),
                    ["days"] = invoice.DaysOverdue.ToString(CultureInfo.InvariantCulture),
                },
                invoice.OrganizationId,
                "/billing/invoices?overdue=true",
                invoice.DueDate,
                Warning: true), cancellationToken);
        }

        logger.LogInformation("Notification scan for {Today}: {Created} new notices.", today, created);
        return new ScanResult(created);
    }

    private async Task<int> EnqueueAsync(NotificationRequest request, CancellationToken cancellationToken) =>
        await notifications.EnqueueAsync(request, cancellationToken) ? 1 : 0;
}

public sealed record DigestResult(int Recipients, int Notices, int Suppressed);

/// <summary>
/// Sends each person one e-mail with what is waiting, at the hour they chose (Europe/Oslo). Without a configured sender the
/// notices stay in the CRM and are marked suppressed, so nothing is silently lost.
/// </summary>
public sealed class NotificationDigestJob(
    NotificationsDbContext db,
    IUserDirectory users,
    IEnumerable<INotificationEmailSender> senders,
    IOptions<NotificationsOptions> options,
    TimeProvider time,
    IMaintenanceGate maintenance,
    IExternalEffectJournal journal,
    ILogger<NotificationDigestJob> logger)
{
    public const string JobId = "notification-digest";

    /// <summary>Journal kind of a digest e-mail; the record is its reader (an employee's user id, DEV-13).</summary>
    public const string EffectKind = "notification-digest";
    public const string EffectEntity = "User";

    public async Task<DigestResult> RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var hour = OsloTime.Hour(now);
        var settings = options.Value;

        var sender = senders.FirstOrDefault(s => s.IsConfigured);
        // Only readers whose digest hour this is, decided in SQL (DEV-12): the oldest notices of readers due at another hour can no
        // longer crowd out the ones due now, as a fixed batch of the oldest pending notices did. Every notice read here leaves
        // Pending below (sent, failed or suppressed), so the set is what this hour owes and no more.
        var pending = await db.Notifications
            .Where(n => n.EmailStatus == EmailStatus.Pending && n.ReadAt == null &&
                        (db.Preferences.Where(p => p.UserId == n.RecipientId).Select(p => (int?)p.DigestHour).FirstOrDefault()
                         ?? NotificationPreference.DefaultDigestHour) == hour)
            .OrderBy(n => n.CreatedAt)
            .ToListAsync(cancellationToken);
        if (pending.Count == 0)
        {
            return new DigestResult(0, 0, 0);
        }

        var recipientIds = pending.Select(n => n.RecipientId).Distinct().ToList();
        var preferences = await db.Preferences.AsNoTracking()
            .Where(p => recipientIds.Contains(p.UserId))
            .ToDictionaryAsync(p => p.UserId, cancellationToken);

        int recipients = 0, notices = 0, suppressed = 0;
        foreach (var group in pending.GroupBy(n => n.RecipientId))
        {
            var preference = preferences.GetValueOrDefault(group.Key);
            var digestHour = preference?.DigestHour ?? NotificationPreference.DefaultDigestHour;
            if (digestHour != hour)
            {
                continue;
            }

            var profile = await users.GetProfileAsync(group.Key, cancellationToken);
            var items = group.Where(n => preference?.IsMuted(n.Kind) != true).ToList();
            foreach (var muted in group.Except(items))
            {
                muted.SuppressEmail("The reader muted this kind.");
                suppressed++;
            }

            if (items.Count == 0)
            {
                continue;
            }

            if (!settings.EmailEnabled || sender is null || preference?.EmailEnabled == false || profile?.Email is null || profile.IsActive == false)
            {
                var reason = !settings.EmailEnabled || sender is null
                    ? "E-mail delivery is off (Notifications:EmailEnabled)."
                    : preference?.EmailEnabled == false ? "The reader turned e-mail off." : "The reader has no e-mail address.";
                foreach (var item in items)
                {
                    item.SuppressEmail(reason);
                    suppressed++;
                }

                continue;
            }

            // DEV-13: read now — no e-mail leaves once read-only maintenance began, or while the state cannot be read; the notices
            // stay pending for the next digest.
            if (!await MaySendAsync(cancellationToken))
            {
                break;
            }

            var email = Compose(profile, items, settings);
            ExternalEffectEntry effect;
            try
            {
                effect = await journal.BeginAsync(new ExternalEffect("graph", EffectKind, EffectEntity, group.Key), cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("Digest e-mails wait: the external effect journal did not take the e-mail ({Error})", ex.GetType().Name);
                break;
            }

            try
            {
                await sender.SendAsync(email, cancellationToken);
                await journal.CompleteAsync(effect, EffectPhase.Sent, null, cancellationToken);
                foreach (var item in items)
                {
                    item.MarkEmailSent(now);
                }

                recipients++;
                notices += items.Count;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Digest e-mail to {UserId} failed.", group.Key);
                foreach (var item in items)
                {
                    item.MarkEmailFailed(ex.GetBaseException().Message);
                }
            }
        }

        // Recording what was sent is allowed even if maintenance began meanwhile: those e-mails left, and a later digest must not
        // send them again.
        using (MaintenanceScope.AllowWrites("record-sent-effects"))
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        logger.LogInformation("Notification digest at {Hour}:00 Oslo: {Recipients} recipients, {Notices} notices, {Suppressed} suppressed.",
            hour, recipients, notices, suppressed);
        return new DigestResult(recipients, notices, suppressed);
    }

    private async Task<bool> MaySendAsync(CancellationToken cancellationToken)
    {
        try
        {
            return !(await maintenance.FreshAsync(cancellationToken)).IsReadOnly;
        }
        catch (MaintenanceStateUnavailableException)
        {
            logger.LogWarning("Digest e-mails wait: the maintenance state cannot be read");
            return false;
        }
    }

    internal static NotificationEmail Compose(UserProfile profile, IReadOnlyList<Notification> items, NotificationsOptions settings)
    {
        var language = profile.PreferredLanguage;
        var shown = items.Take(Math.Clamp(settings.MaxItemsPerEmail, 1, 100)).ToList();
        // The digest shows money only to a recipient whose confirmed roles include finance.read (DEV-12-AC04).
        var seesMoney = Permissions.ForRoles(profile.Roles ?? []).Contains(Permissions.FinanceRead);
        var baseUrl = settings.AppBaseUrl?.TrimEnd('/');

        var text = new StringBuilder();
        var html = new StringBuilder();
        text.AppendLine(NotificationTexts.Greeting(language, profile.DisplayName)).AppendLine();
        html.Append("<p>").Append(WebUtility.HtmlEncode(NotificationTexts.Greeting(language, profile.DisplayName))).Append("</p><ul>");
        foreach (var item in shown)
        {
            var line = NotificationTexts.Line(item.Kind, seesMoney ? item.Parameters : NotificationTexts.WithoutMoney(item.Parameters), language);
            var link = baseUrl is not null && item.Link is not null ? baseUrl + item.Link : null;
            text.Append("- ").Append(line);
            if (link is not null)
            {
                text.Append(' ').Append(link);
            }

            text.AppendLine();
            html.Append("<li>").Append(WebUtility.HtmlEncode(line));
            if (link is not null)
            {
                html.Append(" <a href=\"").Append(WebUtility.HtmlEncode(link)).Append("\">CRM</a>");
            }

            html.Append("</li>");
        }

        html.Append("</ul>");
        if (items.Count > shown.Count)
        {
            var more = NotificationTexts.More(language, items.Count - shown.Count);
            text.AppendLine(more);
            html.Append("<p>").Append(WebUtility.HtmlEncode(more)).Append("</p>");
        }

        var footer = NotificationTexts.Footer(language);
        text.AppendLine().AppendLine(footer);
        html.Append("<p style=\"color:#666;font-size:12px\">").Append(WebUtility.HtmlEncode(footer)).Append("</p>");

        return new NotificationEmail(profile.Email!, profile.DisplayName, NotificationTexts.Subject(language, items.Count), html.ToString(), text.ToString());
    }
}

/// <summary>Digest hours and dates are the company's own, so they follow Europe/Oslo and not the server's clock.</summary>
internal static class OsloTime
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public static DateOnly Today(DateTimeOffset now) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Oslo).DateTime);

    public static int Hour(DateTimeOffset now) => TimeZoneInfo.ConvertTime(now, Oslo).Hour;
}
