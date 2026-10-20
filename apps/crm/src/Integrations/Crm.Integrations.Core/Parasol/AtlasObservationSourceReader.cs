using System.Text.Json;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Fresh personal read of one exact observation, including records outside the overview's first page.</summary>
public sealed class AtlasObservationSourceReader(CustomerIdentityService identities, ICurrentUser user,
    IOptions<AtlasWorkspaceOptions> options, AtlasReadClient atlas)
{
    internal async Task<Result<AtlasObservationSource>> ReadAsync(Guid customerId, string observationId, CancellationToken ct)
    {
        if (user.UserId is not { } employeeId || !user.HasPermission(Permissions.ParasolAtlasRead)
            || !user.HasPermission(Permissions.ActivitiesRead))
            return Error.Forbidden("PARASOL_TASK_FORBIDDEN", "Technical workspace and CRM activity access are required.");
        if (!AtlasObservationSource.ValidId(observationId))
            return Error.Validation("PARASOL_TASK_OBSERVATION_INVALID", "Choose a supported observation identifier.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            var identity = await identities.GetAsync(customerId, timeout.Token);
            if (!identity.IsSuccess) return identity.Error!;
            var reference = identity.Value.Atlas;
            if (reference is null) return new AtlasObservationSource("NOT_LINKED");
            var config = options.Value;
            if (!config.Enabled) return new AtlasObservationSource("NOT_CONFIGURED");
            if (!config.Employees.TryGetValue(employeeId.ToString("D"), out var credential) || credential.WorkspaceId != reference.WorkspaceId)
                return new AtlasObservationSource("ACCESS_DENIED");
            using var overview = await atlas.OverviewAsync(reference.ClientId, credential, timeout.Token);
            if (overview.Document is null) return new AtlasObservationSource(overview.Status);
            var summary = AtlasWorkspaceProjection.Read(overview.Document.RootElement, reference);
            using var response = await atlas.ObservationAsync(reference.ClientId, observationId, credential, timeout.Token);
            if (response.Document is null) return new AtlasObservationSource(response.Status);
            using var single = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(new { items = new[] { response.Document.RootElement } }));
            var observation = AtlasObservationProjection.ReadItems(single.RootElement, reference, summary.Devices, 1,
                ["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"]).Single();
            if (observation.Id != observationId) return new AtlasObservationSource("INVALID_RESPONSE");
            var current = await identities.GetAsync(customerId, timeout.Token);
            if (!current.IsSuccess) return current.Error!;
            if (current.Value.Atlas != reference || current.Value.LinkId != identity.Value.LinkId)
                return new AtlasObservationSource("IDENTITY_CHANGED");
            return new AtlasObservationSource("READY", identity.Value, observation, summary.Devices, summary.Mode, employeeId);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new AtlasObservationSource("UNAVAILABLE"); }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            return new AtlasObservationSource("INVALID_RESPONSE");
        }
    }
}
