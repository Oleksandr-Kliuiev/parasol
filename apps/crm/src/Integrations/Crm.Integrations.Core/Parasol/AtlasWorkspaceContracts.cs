namespace Crm.Integrations.Core.Parasol;

public sealed record AtlasWorkspaceView(Guid CustomerId, string Status, AtlasWorkspaceSummary? Summary = null);
public sealed record AtlasWorkspaceSummary(string Mode, DateTimeOffset GeneratedAt, string Completeness,
    int KnownDevices, int KnownPeople, int ActiveObservations, IReadOnlyDictionary<string, int> SeverityCounts,
    IReadOnlyList<AtlasResourceSummary> Resources, IReadOnlyList<AtlasDeviceView> Devices, AtlasObservationList ObservationPage);
public sealed record AtlasResourceSummary(string Source, string ResourceType, string Status, DateTimeOffset? AsOf,
    DateTimeOffset? LastSuccessAt, int? ReturnedItems, bool Truncated);
public sealed record AtlasDeviceView(string Id, string Hostname, IReadOnlyList<string> Sources);
public sealed record AtlasObservationList(IReadOnlyList<AtlasObservationView> Items, bool Truncated);
public sealed record AtlasObservationView(string Id, string Summary, string Source, string ResourceType, string Kind,
    string Domain, string Severity, string Priority, string Route, string Status, DateTimeOffset OccurredAt,
    DateTimeOffset UpdatedAt, string DeviceStatus, string? DeviceId);
