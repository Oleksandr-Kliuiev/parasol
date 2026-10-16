using System.Text.Json;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

public sealed class AtlasObservationQueueReader(CustomerIdentityService identities, ICurrentUser user,
    IOptions<AtlasWorkspaceOptions> options, AtlasReadClient atlas, AtlasObservationCursor cursors, TimeProvider time)
{
    public async Task<Result<AtlasObservationQueueView>> ReadAsync(Guid customerId, AtlasObservationSelection selection,
        string? cursor, CancellationToken ct)
    {
        if (user.UserId is not { } employeeId || !user.HasPermission(Permissions.ParasolAtlasRead))
            return Error.Forbidden("PARASOL_ATLAS_FORBIDDEN", "Technical workspace access is required.");
        if (!selection.IsValid) return Error.Validation("PARASOL_ATLAS_QUEUE_FILTER_INVALID", "Choose a supported severity and status.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            var identity = await identities.GetAsync(customerId, timeout.Token);
            if (!identity.IsSuccess) return identity.Error!;
            var reference = identity.Value.Atlas;
            if (reference is null) return new AtlasObservationQueueView(customerId, "NOT_LINKED");
            string? atlasCursor = null;
            if (cursor is not null && !cursors.TryRead(cursor, employeeId, identity.Value, selection, out atlasCursor, out var identityChanged))
                return new AtlasObservationQueueView(customerId, identityChanged ? "IDENTITY_CHANGED" : "INVALID_CURSOR");
            var config = options.Value;
            if (!config.Enabled) return new AtlasObservationQueueView(customerId, "NOT_CONFIGURED");
            if (!config.Employees.TryGetValue(employeeId.ToString("D"), out var credential) || credential.WorkspaceId != reference.WorkspaceId)
                return new AtlasObservationQueueView(customerId, "ACCESS_DENIED");

            using var overview = await atlas.OverviewAsync(reference.ClientId, credential, timeout.Token);
            if (overview.Document is null) return new AtlasObservationQueueView(customerId, overview.Status);
            var summary = AtlasWorkspaceProjection.Read(overview.Document.RootElement, reference);
            if (summary.Mode == "fixture") return new AtlasObservationQueueView(customerId, "QUEUE_NOT_SUPPORTED");
            using var response = await atlas.ObservationsAsync(reference.ClientId, credential, selection, atlasCursor, timeout.Token);
            if (response.Document is null) return new AtlasObservationQueueView(customerId, response.Status);
            var page = AtlasObservationQueueProjection.Read(response.Document.RootElement, reference, selection, summary.Devices, atlasCursor);
            var current = await identities.GetAsync(customerId, timeout.Token);
            if (!current.IsSuccess) return current.Error!;
            if (current.Value.Atlas != reference || current.Value.LinkId != identity.Value.LinkId)
                return new AtlasObservationQueueView(customerId, "IDENTITY_CHANGED");
            var nextCursor = page.NextCursor is null ? null : cursors.Protect(employeeId, identity.Value, selection, page.NextCursor);
            return new AtlasObservationQueueView(customerId, "READY", new(summary.Mode, summary.GeneratedAt, time.GetUtcNow(),
                selection.Severity.ToString(), selection.Status.ToString(), page.Total, page.SeverityCounts,
                page.Items, summary.Devices, summary.Resources, nextCursor));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new AtlasObservationQueueView(customerId, "UNAVAILABLE"); }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            return new AtlasObservationQueueView(customerId, "INVALID_RESPONSE");
        }
    }
}
