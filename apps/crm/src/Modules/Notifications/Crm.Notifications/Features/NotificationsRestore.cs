using System.Globalization;
using Crm.Notifications.Domain;
using Crm.Notifications.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Notifications.Features;

/// <summary>
/// Notifications' part in a restore (DEV-13): channel posts and digest e-mails the journal shows sent after the restore point are
/// marked sent in the restored copy, so the worker does not post or e-mail them a second time. A post without an answer is
/// marked too — a missing post is the smaller harm — and listed for a look at the channel.
/// </summary>
internal sealed class NotificationsRestoreParticipant(NotificationsDbContext db, TimeProvider time) : IRestoreParticipant
{
    public string Area => "notifications";

    public Task<int> InFlightAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        return db.ChannelPosts.AsNoTracking().CountAsync(p => p.Status == ChannelPostStatus.Pending && p.LockedUntil > now, cancellationToken);
    }

    public async Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken)
    {
        var posts = await db.ChannelPosts.AsNoTracking().CountAsync(p => p.Status == ChannelPostStatus.Pending, cancellationToken);
        var emails = await db.Notifications.AsNoTracking().CountAsync(n => n.EmailStatus == EmailStatus.Pending && n.ReadAt == null, cancellationToken);
        return
        [
            new RestoreLine(Area, "pending posts and e-mails",
                string.Create(CultureInfo.InvariantCulture, $"{posts} channel post(s) and {emails} notice(s) for the digest wait in the restored copy."), null, false),
        ];
    }

    public async Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken)
    {
        var lines = new List<RestoreLine>();
        foreach (var post in effects.Where(e => e.Kind == ChannelPostJob.EffectKind && e.EntityType == ChannelPostJob.EffectEntity).GroupBy(e => e.EntityId))
        {
            if (!ExternalEffects.MayExist(post))
            {
                continue;
            }

            var answered = post.Any(e => e.Phase == EffectPhase.Sent);
            var pending = await db.ChannelPosts.AsNoTracking().AnyAsync(p => p.Id == post.Key && p.Status == ChannelPostStatus.Pending, cancellationToken);
            if (!pending)
            {
                continue;
            }

            if (apply)
            {
                await db.ChannelPosts.Where(p => p.Id == post.Key && p.Status == ChannelPostStatus.Pending)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(p => p.Status, ChannelPostStatus.Sent)
                        .SetProperty(p => p.SentAt, post.Max(e => e.At))
                        .SetProperty(p => p.LockedUntil, (DateTimeOffset?)null)
                        .SetProperty(p => p.LeaseOwner, (Guid?)null)
                        .SetProperty(p => p.LastError, answered ? "Posted before the database restore (journal)." : "Posted before the database restore without an answer (journal)."),
                        cancellationToken);
            }

            lines.Add(new RestoreLine(Area, $"channel post {post.Key}",
                answered ? "Posted after the restore point; the restored copy still had it waiting." : "Sent after the restore point without an answer.",
                apply ? "Marked sent: it is not posted again." : "Would be marked sent.", !answered));
        }

        foreach (var digest in effects.Where(e => e.Kind == NotificationDigestJob.EffectKind && e.EntityType == NotificationDigestJob.EffectEntity).GroupBy(e => e.EntityId))
        {
            if (!ExternalEffects.MayExist(digest))
            {
                continue;
            }

            // The digest e-mailed what waited for this reader then: notices created before it that the copy still has pending.
            var sentAt = digest.Max(e => e.At);
            var notices = await db.Notifications
                .Where(n => n.RecipientId == digest.Key && n.EmailStatus == EmailStatus.Pending && n.CreatedAt <= sentAt)
                .ToListAsync(cancellationToken);
            if (notices.Count == 0)
            {
                continue;
            }

            if (apply)
            {
                notices.ForEach(n => n.MarkEmailSent(sentAt));
            }

            lines.Add(new RestoreLine(Area, $"digest for user {digest.Key}",
                string.Create(CultureInfo.InvariantCulture, $"A digest went out at {sentAt:yyyy-MM-dd HH:mm} UTC with {notices.Count} notice(s) the restored copy still has pending."),
                apply ? "Marked e-mailed: the next digest does not repeat them." : "Would be marked e-mailed.", false));
        }

        if (apply)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        return lines;
    }
}
