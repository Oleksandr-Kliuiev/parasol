using System.Text.Json.Serialization;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Service.Contracts;
using FluentValidation;

namespace Crm.Activities.Features;

/// <summary>The alert a task is, or would be, made from, as the Service module stores it at the moment of the read.</summary>
public sealed record AlertTaskSource(
    Guid Id,
    Guid OrganizationId,
    string? OrganizationName,
    string System,
    AlertKind Kind,
    string Title,
    AlertSeverity Severity,
    AlertState State,
    string? DeviceName,
    Guid? DeviceId,
    DateTimeOffset CreatedAt,
    string? Url,
    DateTimeOffset? ResolvedAt);

/// <summary>The task an alert has, as a row or a dialog shows it; empty fields once the task was deleted or erased.</summary>
public sealed record AlertTaskView(
    Guid Id,
    Guid OrganizationId,
    string? Subject,
    ActivityStatus Status,
    RefDto? Assignee,
    DateTimeOffset? DueAt,
    bool IsAvailable);

/// <summary>
/// What assigning an alert would do: the alert as read now, its <paramref name="Fingerprint"/> (the create must name it, so a changed
/// alert is reviewed again), the subject offered, the priority the alert gives, and the task it already has.
/// </summary>
public sealed record AlertTaskPreview(
    AlertTaskSource Alert,
    string Fingerprint,
    string Subject,
    ActivityPriority Priority,
    AlertTaskView? Task,
    bool CanCreate);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AlertTaskRequest(Guid AlertId, Guid AssigneeId, DateTimeOffset? DueAt, string Subject, string ExpectedFingerprint);

/// <summary><paramref name="Status"/> is <c>CREATED</c>, or <c>EXISTING</c> when the alert already had a task (first writer wins).</summary>
public sealed record AlertTaskOutcome(string Status, AlertTaskView Task);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AlertTaskLookupRequest(IReadOnlyList<Guid> AlertIds);

public sealed record AlertTaskLink(Guid AlertId, AlertTaskView Task);

/// <summary>The tasks some alerts of a page already have; an alert without one is left out.</summary>
public sealed record AlertTaskLookup(IReadOnlyList<AlertTaskLink> Items);

/// <summary>
/// A task's source read now: the alert as stored at this moment, or none when it is no longer stored for the task's customer (the
/// customer was linked to another one in the source, or the alert was removed).
/// </summary>
public sealed record TaskSourceView(AlertTaskView Task, AlertTaskSource? Alert);

internal static class AlertTaskLimits
{
    /// <summary>One page of the alert queue or of a customer's alerts.</summary>
    public const int LookupAlerts = 50;
}

internal sealed class AlertTaskRequestValidator : AbstractValidator<AlertTaskRequest>
{
    public AlertTaskRequestValidator()
    {
        RuleFor(x => x.AlertId).NotEmpty();
        RuleFor(x => x.AssigneeId).NotEmpty().WithMessage("Choose who gets the task.");
        RuleFor(x => x.Subject).Must(subject => SourceTaskIdentityRules.Subject(subject) is not null)
            .WithMessage($"Write a subject of at most {SourceTaskIdentityRules.SubjectLength} characters on one line.");
        RuleFor(x => x.DueAt).Must(due => due is null || due.Value.Year is >= 2000 and <= 2100).WithMessage("Choose a due date between 2000 and 2100.");
        RuleFor(x => x.ExpectedFingerprint).NotEmpty().Matches(@"\A[0-9a-f]{64}\z").WithMessage("Read the alert again before assigning it.");
    }
}

internal sealed class AlertTaskLookupRequestValidator : AbstractValidator<AlertTaskLookupRequest>
{
    public AlertTaskLookupRequestValidator()
    {
        RuleFor(x => x.AlertIds).NotNull()
            .Must(ids => ids is { Count: > 0 and <= AlertTaskLimits.LookupAlerts })
            .WithMessage($"Ask for the tasks of 1 to {AlertTaskLimits.LookupAlerts} alerts.");
        RuleForEach(x => x.AlertIds).NotEmpty();
    }
}
