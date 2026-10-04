using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Customers.Contracts;
using Crm.Notifications.Contracts;
using Crm.Notifications.Domain;
using Crm.Notifications.Persistence;
using Crm.Sales.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Notifications.Features;

/// <summary>Shared wording and links for the channel cards (FR-ACT-04).</summary>
internal static class TeamsCards
{
    public static string? Link(NotificationsOptions options, string path) =>
        string.IsNullOrWhiteSpace(options.AppBaseUrl) ? null : $"{options.AppBaseUrl.TrimEnd('/')}{path}";

    public static string Money(decimal amount) =>
        string.Create(CultureInfo.InvariantCulture, $"{amount:N0}").Replace(",", " ", StringComparison.Ordinal) + " NOK";

    public static string Date(DateOnly date) => date.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture);
}

/// <summary>
/// A won deal above the threshold is announced in the sales channel (docs/02 §5). Small deals stay out of the channel so
/// that what appears there is worth reading. The card is queued, not sent (DEV-07): see <see cref="ChannelPostJob"/>.
/// </summary>
internal sealed class WonDealTeamsHandler(
    ITeamsChannelSender teams,
    ICustomersApi customers,
    NotificationsDbContext db,
    TimeProvider time,
    IOptions<NotificationsOptions> notifications,
    IOptions<TeamsNotificationOptions> options) : IDomainEventHandler<OpportunityWon>
{
    public async Task HandleAsync(OpportunityWon domainEvent, CancellationToken cancellationToken)
    {
        if (!teams.IsConfigured(TeamsChannel.Sales))
        {
            return;
        }

        // A deal is worth its one-off plus a year of recurring revenue.
        var value = domainEvent.OneOffAmount + (domainEvent.Mrr * 12);
        if (value < options.Value.WonDealThreshold)
        {
            return;
        }

        var organization = await customers.GetOrganizationAsync(domainEvent.OrganizationId, cancellationToken);
        var facts = new List<TeamsFact>
        {
            new("Kunde", organization?.Name ?? "—"),
            new("Engangsbeløp", TeamsCards.Money(domainEvent.OneOffAmount)),
            new("Per måned", TeamsCards.Money(domainEvent.Mrr)),
            new("Verdi første år", TeamsCards.Money(value)),
        };

        db.ChannelPosts.Add(ChannelPost.For(
            TeamsChannel.Sales,
            new TeamsCard(
                "Salg vunnet 🎉",
                $"{organization?.Name ?? "En kunde"} er vunnet.",
                facts,
                TeamsCards.Link(notifications.Value, $"/sales/opportunities/{domainEvent.OpportunityId}"),
                "Åpne salget"),
            time.GetUtcNow()));
        await db.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>An approved billing run tells the finance channel that orders are on their way to PowerOffice (queued, DEV-07).</summary>
internal sealed class BillingRunTeamsHandler(
    ITeamsChannelSender teams,
    NotificationsDbContext db,
    TimeProvider time,
    IOptions<NotificationsOptions> notifications) : IDomainEventHandler<BillingRunApproved>
{
    public async Task HandleAsync(BillingRunApproved domainEvent, CancellationToken cancellationToken)
    {
        if (!teams.IsConfigured(TeamsChannel.Finance))
        {
            return;
        }

        db.ChannelPosts.Add(ChannelPost.For(
            TeamsChannel.Finance,
            new TeamsCard(
                "Faktureringskjøring godkjent",
                $"Perioden {TeamsCards.Date(domainEvent.PeriodStart)}–{TeamsCards.Date(domainEvent.PeriodEnd)} er godkjent og legges ut som salgsordrer.",
                [new TeamsFact("Periode", $"{TeamsCards.Date(domainEvent.PeriodStart)} – {TeamsCards.Date(domainEvent.PeriodEnd)}")],
                TeamsCards.Link(notifications.Value, $"/billing/runs/{domainEvent.RunId}"),
                "Åpne kjøringen"),
            time.GetUtcNow()));
        await db.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>
/// Sends the queued channel cards (FR-ACT-04). Each run claims a due card with a token of its own, sends it and records the
/// outcome only while it still holds the card; a failed send is tried again later with a growing pause and given up after
/// <see cref="ChannelPost.MaxAttempts"/> attempts. A webhook has no idempotency key, so a send that timed out after Teams
/// had taken it can still appear twice — the one duplicate left, and only for a notice; the event itself is never sent twice.
/// </summary>
public sealed class ChannelPostJob(
    NotificationsDbContext db, ITeamsChannelSender teams, TimeProvider time, IMaintenanceGate maintenance, IExternalEffectJournal journal,
    ILogger<ChannelPostJob> logger)
{
    /// <summary>Journal kind and record type of a channel post (DEV-13).</summary>
    public const string EffectKind = "channel-post";
    public const string EffectEntity = "ChannelPost";

    public const string JobId = "channel-posts";
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(2);

    public async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var due = await db.ChannelPosts.AsNoTracking()
            .Where(p => p.Status == ChannelPostStatus.Pending && p.NextAttemptAt <= now && (p.LockedUntil == null || p.LockedUntil < now))
            .OrderBy(p => p.CreatedAt)
            .Select(p => p.Id)
            .Take(50)
            .ToListAsync(cancellationToken);

        var sent = 0;
        foreach (var id in due)
        {
            // DEV-13: read now, not from a cache — a post must not leave after read-only maintenance began, nor when unknown.
            if (!await MaySendAsync(cancellationToken))
            {
                break;
            }

            var token = Guid.NewGuid();
            var lease = time.GetUtcNow() + Lease;
            var claimed = await db.ChannelPosts
                .Where(p => p.Id == id && p.Status == ChannelPostStatus.Pending && (p.LockedUntil == null || p.LockedUntil < now))
                .ExecuteUpdateAsync(s => s.SetProperty(p => p.LockedUntil, lease).SetProperty(p => p.LeaseOwner, token), cancellationToken);
            if (claimed == 0)
            {
                continue;
            }

            // Claimed after a fresh look at the switch, the post is under way: its outcome is recorded even if maintenance begins
            // meanwhile, while the journal — which reads the switch again — stops a send that has not started.
            using var inFlight = MaintenanceScope.AllowWrites("channel-post-in-flight");
            var post = await db.ChannelPosts.AsNoTracking().SingleAsync(p => p.Id == id, cancellationToken);
            var attempts = post.Attempts + 1;
            if (!teams.IsConfigured(post.Channel))
            {
                await SettleAsync(id, token, ChannelPostStatus.Failed, attempts, null, "The channel is no longer configured.");
                continue;
            }

            ExternalEffectEntry effect;
            try
            {
                effect = await journal.BeginAsync(new ExternalEffect("teams", EffectKind, EffectEntity, id), cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("Channel posts wait: the external effect journal did not take the post ({Error})", ex.GetType().Name);
                await db.ChannelPosts.Where(p => p.Id == id && p.LeaseOwner == token)
                    .ExecuteUpdateAsync(s => s.SetProperty(p => p.LockedUntil, (DateTimeOffset?)null).SetProperty(p => p.LeaseOwner, (Guid?)null), cancellationToken);
                break;
            }

            try
            {
                await teams.SendAsync(post.Channel, post.Card, cancellationToken);
                await journal.CompleteAsync(effect, EffectPhase.Sent, null, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                var exhausted = attempts >= ChannelPost.MaxAttempts;
                logger.LogWarning(ex, "Channel post {PostId} to {Channel} failed (attempt {Attempt})", id, post.Channel, attempts);
                await SettleAsync(id, token, exhausted ? ChannelPostStatus.Failed : ChannelPostStatus.Pending, attempts,
                    time.GetUtcNow().AddMinutes(Math.Min(60, Math.Pow(2, attempts - 1))), ex.GetBaseException().Message);
                continue;
            }

            if (await SettleAsync(id, token, ChannelPostStatus.Sent, attempts, null, null))
            {
                sent++;
            }
        }

        return sent;
    }

    private async Task<bool> MaySendAsync(CancellationToken cancellationToken)
    {
        try
        {
            return !(await maintenance.FreshAsync(cancellationToken)).IsReadOnly;
        }
        catch (MaintenanceStateUnavailableException)
        {
            logger.LogWarning("Channel posts wait: the maintenance state cannot be read");
            return false;
        }
    }

    private async Task<bool> SettleAsync(Guid id, Guid token, ChannelPostStatus status, int attempts, DateTimeOffset? next, string? error)
    {
        var now = time.GetUtcNow();
        var lastError = error is { Length: > 512 } ? error[..512] : error;
        var updated = await db.ChannelPosts
            .Where(p => p.Id == id && p.LeaseOwner == token)
            .ExecuteUpdateAsync(s => s
                .SetProperty(p => p.Status, status)
                .SetProperty(p => p.Attempts, attempts)
                .SetProperty(p => p.NextAttemptAt, p => next ?? p.NextAttemptAt)
                .SetProperty(p => p.SentAt, p => status == ChannelPostStatus.Sent ? now : p.SentAt)
                .SetProperty(p => p.LastError, lastError)
                .SetProperty(p => p.LockedUntil, (DateTimeOffset?)null)
                .SetProperty(p => p.LeaseOwner, (Guid?)null));
        if (updated == 0)
        {
            logger.LogWarning("Channel post {PostId}: another run took it over; this run leaves it alone", id);
        }

        return updated == 1;
    }
}

/// <summary>Thresholds for what reaches a channel; the webhook URLs themselves live with the Graph settings.</summary>
public sealed class TeamsNotificationOptions
{
    public const string SectionName = "Integrations:MicrosoftGraph:Teams";

    public decimal WonDealThreshold { get; set; } = 100_000m;
}
