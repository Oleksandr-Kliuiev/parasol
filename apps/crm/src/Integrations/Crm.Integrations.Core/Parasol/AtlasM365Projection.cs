using System.Text.Json;
using System.Text.RegularExpressions;
using static Crm.Integrations.Core.Parasol.AtlasProjectionJson;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Closed, bounded metadata contract. No directory DTOs, vendor IDs, errors or sign-in rows are copied.</summary>
internal static class AtlasM365Projection
{
    internal static AtlasM365Summary Read(JsonElement root, AtlasCustomerReference expected)
    {
        Fields(root, "contractVersion", "mode", "workspaceId", "clientId", "assessedAt", "window", "totalConnections", "truncated", "connections");
        Scope(root, expected);
        Require(Text(root, "contractVersion") == "atlas.m365-overview.v1" && Text(root, "mode") == "db");
        var assessed = RequiredDate(root, "assessedAt");
        var window = root.GetProperty("window"); Fields(window, "fromInclusive", "toExclusive");
        var from = RequiredDate(window, "fromInclusive"); var to = RequiredDate(window, "toExclusive");
        Require(to - from == TimeSpan.FromHours(24) && to.Ticks % TimeSpan.TicksPerHour == 0
            && assessed >= to && assessed - to < TimeSpan.FromHours(1));
        var total = Count(root.GetProperty("totalConnections")); var truncated = root.GetProperty("truncated").GetBoolean();
        var connections = new List<AtlasM365Connection>(); var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var connection in Array(root, "connections", 8))
        {
            Fields(connection, "connectionId", "directory", "signIns");
            var id = Text(connection, "connectionId", 128);
            Require(Regex.IsMatch(id, @"\A[A-Za-z0-9._:-]+\z", RegexOptions.CultureInvariant) && ids.Add(id));
            var directory = new List<AtlasM365Directory>(); var resources = new HashSet<string>(StringComparer.Ordinal);
            foreach (var row in Array(connection, "directory", 2))
            {
                Fields(row, "resourceType", "status", "count", "asOf", "lastSuccessAt");
                var type = Choice(row, "resourceType", ["m365_user", "m365_device"]); Require(resources.Add(type));
                var status = Choice(row, "status", ["OK", "STALE", "MISSING", "ERROR"]);
                var count = row.GetProperty("count").ValueKind == JsonValueKind.Null ? (int?)null : Count(row.GetProperty("count"));
                var asOf = ReadDate(row, "asOf", assessed); var success = ReadDate(row, "lastSuccessAt", assessed);
                Require(status is "OK" or "STALE" ? count is >= 0 and <= 20_000 && asOf is not null : count is null && asOf is null);
                directory.Add(new(type, status, count, asOf, success));
            }
            Require(directory.Count == 2);
            connections.Add(new(id, directory, SignIns(connection.GetProperty("signIns"), from, to, assessed)));
        }
        Require(connections.Count == Math.Min(total, 8) && truncated == (total > connections.Count));
        return new(assessed, from, to, total, truncated, connections);
    }

    private static AtlasM365SignIns SignIns(JsonElement row, DateTimeOffset from, DateTimeOffset to, DateTimeOffset assessed)
    {
        Fields(row, "status", "coverage", "freshness", "asOf", "lastSuccessAt", "gaps");
        var status = Choice(row, "status", ["OK", "STALE", "MISSING", "ERROR"]);
        var coverage = Choice(row, "coverage", ["COMPLETE", "PARTIAL", "UNAVAILABLE"]);
        var freshness = Choice(row, "freshness", ["FRESH", "STALE", "MIXED", "UNKNOWN"]);
        var asOf = ReadDate(row, "asOf", assessed); var success = ReadDate(row, "lastSuccessAt", assessed);
        var gaps = new List<AtlasM365Gap>(); var end = from; var missingTicks = 0L;
        foreach (var gap in Array(row, "gaps", 64))
        {
            Fields(gap, "fromInclusive", "toExclusive");
            var start = RequiredDate(gap, "fromInclusive"); var finish = RequiredDate(gap, "toExclusive");
            Require(start >= end && finish > start && finish <= to);
            missingTicks += (finish - start).Ticks; end = finish; gaps.Add(new(start, finish));
        }
        Require(coverage switch
        {
            "COMPLETE" => gaps.Count == 0,
            "PARTIAL" => missingTicks > 0 && missingTicks < (to - from).Ticks,
            _ => missingTicks == (to - from).Ticks,
        });
        if (coverage == "UNAVAILABLE") Require(status is "MISSING" or "ERROR" && freshness == "UNKNOWN" && asOf is null && success is null);
        else Require((freshness == "FRESH" ? status == "OK" : freshness is "STALE" or "MIXED" && status == "STALE")
            && asOf is not null && success is not null && success >= asOf);
        return new(status, coverage, freshness, asOf, success, gaps);
    }

    private static DateTimeOffset RequiredDate(JsonElement row, string key) => ReadDate(row, key, null) ?? throw new JsonException();
    private static DateTimeOffset? ReadDate(JsonElement row, string key, DateTimeOffset? maximum)
    {
        var value = Date(row, key);
        Require(value is null || value.Value.Offset == TimeSpan.Zero && (maximum is null || value.Value <= maximum));
        return value;
    }

    private static void Fields(JsonElement row, params string[] names)
    {
        Object(row);
        Require(row.EnumerateObject().Count() == names.Length && row.EnumerateObject().All(p => names.Contains(p.Name, StringComparer.Ordinal)));
    }
}
