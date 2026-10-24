namespace Crm.Integrations.Core.Parasol;

public sealed record AtlasAttentionView(string Status, DateTimeOffset CheckedAt, AtlasAttentionCoverage? Coverage = null,
    AtlasAttentionTotals? Totals = null, IReadOnlyList<AtlasAttentionCustomer>? Customers = null);
public sealed record AtlasAttentionCoverage(int VisibleClients, int MatchedCustomers, int SelectedCustomers, int AttemptedCustomers,
    int ReadyCustomers, int FailedCustomers, int OmittedCustomers, int UnmappedClients, int MappingIssues, bool LimitReached, bool TimedOut);
public sealed record AtlasAttentionTotals(long ActiveObservations, long High, long Critical);
/// <summary>
/// <paramref name="Tasks"/> are the CRM tasks the preview rows already have (UX 2026 В3): null when they were not read (no
/// activities access, or the read failed or ran out of time), so a row then says nothing about work instead of "none".
/// </summary>
public sealed record AtlasAttentionCustomer(Guid CustomerId, string CustomerName, string Status, string? Mode,
    DateTimeOffset? GeneratedAt, DateTimeOffset? RetrievedAt, string? Completeness, int? ActiveObservations, int? High, int? Critical,
    IReadOnlyList<AtlasResourceSummary>? Resources, IReadOnlyList<AtlasObservationView> Preview, IReadOnlyList<AtlasDeviceView> Devices,
    IReadOnlyList<AtlasObservationTaskLink>? Tasks = null);

internal sealed record AtlasAttentionBinding(Guid CustomerId, string CustomerName, string WorkspaceId, string ClientId, Guid LinkId)
{
    internal CustomerIdentityView Identity => new(CustomerId, new(WorkspaceId, ClientId), LinkId);
}
internal sealed record AtlasAttentionDirectoryResult(string Status, AtlasIdentitySnapshot? Snapshot = null);
internal sealed record AtlasAttentionMappingSet(IReadOnlyList<AtlasAttentionBinding> Bindings, int UnmappedClients, int MappingIssues);
internal interface IAtlasAttentionDirectory
{
    Task<AtlasAttentionDirectoryResult> ReadAsync(CancellationToken ct);
}
internal interface IAtlasAttentionMappings
{
    Task<AtlasAttentionMappingSet> IntersectAsync(AtlasIdentitySnapshot snapshot, CancellationToken ct);
    Task<IReadOnlyDictionary<Guid, string>> CurrentAsync(IReadOnlyList<AtlasAttentionBinding> expected, CancellationToken ct);
}
internal interface IAtlasAttentionWorkspaces
{
    Task<AtlasWorkspaceView> ReadAsync(AtlasAttentionBinding binding, CancellationToken ct);
}
internal interface IAtlasAttentionTasks
{
    /// <summary>The tasks of the preview rows per customer in one local read, or null when they may not or could not be read.</summary>
    Task<IReadOnlyDictionary<Guid, IReadOnlyList<AtlasObservationTaskLink>>?> ReadAsync(
        IReadOnlyList<(AtlasAttentionBinding Binding, IReadOnlyList<string> ObservationIds)> previews, CancellationToken ct);
}
