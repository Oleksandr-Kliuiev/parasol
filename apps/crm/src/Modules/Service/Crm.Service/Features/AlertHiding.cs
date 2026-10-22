using System.Linq.Expressions;
using Crm.Infrastructure.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>A person hides an alert in Parasoll until a day (M40), and says why.</summary>
public sealed record HideAlertRequest(DateOnly Until, string Reason);

internal sealed class HideAlertRequestValidator : AbstractValidator<HideAlertRequest>
{
    public HideAlertRequestValidator()
    {
        RuleFor(x => x.Reason).Must(r => !string.IsNullOrWhiteSpace(r)).WithMessage("Say why the alert is hidden.")
            .MaximumLength(AlertHold.ReasonLength);
    }
}

/// <summary>
/// The open alerts as a person sees them now (M40): open in their source and not hidden in Parasoll. Every count of open alerts
/// goes through it, so a hidden alert never alarms anyone until its day comes.
/// </summary>
internal static class AlertVisibility
{
    public static Expression<Func<Alert, bool>> OpenNow(DateTimeOffset now) =>
        a => a.State == AlertState.Open && !(a.Hold != null && a.Hold.Until > now);

    /// <summary>Hidden now: still open in the source, hidden in Parasoll until a later time.</summary>
    public static Expression<Func<Alert, bool>> HiddenNow(DateTimeOffset now) =>
        a => a.State != AlertState.Resolved && a.Hold != null && a.Hold.Until > now;
}

/// <summary>
/// The CRM's own status of an alert (M40): hidden in Parasoll until a day, with a reason, and shown again before it. The source
/// cannot snooze an alert through its API, so this never reaches Atera: the alert stays open there and comes back here by itself
/// on its day. Each change is kept as an <see cref="AlertTransition"/>, which the audit records.
/// </summary>
internal sealed class AlertHiding(ServiceDbContext db, TimeProvider time, ICurrentUser user)
{
    /// <summary>How far ahead an alert may be hidden: a year, so nothing is forgotten for good.</summary>
    public const int MaxDays = 365;

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<Result<Guid>> HideAsync(Guid id, HideAlertRequest request, string ifMatch, CancellationToken ct)
    {
        var loaded = await LoadAsync(id, ifMatch, ct);
        if (!loaded.IsSuccess)
        {
            return loaded.Error!;
        }

        var alert = loaded.Value;
        if (alert.State == AlertState.Resolved)
        {
            return Error.Validation("SRV_ALERT_RESOLVED", "A resolved alert is not hidden.");
        }

        var now = time.GetUtcNow();
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Oslo).DateTime);
        if (request.Until <= today || request.Until > today.AddDays(MaxDays))
        {
            return Error.Validation("SRV_ALERT_HIDE_DATE", $"Choose a day after today and at most {MaxDays} days ahead.");
        }

        // The alert comes back at the start of the chosen day in Oslo.
        var start = request.Until.ToDateTime(TimeOnly.MinValue);
        var until = new DateTimeOffset(start, Oslo.GetUtcOffset(start));
        var reason = request.Reason.Trim();
        alert.Hide(until, reason, user.UserId, now);
        db.AlertTransitions.Add(AlertTransition.Hidden(alert.Id, until, alert.EnsureHold().Reason!));
        return await SaveAsync(alert, ct);
    }

    public async Task<Result<Guid>> ShowAsync(Guid id, string ifMatch, CancellationToken ct)
    {
        var loaded = await LoadAsync(id, ifMatch, ct);
        if (!loaded.IsSuccess)
        {
            return loaded.Error!;
        }

        var alert = loaded.Value;
        if (!alert.Unhide(time.GetUtcNow()))
        {
            return Error.Validation("SRV_ALERT_NOT_HIDDEN", "The alert is not hidden.");
        }

        db.AlertTransitions.Add(AlertTransition.Shown(alert.Id));
        return await SaveAsync(alert, ct);
    }

    /// <summary>
    /// A person confirms that an urgent alert its source closed is done with (M41): it is resolved here, and the transition records
    /// who. Under the source's lock, so the confirmation never crosses a read of that source being stored; a read that lists the alert
    /// again before it clears the mark, and the confirmation is then refused.
    /// </summary>
    public async Task<Result<Guid>> ConfirmClosedAsync(Guid id, string ifMatch, CancellationToken ct)
    {
        if (await db.Alerts.AsNoTracking().Where(a => a.Id == id).Select(a => a.System).SingleOrDefaultAsync(ct) is not { } system)
        {
            return Error.NotFound("SRV_ALERT_NOT_FOUND", "The alert is not stored in the CRM.");
        }

        var resource = "service-alerts:" + system;
        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async c =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(c);
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={resource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=30000;
                IF @r < 0 THROW 51000, 'A read of these alerts is being stored.', 1;
                """, c);
            var loaded = await LoadAsync(id, ifMatch, c);
            if (!loaded.IsSuccess)
            {
                return loaded.Error!;
            }

            var alert = loaded.Value;
            if (!alert.ConfirmClosed(time.GetUtcNow()))
            {
                return Error.Validation("SRV_ALERT_NOT_CLOSED_AT_SOURCE", "The source has not closed this alert, or it is closed already.");
            }

            db.AlertTransitions.Add(AlertTransition.Confirmed(alert.Id));
            var saved = await SaveAsync(alert, c);
            if (saved.IsSuccess)
            {
                await transaction.CommitAsync(c);
            }

            return saved;
        }, ct);
    }

    private async Task<Result<Guid>> SaveAsync(Alert alert, CancellationToken ct)
    {
        try
        {
            await db.SaveChangesAsync(ct);
            return alert.Id;
        }
        catch (DbUpdateException exception) when (exception.IsUniqueViolation())
        {
            // Two people added the hold of an alert stored without one at the same moment: the later one decides again.
            return Error.PreconditionFailed("CONCURRENCY_CONFLICT", "The alert changed. Read it again and decide again.");
        }
    }

    /// <summary>
    /// The alert with its status as the person saw it. The ETag is the hold's: a read of the source passing by changes the alert's
    /// row, not this, while someone else hiding or showing the alert, or the alert opening again, makes the change stale.
    /// </summary>
    private async Task<Result<Alert>> LoadAsync(Guid id, string ifMatch, CancellationToken ct)
    {
        if (await db.Alerts.Include(a => a.Hold).SingleOrDefaultAsync(a => a.Id == id, ct) is not { } alert)
        {
            return Error.NotFound("SRV_ALERT_NOT_FOUND", "The alert is not stored in the CRM.");
        }

        // An alert an earlier release stored without its hold (a rollback in between) is checked against its own version, once:
        // the decision adds the hold.
        var versioned = (object?)alert.Hold ?? alert;
        if (!db.ApplyIfMatch(versioned, ifMatch))
        {
            return Error.Validation("SRV_ALERT_ETAG_INVALID", "The If-Match header is not an ETag of this alert.");
        }

        return db.IsStale(versioned)
            ? Error.PreconditionFailed("CONCURRENCY_CONFLICT", "The alert changed. Read it again and decide again.")
            : alert;
    }
}
