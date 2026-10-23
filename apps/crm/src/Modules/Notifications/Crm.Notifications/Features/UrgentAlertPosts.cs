using Crm.Customers.Contracts;
using Crm.Notifications.Contracts;
using Crm.Notifications.Domain;
using Crm.Notifications.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Notifications.Features;

/// <summary>
/// An alert that became urgent is announced in the operations channel (M43). The handler queues a notice — its kind and the alert's
/// ids and codes, never a sentence — and makes no call outside the CRM; <see cref="ChannelPostJob"/> words it when it sends it. The
/// alert is read again first, as an event can arrive late or out of order: only one still open, critical and not hidden is queued, of
/// a kind the channel takes, and one alert at most once a Norwegian day however often it opens and closes.
/// </summary>
internal sealed class UrgentAlertTeamsHandler(
    ITeamsChannelSender teams,
    IServiceApi service,
    NotificationsDbContext db,
    TimeProvider time,
    IOptions<TeamsNotificationOptions> options) : IDomainEventHandler<AlertBecameUrgent>
{
    public async Task HandleAsync(AlertBecameUrgent domainEvent, CancellationToken cancellationToken)
    {
        var settings = options.Value.UrgentAlerts;
        if (!settings.Enabled || !teams.IsConfigured(TeamsChannel.Operations))
        {
            return;
        }

        var now = time.GetUtcNow();
        if (await service.GetAlertAsync(domainEvent.AlertId, cancellationToken) is not { } alert || !alert.IsUrgentAt(now) || !settings.Covers(alert.Kind))
        {
            return;
        }

        var key = UrgentAlertNotices.DedupeKey(alert.Id, now);
        if (await db.ChannelPosts.AsNoTracking().AnyAsync(p => p.DedupeKey == key, cancellationToken))
        {
            return;
        }

        var post = ChannelPost.Notice(TeamsChannel.Operations, ChannelPostKind.UrgentAlert, UrgentAlertNotices.Parameters(alert), key, now);
        db.ChannelPosts.Add(post);
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // The alert's other event of the day queued it at the same moment; the unique key decided which one stays.
            db.Entry(post).State = EntityState.Detached;
        }
    }
}

/// <summary>The words of an urgent-alert notice (M43), in bokmål (a nynorsk channel gets bokmål too, as the digest does) or English.</summary>
internal static class UrgentAlertNotices
{
    /// <summary>One notice per alert and Norwegian day: an alert that flaps is announced again tomorrow, not every time it opens.</summary>
    public static string DedupeKey(Guid alertId, DateTimeOffset now) => $"urgent-alert:{alertId:N}:{OsloTime.Today(now):yyyy-MM-dd}";

    /// <summary>What the notice stores: ids and codes, so nothing the source wrote about a person is kept in the queue.</summary>
    public static IReadOnlyDictionary<string, string> Parameters(AlertRef alert)
    {
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["alertId"] = alert.Id.ToString("D"),
            ["organizationId"] = alert.OrganizationId.ToString("D"),
            ["system"] = alert.System,
            ["kind"] = alert.Kind.ToString(),
            ["severity"] = alert.Severity.ToString(),
        };
        if (alert.Rule is { Length: > 0 } rule)
        {
            parameters["rule"] = rule;
        }

        return parameters;
    }

    /// <summary>
    /// The card: the alert's title as its source wrote it, or for a coverage gap of Parasoll's own (whose stored title is an English
    /// sentence) the rule's name; the customer in the heading, then source, device and when it opened, and the link to the alert.
    /// </summary>
    public static TeamsCard Card(AlertRef alert, string? customer, string? language, string? link)
    {
        var nb = NotificationTexts.IsNorwegian(language);
        var heading = nb ? "Kritisk driftsvarsel" : "Critical alert";
        var facts = new List<TeamsFact> { new(nb ? "Kilde" : "Source", SourceName(alert.System)) };
        if (alert.DeviceName is { Length: > 0 } device)
        {
            facts.Add(new TeamsFact(nb ? "Enhet" : "Device", device));
        }

        facts.Add(new TeamsFact(nb ? "Åpnet" : "Opened", OsloTime.Moment(alert.CreatedAtSource)));
        return new TeamsCard(
            customer is { Length: > 0 } name ? $"{heading} for {name}" : heading,
            alert.System == CoverageGaps.System ? RuleName(alert.Rule, nb) : alert.Title,
            facts,
            link,
            nb ? "Åpne i Parasoll" : "Open in Parasoll");
    }

    /// <summary>A source as people write it: the alert stores the integration's code.</summary>
    public static string SourceName(string system) => system switch
    {
        "atera" => "Atera",
        "huntress" => "Huntress",
        "cloudally" => "CloudAlly",
        CoverageGaps.System => "Parasoll",
        _ => system,
    };

    /// <summary>The names the interface gives the coverage rules ("Dekningskontroller"), for the gaps they find.</summary>
    public static string RuleName(string? rule, bool nb) => (rule, nb) switch
    {
        ("atera.agent-silent", true) => "Atera-agent som ikke melder seg",
        ("atera.agent-silent", false) => "Silent Atera agent",
        ("huntress.agent-missing", true) => "Enhet uten Huntress",
        ("huntress.agent-missing", false) => "Device without Huntress",
        ("atera.agent-missing", true) => "Enhet uten Atera",
        ("atera.agent-missing", false) => "Device without Atera",
        ("huntress.agent-silent", true) => "Huntress-agent som ikke melder seg",
        ("huntress.agent-silent", false) => "Silent Huntress agent",
        ("huntress.agent-outdated", true) => "Utdatert Huntress-agent",
        ("huntress.agent-outdated", false) => "Outdated Huntress agent",
        ("huntress.defender-off", true) => "Defender beskytter ikke",
        ("huntress.defender-off", false) => "Defender does not protect",
        ("cloudally.backup-failed", true) => "Sikkerhetskopi som feilet (CloudAlly)",
        ("cloudally.backup-failed", false) => "Failed backup (CloudAlly)",
        ("cloudally.backup-late", true) => "Forsinket sikkerhetskopi (CloudAlly)",
        ("cloudally.backup-late", false) => "Overdue backup (CloudAlly)",
        ("cloudally.backup-paused", true) => "Sikkerhetskopi på pause (CloudAlly)",
        ("cloudally.backup-paused", false) => "Paused backup (CloudAlly)",
        ("cloudally.user-not-backed-up", true) => "Lisensiert bruker uten sikkerhetskopi",
        ("cloudally.user-not-backed-up", false) => "Licensed user without backup",
        (_, true) => "Dekningshull funnet av Parasoll",
        (_, false) => "Coverage gap found by Parasoll",
    };
}

/// <summary>A notice's card when its turn comes, or why it is not posted (<see cref="Skipped"/>, in English for the post's record).</summary>
public sealed record NoticeCard(TeamsCard? Card, string? Skipped);

/// <summary>
/// Makes the card of a notice (M43) when <see cref="ChannelPostJob"/> sends it, from what the CRM knows then: an urgent alert is read
/// again and announced only while it is still open, critical and not hidden, with its customer's name as it is now.
/// </summary>
public sealed class ChannelNotices(
    IServiceApi service,
    ICustomersApi customers,
    TimeProvider time,
    IOptions<NotificationsOptions> notifications,
    IOptions<TeamsNotificationOptions> options)
{
    public async Task<NoticeCard> CardAsync(ChannelPost post, CancellationToken cancellationToken)
    {
        if (post.Kind != ChannelPostKind.UrgentAlert)
        {
            return new NoticeCard(post.Card, null);
        }

        if (!options.Value.UrgentAlerts.Enabled)
        {
            return new NoticeCard(null, "Urgent alerts were switched off before the notice was posted.");
        }

        if (!Guid.TryParse(post.Parameters.GetValueOrDefault("alertId"), out var id) ||
            await service.GetAlertAsync(id, cancellationToken) is not { } alert || !alert.IsUrgentAt(time.GetUtcNow()))
        {
            return new NoticeCard(null, "The alert was no longer urgent (resolved, hidden or no longer critical) when its turn came.");
        }

        var customer = (await customers.GetOrganizationNamesAsync([alert.OrganizationId], cancellationToken)).GetValueOrDefault(alert.OrganizationId);
        return new NoticeCard(
            UrgentAlertNotices.Card(alert, customer, options.Value.Language, TeamsCards.Link(notifications.Value, $"/alerts?alert={alert.Id:D}")), null);
    }
}
