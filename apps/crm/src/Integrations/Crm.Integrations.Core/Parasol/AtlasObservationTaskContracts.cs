using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.Activities.Contracts;

namespace Crm.Integrations.Core.Parasol;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AtlasObservationTaskRequest(Guid AssigneeId, DateTimeOffset? DueAt, string ExpectedSha256);

public sealed record AtlasObservationTaskPreview(Guid CustomerId, string Status, AtlasObservationView? Observation = null,
    IReadOnlyList<AtlasDeviceView>? Devices = null, string? Sha256 = null, SourceTaskRef? Task = null,
    bool CanCreate = false, string? Mode = null);
public sealed record AtlasObservationTaskOutcome(Guid CustomerId, string Status, SourceTaskRef Task);

internal sealed record AtlasObservationSource(string Status, CustomerIdentityView? Identity = null,
    AtlasObservationView? Observation = null, IReadOnlyList<AtlasDeviceView>? Devices = null, string? Mode = null, Guid? EmployeeId = null)
{
    internal SourceTaskIdentity Source => new("Atlas", Identity!.Atlas!.WorkspaceId, Identity.Atlas.ClientId, Observation!.Id, "Task");
    internal bool IsActive => Observation?.Status is "OPEN" or "ACKNOWLEDGED";

    // Stable review fingerprint. Never persisted or exposed with raw source identity/credentials.
    // Device context matters to the review; unrelated devices and moving page boundaries do not.
    internal string Sha256 => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
    {
        Version = "AtlasObservationTaskV1", EmployeeId, Identity!.CustomerId, Identity.LinkId, Identity.Atlas,
        Observation, Mode, Device = Devices!.SingleOrDefault(d => d.Id == Observation!.DeviceId),
    }, CustomerIdentityContract.JsonOptions))).ToLowerInvariant();

    internal static bool ValidId(string? id) => id is { Length: > 0 and <= 100 } && id is not ("." or "..")
        && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or ':');
}
