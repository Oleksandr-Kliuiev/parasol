using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.Service.Contracts;
using Crm.Service.Features;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;

namespace Crm.Service;

/// <summary>Alerts read by their ids (M45): what a bulk dialog reads when it opens.</summary>
public sealed record AlertLookupRequest(IReadOnlyList<Guid>? Ids);

internal sealed class AlertLookupRequestValidator : AbstractValidator<AlertLookupRequest>
{
    public AlertLookupRequestValidator() =>
        RuleFor(x => x.Ids).NotNull()
            .Must(ids => ids is { Count: > 0 and <= AlertQueries.SelectionLimit })
            .WithMessage($"Ask for 1 to {AlertQueries.SelectionLimit} alerts.");
}

/// <summary>
/// Alerts across customers (M38) and what a person does with them in Parasoll: the queue with its filters (M45: the source and an
/// age), one alert, the urgent list of My day, hiding and showing one alert (M40), confirming a closing its source made (M41), and
/// (M45) "all that match", alerts read by id and hiding or showing many at once. What is done at an alert's source goes through the
/// vendor action path (<c>/api/v1/actions</c>), never through these.
/// </summary>
internal static class AlertEndpoints
{
    /// <summary>A bulk change names at most 500 alerts with their ETags: about 50 KB of JSON.</summary>
    private const long BulkBodyLimit = 128 * 1024;

    public static RouteGroupBuilder MapAlertEndpoints(this RouteGroupBuilder group)
    {
        // M38: one list for a customer's tab and the queue across customers; organizationId narrows it to one customer.
        group.MapGet("/alerts", async (
                Guid? organizationId, AlertState? state, AlertSeverity? severity, Guid? deviceId, string? q, string? cursor, int? limit, bool? hidden,
                string? system, int? olderThanDays, int? newerThanDays, AlertQueries alerts, CancellationToken ct) =>
                (await alerts.ListAsync(
                    new AlertFilter(organizationId, state, hidden == true, severity, deviceId, q, system, olderThanDays, newerThanDays), cursor, limit, ct))
                    .ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        // M45: "all that match" the queue's filters, for a bulk action: at most 500, in the queue's order, with how many matched.
        group.MapGet("/alerts/selection", async (
                Guid? organizationId, AlertState? state, AlertSeverity? severity, Guid? deviceId, string? q, bool? hidden, string? system, int? olderThanDays,
                int? newerThanDays, AlertQueries alerts, CancellationToken ct) =>
                (await alerts.SelectAsync(
                    new AlertFilter(organizationId, state, hidden == true, severity, deviceId, q, system, olderThanDays, newerThanDays), ct))
                    .ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceWrite);

        // M45: the chosen alerts as they are now, with the ETags a bulk hide or show sends back. A read, though it carries ids in a body.
        group.MapPost("/alerts/lookup", async (AlertLookupRequest request, AlertQueries alerts, CancellationToken ct) =>
                Results.Ok(await alerts.LookupAsync(request.Ids!, ct)))
            .Validate<AlertLookupRequest>()
            .WithMetadata(new RequestSizeLimitAttribute(BulkBodyLimit))
            .RequirePermission(Permissions.ServiceWrite);

        // M45: many alerts hidden until one day with one reason, or shown again; each checked against the ETag its dialog read.
        group.MapPost("/alerts/hide", async (HideAlertsRequest request, AlertBulkHiding hiding, CancellationToken ct) =>
                (await hiding.HideAsync(request, ct)).ToHttpResult(Results.Ok))
            .Validate<HideAlertsRequest>()
            .WithMetadata(new RequestSizeLimitAttribute(BulkBodyLimit))
            .RequirePermission(Permissions.ServiceWrite);

        group.MapPost("/alerts/show", async (ShowAlertsRequest request, AlertBulkHiding hiding, CancellationToken ct) =>
                (await hiding.ShowAsync(request, ct)).ToHttpResult(Results.Ok))
            .Validate<ShowAlertsRequest>()
            .WithMetadata(new RequestSizeLimitAttribute(BulkBodyLimit))
            .RequirePermission(Permissions.ServiceWrite);

        // M40: hidden in Parasoll until a day, with a reason, and shown again; the source is never asked (it cannot snooze).
        group.MapPost("/alerts/{id:guid}/hide", (Guid id, HideAlertRequest request, HttpRequest http, AlertHiding hiding, AlertQueries alerts,
                    CancellationToken ct) => ChangeAlert(http, alerts, ifMatch => hiding.HideAsync(id, request, ifMatch, ct), ct))
            .Validate<HideAlertRequest>()
            .RequirePermission(Permissions.ServiceWrite);

        group.MapPost("/alerts/{id:guid}/show", (Guid id, HttpRequest http, AlertHiding hiding, AlertQueries alerts, CancellationToken ct) =>
                ChangeAlert(http, alerts, ifMatch => hiding.ShowAsync(id, ifMatch, ct), ct))
            .RequirePermission(Permissions.ServiceWrite);

        // M41: an urgent alert its source closed waits for a person; this confirms the closing, with the hold's ETag.
        group.MapPost("/alerts/{id:guid}/confirm-closed", (Guid id, HttpRequest http, AlertHiding hiding, AlertQueries alerts, CancellationToken ct) =>
                ChangeAlert(http, alerts, ifMatch => hiding.ConfirmClosedAsync(id, ifMatch, ct), ct))
            .RequirePermission(Permissions.ServiceWrite);

        group.MapGet("/alerts/urgent", async (int? limit, AlertQueries alerts, CancellationToken ct) =>
                Results.Ok(await alerts.UrgentAsync(limit, ct)))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/alerts/{id:guid}", async (Guid id, AlertQueries alerts, CancellationToken ct) =>
                (await alerts.GetAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        return group;
    }

    /// <summary>A change of an alert's status in Parasoll: the ETag the person saw, then the alert as it is now.</summary>
    private static async Task<IResult> ChangeAlert(
        HttpRequest http, AlertQueries alerts, Func<string, Task<Result<Guid>>> change, CancellationToken ct)
    {
        if (http.GetIfMatch() is not { } ifMatch)
        {
            return HeaderExtensions.PreconditionRequired();
        }

        var changed = await change(ifMatch);
        return changed.IsSuccess ? (await alerts.GetAsync(changed.Value, ct)).ToHttpResult(Results.Ok) : changed.Error!.ToProblem();
    }
}
