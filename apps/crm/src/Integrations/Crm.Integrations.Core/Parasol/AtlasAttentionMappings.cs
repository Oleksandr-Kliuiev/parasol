using System.Text.Json;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Only the intersection of the current personal source directory and current CRM mappings is eligible.</summary>
internal sealed class AtlasAttentionMappings(IntegrationDbContext db, ICustomersApi customers) : IAtlasAttentionMappings
{
    public Task<AtlasAttentionMappingSet> IntersectAsync(AtlasIdentitySnapshot snapshot, CancellationToken ct) =>
        ReadAsync(snapshot.WorkspaceId, snapshot.Clients.Select(client => client.ClientId).ToArray(), ct);

    public async Task<IReadOnlyDictionary<Guid, string>> CurrentAsync(IReadOnlyList<AtlasAttentionBinding> expected, CancellationToken ct)
    {
        if (expected.Count == 0) return new Dictionary<Guid, string>();
        var current = await ReadAsync(expected[0].WorkspaceId, expected.Select(binding => binding.ClientId).ToArray(), ct);
        return current.Bindings.Where(binding => expected.Any(old => old.CustomerId == binding.CustomerId
                && old.WorkspaceId == binding.WorkspaceId && old.ClientId == binding.ClientId && old.LinkId == binding.LinkId))
            .ToDictionary(binding => binding.CustomerId, binding => binding.CustomerName);
    }

    private async Task<AtlasAttentionMappingSet> ReadAsync(string workspace, string[] clients, CancellationToken ct)
    {
        if (clients.Length == 0) return new([], 0, 0);
        var identities = clients.ToDictionary(client => CustomerIdentityContract.ExternalId(workspace, client), StringComparer.Ordinal);
        var keys = identities.Keys.ToArray();
        var links = await db.ExternalLinks.AsNoTracking().Where(link => link.System == CustomerIdentityContract.System
            && link.ExternalType == CustomerIdentityContract.ExternalType && keys.Contains(link.ExternalId)).ToListAsync(ct);
        var references = await db.ExternalRecords.AsNoTracking().Where(record => record.System == CustomerIdentityContract.System
                && record.ExternalType == CustomerIdentityContract.ExternalType && keys.Contains(record.ExternalId))
            .Select(record => new { record.ExternalId, record.IsGone, Length = record.Payload.Length, Payload = record.Payload.Substring(0, 4096) }).ToListAsync(ct);
        var names = await customers.GetOrganizationNamesAsync(links.Where(link => link.EntityType == EntityTypes.Organization)
            .Select(link => link.EntityId).Distinct().ToArray(), ct);
        var bindings = new List<AtlasAttentionBinding>();
        foreach (var link in links)
        {
            // SQL may match a corrupted differently-cased hash under its collation; source identities stay ordinal.
            if (!identities.TryGetValue(link.ExternalId, out var client)) continue;
            var record = references.SingleOrDefault(row => row.ExternalId == link.ExternalId);
            if (link.EntityType != EntityTypes.Organization || record is null || record.IsGone || record.Length > 4096
                || !names.TryGetValue(link.EntityId, out var name) || string.IsNullOrWhiteSpace(name) || name.Length > 256
                || !Matches(record.Payload, workspace, client)) continue;
            bindings.Add(new(link.EntityId, name, workspace, client, link.Id));
        }
        return new(bindings.OrderBy(binding => binding.CustomerName, StringComparer.OrdinalIgnoreCase).ThenBy(binding => binding.CustomerId).ToArray(),
            clients.Length - links.Count, links.Count - bindings.Count);
    }

    private static bool Matches(string payload, string workspace, string client)
    {
        try
        {
            using var json = JsonDocument.Parse(payload, new() { MaxDepth = 4 });
            var root = json.RootElement;
            return root.ValueKind == JsonValueKind.Object && root.EnumerateObject().Count() == 2
                && root.TryGetProperty("workspaceId", out var ws) && ws.ValueKind == JsonValueKind.String && ws.GetString() == workspace
                && root.TryGetProperty("clientId", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() == client;
        }
        catch (JsonException) { return false; }
    }
}
