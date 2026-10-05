using Crm.Authorization;
using Crm.Notifications.Contracts;
using Crm.Notifications.Domain;
using Crm.Notifications.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Notifications.Features;

public sealed record NotificationDto(
    Guid Id,
    NotificationKind Kind,
    IReadOnlyDictionary<string, string> Parameters,
    Guid? OrganizationId,
    string? Link,
    DateOnly? DueDate,
    bool Warning,
    bool IsUnread,
    DateTimeOffset CreatedAt,
    string EmailStatus);

/// <summary>One page of the reader's notices (warnings first, newest first), how many unread and how many in all (DEV-12).</summary>
public sealed record NotificationListResponse(int Unread, IReadOnlyList<NotificationDto> Items, string? NextCursor = null, int TotalCount = 0);

public sealed record PreferencesResponse(bool EmailEnabled, int DigestHour, IReadOnlyList<NotificationKind> MutedKinds, bool EmailAvailable);

public sealed record PreferencesRequest(bool EmailEnabled, int DigestHour, IReadOnlyList<NotificationKind>? MutedKinds);

internal sealed class PreferencesRequestValidator : AbstractValidator<PreferencesRequest>
{
    public PreferencesRequestValidator()
    {
        RuleFor(x => x.DigestHour).InclusiveBetween(0, 23);
        RuleFor(x => x.MutedKinds).Must(kinds => kinds is null || kinds.Count <= 64).WithMessage("Too many muted kinds.");
        RuleForEach(x => x.MutedKinds).IsInEnum();
    }
}

/// <summary>Notices of the signed-in user, and the preferences behind the digest.</summary>
internal sealed class NotificationService(
    NotificationsDbContext db,
    ICurrentUser currentUser,
    IEnumerable<INotificationEmailSender> emailSenders,
    Microsoft.Extensions.Options.IOptions<NotificationsOptions> options,
    TimeProvider time) : INotificationsApi
{
    public async Task<bool> EnqueueAsync(NotificationRequest request, CancellationToken cancellationToken)
    {
        if (request.RecipientId == Guid.Empty)
        {
            return false;
        }

        if (await db.Notifications.AsNoTracking().AnyAsync(n => n.DedupeKey == request.DedupeKey, cancellationToken))
        {
            return false;
        }

        var notification = Notification.Create(request);
        var preference = await db.Preferences.AsNoTracking().SingleOrDefaultAsync(p => p.UserId == request.RecipientId, cancellationToken);
        if (preference is not null && preference.IsMuted(request.Kind))
        {
            notification.SuppressEmail("The reader muted this kind.");
        }

        db.Notifications.Add(notification);
        try
        {
            await db.SaveChangesAsync(cancellationToken);
            return true;
        }
        catch (DbUpdateException)
        {
            // Two workers enqueued the same notice; the unique dedupe key decided which one wins.
            db.Entry(notification).State = EntityState.Detached;
            return false;
        }
    }

    public async Task<NotificationListResponse> ListAsync(bool unreadOnly, int? limit, string? cursor, CancellationToken ct)
    {
        var userId = currentUser.UserId;
        var query = db.Notifications.AsNoTracking().Where(n => n.RecipientId == userId);
        if (unreadOnly)
        {
            query = query.Where(n => n.ReadAt == null);
        }

        var total = await query.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } after &&
            DateTimeOffset.TryParseExact(after.Then, "O", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var createdAt))
        {
            var warning = after.SortKey == "1";
            query = query.Where(n => (warning && !n.Warning) ||
                                     (n.Warning == warning && (n.CreatedAt < createdAt || (n.CreatedAt == createdAt && n.Id.CompareTo(after.Id) < 0))));
        }

        var take = Math.Clamp(limit ?? 50, 1, 200);
        var page = await query
            .OrderByDescending(n => n.Warning)
            .ThenByDescending(n => n.CreatedAt)
            .ThenByDescending(n => n.Id)
            .Take(take + 1)
            .ToListAsync(ct);
        var items = page.Take(take).ToList();
        var last = items.LastOrDefault();
        var next = page.Count > take && last is not null
            ? new KeysetCursor(last.Warning ? "1" : "0", last.Id, last.CreatedAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture)).Encode()
            : null;
        var unread = await db.Notifications.AsNoTracking().CountAsync(n => n.RecipientId == userId && n.ReadAt == null, ct);
        // A notice keeps its parameters; the money among them is shown only to a reader who may see money now (DEV-12-AC04).
        var seesMoney = currentUser.HasPermission(Permissions.FinanceRead);
        return new NotificationListResponse(unread, items.Select(n => ToDto(n, seesMoney)).ToList(), next, total);
    }

    public async Task<Result> MarkReadAsync(Guid id, CancellationToken ct)
    {
        var userId = currentUser.UserId;
        if (await db.Notifications.SingleOrDefaultAsync(n => n.Id == id && n.RecipientId == userId, ct) is not { } notification)
        {
            return Error.NotFound("NOT_NOTIFICATION_NOT_FOUND", $"Notification {id} was not found.");
        }

        notification.MarkRead(time.GetUtcNow());
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<int> MarkAllReadAsync(CancellationToken ct)
    {
        var userId = currentUser.UserId;
        var now = time.GetUtcNow();
        return await db.Notifications
            .Where(n => n.RecipientId == userId && n.ReadAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(n => n.ReadAt, now), ct);
    }

    public async Task<PreferencesResponse> GetPreferencesAsync(CancellationToken ct)
    {
        var userId = currentUser.UserId;
        var preference = await db.Preferences.AsNoTracking().SingleOrDefaultAsync(p => p.UserId == userId, ct);
        return ToDto(preference);
    }

    public async Task<PreferencesResponse> SavePreferencesAsync(PreferencesRequest request, CancellationToken ct)
    {
        var userId = currentUser.UserId ?? throw new InvalidOperationException("Notifications need a signed-in user.");
        var preference = await db.Preferences.SingleOrDefaultAsync(p => p.UserId == userId, ct);
        if (preference is null)
        {
            preference = NotificationPreference.Default(userId);
            db.Preferences.Add(preference);
        }

        preference.Update(request.EmailEnabled, request.DigestHour, request.MutedKinds ?? []);
        await db.SaveChangesAsync(ct);
        return ToDto(preference);
    }

    private PreferencesResponse ToDto(NotificationPreference? preference) => new(
        preference?.EmailEnabled ?? true,
        preference?.DigestHour ?? NotificationPreference.DefaultDigestHour,
        preference?.MutedKinds ?? [],
        options.Value.EmailEnabled && emailSenders.Any(sender => sender.IsConfigured));

    private static NotificationDto ToDto(Notification n, bool seesMoney) => new(
        n.Id, n.Kind, seesMoney ? n.Parameters : NotificationTexts.WithoutMoney(n.Parameters), n.OrganizationId, n.Link, n.DueDate, n.Warning, n.IsUnread,
        n.CreatedAt, n.EmailStatus.ToString());
}
