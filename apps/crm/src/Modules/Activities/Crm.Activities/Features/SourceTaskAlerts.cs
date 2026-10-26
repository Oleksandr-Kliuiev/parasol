using System.Security.Cryptography;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Service.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;

namespace Crm.Activities.Features;

/// <summary>
/// An alert made into a task (M38): the dialog's preview, the create (first writer wins, a repeat returns the same task), the batch
/// lookup a page of alerts asks once, and a task's source read again. Every read of the alert is a fresh read of the Service mirror;
/// the receipt names the alert as its source does, so a task finds its alert again after the mirror was rebuilt.
/// </summary>
internal sealed class AlertTaskService(IServiceApi service, IActivitiesApi activities, ICustomersApi customers, IUserDirectory users,
    ICurrentUser currentUser)
{
    private bool CanRead => currentUser.UserId is not null && currentUser.HasPermission(Permissions.ActivitiesRead)
        && currentUser.HasPermission(Permissions.ServiceRead);

    private bool CanWrite => CanRead && currentUser.HasPermission(Permissions.ActivitiesWrite);

    public async Task<Result<AlertTaskPreview>> PreviewAsync(Guid alertId, CancellationToken ct)
    {
        if (!CanRead) return Forbidden();
        var read = await ReadAsync(alertId, ct);
        if (!read.IsSuccess) return read.Error!;
        var (alert, source) = read.Value;
        var existing = await activities.FindSourceTaskAsync(source, alert.OrganizationId, ct);
        if (!existing.IsSuccess) return existing.Error!;
        var task = existing.Value is { } found ? await ViewAsync(found, ct) : null;
        return new AlertTaskPreview(await SourceAsync(alert, ct), Fingerprint(alert), SourceTaskIdentityRules.SuggestedSubject(alert.Title),
            PriorityOf(alert), task, CanCreate: task is null && IsOpen(alert) && CanWrite);
    }

    public async Task<Result<AlertTaskOutcome>> CreateAsync(AlertTaskRequest request, CancellationToken ct)
    {
        if (!CanWrite) return Forbidden();
        var read = await ReadAsync(request.AlertId, ct);
        if (!read.IsSuccess) return read.Error!;
        var (alert, source) = read.Value;
        var existing = await activities.FindSourceTaskAsync(source, alert.OrganizationId, ct);
        if (!existing.IsSuccess) return existing.Error!;
        // The first writer owns the subject, the assignment and the due date; a repeat, or a colleague's later try, gets that task.
        if (existing.Value is { } known) return new AlertTaskOutcome("EXISTING", await ViewAsync(known, ct));
        if (Fingerprint(alert) != request.ExpectedFingerprint)
            return Error.Conflict("ACT_SOURCE_ALERT_CHANGED", "The alert changed after it was read. Read it again before assigning it.");
        if (!IsOpen(alert))
            return Error.Conflict("ACT_SOURCE_ALERT_RESOLVED", "The alert is resolved in its source. Only open alerts become tasks.");
        var created = await activities.CreateTaskOnceAsync(new(source, alert.OrganizationId, request.AssigneeId, request.DueAt,
            PriorityOf(alert), request.Subject), ct);
        if (!created.IsSuccess) return created.Error!;
        return new AlertTaskOutcome(created.Value.Created ? "CREATED" : "EXISTING", await ViewAsync(created.Value, ct));
    }

    /// <summary>The tasks of one page of alerts, in one batch: no alert read or task lookup per row.</summary>
    public async Task<Result<AlertTaskLookup>> LookupAsync(AlertTaskLookupRequest request, CancellationToken ct)
    {
        if (!CanRead) return Forbidden();
        var alerts = await service.GetAlertsAsync(request.AlertIds.Distinct().ToList(), ct);
        var asked = alerts.Values.Select(alert => (Alert: alert, Source: IdentityOf(alert))).Where(a => a.Source is not null)
            .Select(a => (a.Alert, Source: a.Source!)).ToList();
        if (asked.Count == 0) return new AlertTaskLookup([]);
        var found = await activities.FindSourceTasksAsync(asked.GroupBy(a => a.Alert.OrganizationId)
            .Select(group => new SourceTaskQuery(group.Key, group.Select(a => a.Source).ToList())).ToList(), ct);
        if (!found.IsSuccess) return found.Error!;
        var alertOf = asked.ToDictionary(a => (a.Alert.OrganizationId, a.Source), a => a.Alert.Id);
        return new AlertTaskLookup(found.Value.Where(f => alertOf.ContainsKey((f.OrganizationId, f.Source)))
            .Select(f => new AlertTaskLink(alertOf[(f.OrganizationId, f.Source)], View(f.Task, f.AssigneeName))).ToList());
    }

    /// <summary>
    /// The alert behind a task, read now. An alert stored under another customer than the receipt's, or for another organization
    /// than the task's, is not this task's source any more and is not shown.
    /// </summary>
    public async Task<Result<TaskSourceView>> SourceOfTaskAsync(Guid activityId, CancellationToken ct)
    {
        var details = await activities.GetSourceTaskAsync(activityId, ct);
        if (!details.IsSuccess) return details.Error!;
        var (source, task) = (details.Value.Source, details.Value.Task);
        var view = await ViewAsync(task, ct);
        var alert = await service.GetAlertAsync(source.System, source.ExternalId, ct);
        return alert is not null && alert.ExternalCustomerId == source.ExternalCustomerId && alert.OrganizationId == task.OrganizationId
            ? new TaskSourceView(view, await SourceAsync(alert, ct))
            : new TaskSourceView(view, null);
    }

    /// <summary>The fields an employee reviews before assigning: a change to any of them makes the reviewed preview stale.</summary>
    internal static string Fingerprint(AlertRef alert) => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
        new object?[]
        {
            "AlertTaskV1", alert.Id, alert.OrganizationId, alert.System, alert.Kind.ToString(), alert.ExternalId, alert.ExternalCustomerId,
            alert.Title, alert.Severity.ToString(), IsOpen(alert), alert.DeviceName, alert.CreatedAtSource.ToUnixTimeSeconds(),
        })));

    internal static ActivityPriority PriorityOf(AlertRef alert) =>
        alert.Severity == AlertSeverity.Critical ? ActivityPriority.High : ActivityPriority.Normal;

    /// <summary>Open in its source: an acknowledged alert still is, a resolved one is not.</summary>
    internal static bool IsOpen(AlertRef alert) => alert.State != AlertState.Resolved;

    /// <summary>The receipt identity of an alert, or none for a source the CRM makes no tasks from.</summary>
    internal static SourceTaskIdentity? IdentityOf(AlertRef alert) =>
        alert.ExternalCustomerId is { } customer
        && SourceTaskIdentityRules.ForAlert(alert.System, customer, alert.ExternalId) is var source
        && SourceTaskIdentityRules.IsValid(source) ? source : null;

    private async Task<Result<(AlertRef Alert, SourceTaskIdentity Source)>> ReadAsync(Guid alertId, CancellationToken ct)
    {
        if (alertId == Guid.Empty || await service.GetAlertAsync(alertId, ct) is not { } alert)
            return Error.NotFound("ACT_SOURCE_ALERT_NOT_FOUND", "The alert is not stored in the CRM.");
        return IdentityOf(alert) is { } source ? (alert, source) : SourceTaskApi.Unsupported();
    }

    private async Task<AlertTaskSource> SourceAsync(AlertRef alert, CancellationToken ct)
    {
        var names = await customers.GetOrganizationNamesAsync([alert.OrganizationId], ct);
        return new AlertTaskSource(alert.Id, alert.OrganizationId, names.GetValueOrDefault(alert.OrganizationId), alert.System, alert.Kind,
            alert.Title, alert.Severity, alert.State, alert.DeviceName, alert.DeviceId, alert.CreatedAtSource, alert.Url, alert.ResolvedAt,
            alert.Rule, CoverageGaps.ReadFacts(alert.Facts));
    }

    private async Task<AlertTaskView> ViewAsync(SourceTaskRef task, CancellationToken ct)
    {
        var name = task.AssigneeId is { } id && (await users.GetUsersAsync([id], ct)).TryGetValue(id, out var user) ? user.DisplayName : null;
        return View(task, name);
    }

    private static AlertTaskView View(SourceTaskRef task, string? assigneeName) => new(task.ActivityId, task.OrganizationId, task.Subject,
        task.Status, task.AssigneeId is { } id ? new RefDto(id, assigneeName ?? string.Empty) : null, task.DueAt, task.IsAvailable);

    private static Error Forbidden() => Error.Forbidden("ACT_SOURCE_TASK_FORBIDDEN", "Service and CRM activity access are required.");
}
