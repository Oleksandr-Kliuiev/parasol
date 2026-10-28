using Crm.Infrastructure.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>One alert of a bulk change (M45) and the ETag of its status in Parasoll as the person's dialog read it.</summary>
public sealed record AlertVersion(Guid Id, string? Etag);

/// <summary>Hides many alerts in Parasoll until one day, with one reason for all of them (M45).</summary>
public sealed record HideAlertsRequest(IReadOnlyList<AlertVersion>? Alerts, DateOnly Until, string? Reason);

/// <summary>Shows many hidden alerts again (M45): the way back from a bulk hide.</summary>
public sealed record ShowAlertsRequest(IReadOnlyList<AlertVersion>? Alerts);

/// <summary>What a bulk change did to one alert (M45).</summary>
public enum AlertBulkOutcome
{
    /// <summary>Hidden until the day, with the reason.</summary>
    Hidden,

    /// <summary>Shown again.</summary>
    Shown,

    /// <summary>Left as it was: its source no longer reports it open.</summary>
    Resolved,

    /// <summary>Left as it was: it is not hidden now (its day came, or someone showed it).</summary>
    NotHidden,

    /// <summary>Left as it was: someone changed its status after the dialog read it, or it opened again.</summary>
    Changed,

    /// <summary>The CRM does not store such an alert.</summary>
    NotFound,
}

/// <summary>
/// What became of one alert; a changed one carries the ETag of its status after the change, so the way back (showing again what was
/// just hidden) names exactly that version and leaves an alert someone decided about since as it is.
/// </summary>
public sealed record AlertBulkItem(Guid Id, AlertBulkOutcome Outcome, string? Etag = null);

/// <summary>Every alert asked for, once and in the order asked, with what happened to it; <c>Applied</c> counts those changed.</summary>
public sealed record AlertBulkResult(IReadOnlyList<AlertBulkItem> Items, int Applied);

internal static class AlertVersionRules
{
    public static void Apply<T>(IRuleBuilderInitial<T, IReadOnlyList<AlertVersion>?> alerts) =>
        alerts.NotNull()
            .Must(list => list is { Count: > 0 and <= AlertQueries.SelectionLimit })
            .WithMessage($"Name 1 to {AlertQueries.SelectionLimit} alerts.")
            .Must(list => list is null || list.All(a => a is not null && a.Id != Guid.Empty && a.Etag is { Length: > 0 and <= 64 }))
            .WithMessage("Every alert needs its id and the ETag of its status.");
}

internal sealed class HideAlertsRequestValidator : AbstractValidator<HideAlertsRequest>
{
    public HideAlertsRequestValidator()
    {
        AlertVersionRules.Apply(RuleFor(x => x.Alerts));
        RuleFor(x => x.Reason).Must(r => !string.IsNullOrWhiteSpace(r)).WithMessage("Say why the alerts are hidden.")
            .MaximumLength(AlertHold.ReasonLength);
    }
}

internal sealed class ShowAlertsRequestValidator : AbstractValidator<ShowAlertsRequest>
{
    public ShowAlertsRequestValidator() => AlertVersionRules.Apply(RuleFor(x => x.Alerts));
}

/// <summary>
/// Hides or shows many alerts at once (M45), each the way <see cref="AlertHiding"/> changes one: checked against the version of its
/// status the person's dialog read, a resolved alert never hidden, every change kept as an <see cref="AlertTransition"/>. An alert
/// that cannot be changed does not stop the others: each comes back with what happened to it. The changes are saved together; when
/// someone changes some of the alerts at the same moment, those are left as they are and the rest are saved again.
/// </summary>
internal sealed class AlertBulkHiding(ServiceDbContext db, TimeProvider time, ICurrentUser user)
{
    /// <summary>How often the save is tried again without the alerts someone else changed at that moment.</summary>
    private const int Rounds = 3;

    public async Task<Result<AlertBulkResult>> HideAsync(HideAlertsRequest request, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var until = AlertHiding.HiddenUntil(request.Until, now);
        if (!until.IsSuccess)
        {
            return until.Error!;
        }

        var reason = request.Reason!.Trim();
        var by = user.UserId;
        return await ChangeAsync(request.Alerts!, AlertBulkOutcome.Hidden,
            // Hidden so by this person already: the same request again after its answer was lost, done whatever the dialog read.
            alert => alert.State != AlertState.Resolved && alert.Hold is { } hold && hold.Until == until.Value && hold.Reason == reason && hold.By == by,
            alert =>
            {
                if (alert.State == AlertState.Resolved)
                {
                    return AlertBulkOutcome.Resolved;
                }

                alert.Hide(until.Value, reason, by, now);
                db.AlertTransitions.Add(AlertTransition.Hidden(alert.Id, until.Value, alert.EnsureHold().Reason!));
                return AlertBulkOutcome.Hidden;
            }, ct);
    }

    public Task<Result<AlertBulkResult>> ShowAsync(ShowAlertsRequest request, CancellationToken ct) =>
        ChangeAsync(request.Alerts!, AlertBulkOutcome.Shown, _ => false, alert =>
        {
            if (!alert.Unhide(time.GetUtcNow()))
            {
                return alert.State == AlertState.Resolved ? AlertBulkOutcome.Resolved : AlertBulkOutcome.NotHidden;
            }

            db.AlertTransitions.Add(AlertTransition.Shown(alert.Id));
            return AlertBulkOutcome.Shown;
        }, ct);

    /// <param name="done">True when an alert is already as this person asks: it counts as done, whatever version the dialog read.</param>
    private async Task<Result<AlertBulkResult>> ChangeAsync(
        IReadOnlyList<AlertVersion> asked, AlertBulkOutcome applied, Func<Alert, bool> done, Func<Alert, AlertBulkOutcome> change, CancellationToken ct)
    {
        var order = new List<Guid>();
        var versions = new Dictionary<Guid, string>();
        foreach (var item in asked.Where(item => versions.TryAdd(item.Id, item.Etag!)))
        {
            order.Add(item.Id);
        }

        var outcomes = new Dictionary<Guid, AlertBulkOutcome>();
        var etags = new Dictionary<Guid, string>();
        var pending = order;
        for (var round = 0; round < Rounds && pending.Count > 0; round++)
        {
            db.ChangeTracker.Clear();
            var ids = pending;
            var alerts = await db.Alerts.Include(a => a.Hold).Where(a => ids.Contains(a.Id)).ToDictionaryAsync(a => a.Id, ct);
            var changed = new List<Guid>();
            foreach (var id in pending)
            {
                if (!alerts.TryGetValue(id, out var alert))
                {
                    outcomes[id] = AlertBulkOutcome.NotFound;
                    continue;
                }

                // As for one alert (M40): the hold's version, which only decisions and a new occurrence move; an alert an earlier
                // release stored without its hold against its own, once.
                var versioned = (object?)alert.Hold ?? alert;
                if (!db.ApplyIfMatch(versioned, versions[id]))
                {
                    return Error.Validation("SRV_ALERT_ETAG_INVALID", "An ETag is not one of an alert's status.");
                }

                outcomes[id] = done(alert) ? applied : db.IsStale(versioned) ? AlertBulkOutcome.Changed : change(alert);
                if (outcomes[id] == applied)
                {
                    changed.Add(id);
                }
            }

            // The holds this save adds, for alerts an earlier release stored without one.
            var added = db.ChangeTracker.Entries<AlertHold>().Where(e => e.State == EntityState.Added).Select(e => e.Entity.Id).ToList();
            try
            {
                await db.SaveChangesAsync(ct);
                foreach (var id in changed)
                {
                    etags[id] = db.GetETag(alerts[id].Hold!);
                }

                pending = [];
            }
            catch (DbUpdateException exception) when (exception is DbUpdateConcurrencyException || exception.IsUniqueViolation())
            {
                // Someone decided about some of them at this very moment (or added the hold of one stored without it): nothing was
                // saved, those are left as they are, and the others are decided again as they are now. A refused insert names every
                // row of its batch of statements, so the holds someone else added first are read instead.
                var lost = exception is DbUpdateConcurrencyException
                    ? exception.Entries.Select(entry => entry.Entity switch
                    {
                        AlertHold hold => hold.Id,
                        Alert alert => alert.Id,
                        AlertTransition transition => transition.AlertId,
                        _ => (Guid?)null,
                    }).OfType<Guid>().ToHashSet()
                    : (await db.AlertHolds.AsNoTracking().Where(h => added.Contains(h.Id)).Select(h => h.Id).ToListAsync(ct)).ToHashSet();
                if (lost.Count == 0)
                {
                    throw;
                }

                foreach (var id in lost)
                {
                    outcomes[id] = AlertBulkOutcome.Changed;
                }

                pending = changed.Where(id => !lost.Contains(id)).ToList();
            }
        }

        // Alerts still waiting after the last round were not saved: they changed under the request each time.
        foreach (var id in pending)
        {
            outcomes[id] = AlertBulkOutcome.Changed;
        }

        var items = order.Select(id => new AlertBulkItem(id, outcomes[id], outcomes[id] == applied ? etags.GetValueOrDefault(id) : null)).ToList();
        return new AlertBulkResult(items, items.Count(i => i.Outcome == applied));
    }
}
