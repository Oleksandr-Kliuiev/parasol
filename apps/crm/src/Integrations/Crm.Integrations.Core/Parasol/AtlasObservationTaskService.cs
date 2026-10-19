using Crm.Activities.Contracts;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;

namespace Crm.Integrations.Core.Parasol;

public sealed class AtlasObservationTaskService(AtlasObservationSourceReader reader, IActivitiesApi activities,
    CustomerIdentityService identities, CustomerIdentityGuard guard, ICurrentUser user)
{
    public async Task<Result<AtlasObservationTaskPreview>> PreviewAsync(Guid customerId, string observationId, CancellationToken ct)
    {
        var read = await reader.ReadAsync(customerId, observationId, ct);
        if (!read.IsSuccess) return read.Error!;
        var source = read.Value;
        if (source.Status != "READY") return new AtlasObservationTaskPreview(customerId, source.Status);
        var existing = await activities.FindSourceTaskAsync(source.Source, customerId, ct);
        if (!existing.IsSuccess) return existing.Error!;
        return Preview(customerId, source, existing.Value);
    }

    public async Task<Result<AtlasObservationTaskOutcome>> CreateAsync(Guid customerId, string observationId,
        AtlasObservationTaskRequest input, CancellationToken ct)
    {
        if (user.UserId is null || !user.HasPermission(Permissions.ActivitiesWrite)
            || !user.HasPermission(Permissions.ActivitiesRead) || !user.HasPermission(Permissions.ParasolAtlasRead))
            return Error.Forbidden("PARASOL_TASK_FORBIDDEN", "Technical workspace and CRM activity write access are required.");
        if (input is null || input.AssigneeId == Guid.Empty || input.DueAt is { Year: < 2000 or > 2100 }
            || input.ExpectedSha256 is not { Length: 64 } || !input.ExpectedSha256.All(c => char.IsAsciiHexDigit(c) && !char.IsAsciiLetterUpper(c)))
            return Error.Validation("PARASOL_TASK_INVALID", "Confirm the source review, active employee and due date.");
        var read = await reader.ReadAsync(customerId, observationId, ct);
        if (!read.IsSuccess) return read.Error!;
        var source = read.Value;
        if (source.Status != "READY") return SourceUnavailable();
        return await guard.WithCurrentAsync(source.Identity!, async token =>
        {
            var existing = await activities.FindSourceTaskAsync(source.Source, customerId, token);
            if (!existing.IsSuccess) return Result<AtlasObservationTaskOutcome>.Failure(existing.Error!);
            // First successful writer owns assignment/due date forever; replay never changes a completed or deleted task.
            if (existing.Value is { } known) return Result<AtlasObservationTaskOutcome>.Success(new(customerId, "EXISTING", known));
            if (source.Sha256 != input.ExpectedSha256)
                return Result<AtlasObservationTaskOutcome>.Failure(Error.Conflict("PARASOL_TASK_SOURCE_CHANGED", "The observation changed. Review it again before assigning work."));
            if (!source.IsActive)
                return Result<AtlasObservationTaskOutcome>.Failure(Error.Conflict("PARASOL_TASK_SOURCE_TERMINAL", "This observation is no longer active. Review its existing work instead."));
            var task = await activities.CreateTaskOnceAsync(new(source.Source, customerId, input.AssigneeId, input.DueAt,
                source.Observation!.Severity is "HIGH" or "CRITICAL" ? ActivityPriority.High : ActivityPriority.Normal), token);
            return task.IsSuccess ? Result<AtlasObservationTaskOutcome>.Success(new(customerId, task.Value.Created ? "CREATED" : "EXISTING", task.Value))
                : Result<AtlasObservationTaskOutcome>.Failure(task.Error!);
        }, ct);
    }

    public async Task<Result<AtlasObservationTaskPreview>> SourceAsync(Guid activityId, CancellationToken ct)
    {
        var details = await activities.GetSourceTaskAsync(activityId, ct);
        if (!details.IsSuccess) return details.Error!;
        var task = details.Value.Task;
        if (!task.IsAvailable) return new AtlasObservationTaskPreview(task.OrganizationId, "SOURCE_TASK_UNAVAILABLE", Task: task);
        var identity = await identities.GetAsync(task.OrganizationId, ct);
        if (!identity.IsSuccess) return identity.Error!;
        if (identity.Value.Atlas is not { } mapped || mapped.WorkspaceId != details.Value.Source.WorkspaceId || mapped.ClientId != details.Value.Source.ClientId)
            return new AtlasObservationTaskPreview(task.OrganizationId, "IDENTITY_CHANGED");
        var read = await reader.ReadAsync(task.OrganizationId, details.Value.Source.ObservationId, ct);
        if (!read.IsSuccess) return read.Error!;
        var source = read.Value;
        if (source.Status != "READY") return new AtlasObservationTaskPreview(task.OrganizationId, source.Status);
        // A rebind between the initial receipt check and the personal read must not expose a new tenant's similarly named row.
        if (source.Source != details.Value.Source || source.Identity!.LinkId != identity.Value.LinkId)
            return new AtlasObservationTaskPreview(task.OrganizationId, "IDENTITY_CHANGED");
        var current = await activities.FindSourceTaskAsync(source.Source, task.OrganizationId, ct);
        if (!current.IsSuccess) return current.Error!;
        if (current.Value is not { IsAvailable: true } refreshed)
            return new AtlasObservationTaskPreview(task.OrganizationId, "SOURCE_TASK_UNAVAILABLE", Task: current.Value);
        return Preview(task.OrganizationId, source, refreshed) with { CanCreate = false };
    }

    private AtlasObservationTaskPreview Preview(Guid id, AtlasObservationSource source, SourceTaskRef? task) =>
        new(id, "READY", source.Observation, source.Devices, source.Sha256, task,
            source.IsActive && task is null && user.HasPermission(Permissions.ActivitiesWrite), source.Mode);
    private static Error SourceUnavailable() => Error.Conflict("PARASOL_TASK_SOURCE_UNAVAILABLE", "The observation could not be verified. Refresh and review the source again.");
}
