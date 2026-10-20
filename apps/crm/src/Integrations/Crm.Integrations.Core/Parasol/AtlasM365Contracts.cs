namespace Crm.Integrations.Core.Parasol;

public sealed record AtlasM365View(Guid CustomerId, string Status, AtlasM365Summary? Summary = null);
public sealed record AtlasM365Summary(DateTimeOffset AssessedAt, DateTimeOffset WindowFrom, DateTimeOffset WindowTo,
    int TotalConnections, bool Truncated, IReadOnlyList<AtlasM365Connection> Connections);
public sealed record AtlasM365Connection(string ConnectionId, IReadOnlyList<AtlasM365Directory> Directory, AtlasM365SignIns SignIns);
public sealed record AtlasM365Directory(string ResourceType, string Status, int? Count, DateTimeOffset? AsOf, DateTimeOffset? LastSuccessAt);
public sealed record AtlasM365SignIns(string Status, string Coverage, string Freshness, DateTimeOffset? AsOf,
    DateTimeOffset? LastSuccessAt, IReadOnlyList<AtlasM365Gap> Gaps);
public sealed record AtlasM365Gap(DateTimeOffset FromInclusive, DateTimeOffset ToExclusive);
