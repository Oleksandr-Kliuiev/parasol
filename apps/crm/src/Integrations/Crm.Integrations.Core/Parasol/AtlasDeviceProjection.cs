using System.Text.Json;
using static Crm.Integrations.Core.Parasol.AtlasProjectionJson;

namespace Crm.Integrations.Core.Parasol;

internal static class AtlasDeviceProjection
{
    internal static IReadOnlyList<AtlasDeviceView> Read(JsonElement root, AtlasCustomerReference expected)
    {
        var kinds = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var person in Array(root, "people", 1000))
        {
            Scope(person, expected);
            Require(kinds.TryAdd(Text(person, "id"), "PERSON"));
        }
        var devices = new List<(string Id, string Hostname)>();
        var sources = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var device in Array(root, "devices", 1000))
        {
            Scope(device, expected);
            var id = Text(device, "id");
            Require(kinds.TryAdd(id, "DEVICE"));
            devices.Add((id, Text(device, "hostname")));
            sources.Add(id, new(StringComparer.Ordinal));
        }
        foreach (var link in Array(root, "links", 1000))
        {
            Scope(link, expected);
            Require(Text(link, "status") == "CONFIRMED");
            var kind = Choice(link, "entityKind", ["PERSON", "DEVICE"]);
            var id = Text(link, "entityId");
            Require(kinds.TryGetValue(id, out var actualKind) && actualKind == kind);
            var source = Choice(link, "system", Sources);
            var type = Choice(link, "resourceType", ResourceTypes);
            // Only an explicit confirmed agent link attributes a device to a source. Hostnames never establish identity.
            if (kind == "DEVICE" && type == "agent") sources[id].Add(source);
        }
        return devices.OrderBy(d => d.Hostname, StringComparer.OrdinalIgnoreCase).ThenBy(d => d.Id, StringComparer.Ordinal)
            .Select(d => new AtlasDeviceView(d.Id, d.Hostname, sources[d.Id].Order(StringComparer.Ordinal).ToArray())).ToArray();
    }
}
