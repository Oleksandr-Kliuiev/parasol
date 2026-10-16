using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.SharedKernel.Application;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

internal static class LocalReadinessTestSupport
{
    internal static readonly Guid Employee = Guid.Parse("11111111-1111-4111-8111-111111111111");
    internal sealed class User(Guid? id = null, params string[] permissions) : ICurrentUser
    {
        public Guid? UserId => id;
        public bool IsAuthenticated => id is not null;
        public string DisplayName => "Synthetic employee";
        public bool HasPermission(string permission) => permissions.Contains(permission, StringComparer.Ordinal);
    }
    internal sealed class Flags : ILocalReadinessFlags
    {
        internal int Calls;
        public LocalReadinessFlags Read() { Calls++; return new("DEVELOPMENT", false, true, true, false, false, true, false, true, true); }
    }
    internal sealed class Stored : ILocalReadinessStoredState
    {
        internal int Calls;
        internal Func<CancellationToken, Task<LocalStoredState>> Reply = _ => Task.FromResult(new LocalStoredState(
            new(false, null, 0, 0, 0, 0), new(true, AtlasAttentionTestSupport.Now, 5, 2, 1, 1), new(null, null)));
        public Task<LocalStoredState> ReadAsync(CancellationToken ct) { Calls++; return Reply(ct); }
    }
    internal sealed class Mappings : ILocalReadinessMappings
    {
        internal int Calls;
        internal Func<CancellationToken, Task<AtlasMappingDiagnostic>> Reply = _ => Task.FromResult(new AtlasMappingDiagnostic(
            "CHECKED", "NO_LOCAL_ISSUES_FOUND", "STORED_LOCAL_REGISTRY", 500, new(0, 0, 0, 0), new(0, 0, 0, 0, 0, 0)));
        public Task<AtlasMappingDiagnostic> ReadAsync(CancellationToken ct) { Calls++; return Reply(ct); }
    }
    internal sealed class Source(LocalMappingSnapshot snapshot) : ILocalMappingSource
    {
        internal int Calls;
        internal Func<int, CancellationToken, Task<LocalMappingSnapshot>> Reply = (_, _) => Task.FromResult(snapshot);
        public Task<LocalMappingSnapshot> ReadAsync(CancellationToken ct) { Calls++; return Reply(Calls, ct); }
    }
    internal static LocalReadinessReader Reader(User user, Stored? stored = null, Mappings? mappings = null, Flags? flags = null,
        AtlasWorkspaceOptions? atlas = null, TimeProvider? time = null) => new(user, Options.Create(atlas ?? new()), flags ?? new(),
            stored ?? new(), mappings ?? new(), time ?? TimeProvider.System);

    internal static LocalMappingSnapshot Snapshot(int count = 1, int omitted = 0)
    {
        var links = new List<LocalMappingLink>(); var references = new List<LocalMappingReference>();
        for (var index = 0; index < count; index++)
        {
            var id = Guid.Parse($"00000000-0000-4000-8000-{index + 1:000000000000}");
            var reference = new AtlasCustomerReference("synthetic-workspace", "client-" + index);
            var key = CustomerIdentityContract.ExternalId(reference.WorkspaceId, reference.ClientId);
            var payload = JsonSerializer.Serialize(reference, CustomerIdentityContract.JsonOptions);
            links.Add(new(id, "Atlas", "Client", key, "Organization", id, 1, 1));
            references.Add(new(id, "Atlas", "Client", key, false, payload.Length * 2, payload));
        }
        return new(count + omitted, 0, links, references, links.Select(link => link.EntityId).ToArray());
    }
}
